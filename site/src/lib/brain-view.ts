import {
  brainTopicFromFileName,
} from "../../../src/cloud/brain.js";
import { formatFileAge } from "./file-list.js";
import { setSanitizedMessageMarkdown } from "./message-markdown.js";
import type { WorkspaceFile } from "./commonswarm.js";

export interface BrainTopic extends WorkspaceFile {
  topic: string;
  updaterName: string;
}

export interface BrainViewTargets {
  list: HTMLUListElement;
  empty: HTMLElement;
  detail: HTMLElement;
  title: HTMLElement;
  meta: HTMLElement;
  bodyMode: HTMLElement;
  markdown: HTMLElement;
  raw: HTMLElement;
  rawToggle: HTMLButtonElement;
  error: HTMLElement;
  edit: HTMLButtonElement;
  form: HTMLFormElement;
  textarea: HTMLTextAreaElement;
  save: HTMLButtonElement;
  cancel: HTMLButtonElement;
  status: HTMLElement;
  history: HTMLDetailsElement;
  historyList: HTMLUListElement;
}

export interface BrainViewOptions {
  read: (topic: BrainTopic, version: number) => Promise<string>;
  save: (topic: BrainTopic, markdown: string) => Promise<BrainTopic>;
  now?: number;
}

export interface BrainView {
  open(topic: string, version?: number): Promise<void>;
  setTopics(topics: BrainTopic[]): void;
}

/** The durable write completed, but its old workspace view no longer owns the screen. */
export class BrainSaveCompletedElsewhere extends Error {
  override name = "BrainSaveCompletedElsewhere";

  constructor(readonly topic: string, readonly version: number) {
    super(
      `Saved ${topic} as v${version}, but the workspace changed before this view could refresh.`,
    );
  }
}

/** Selects only live files in the reserved brain namespace. */
export function brainTopics(
  files: WorkspaceFile[],
  updaterName: (file: WorkspaceFile) => string,
): BrainTopic[] {
  return files
    .filter((file) => file.tombstonedAt === null)
    .flatMap((file) => {
      const topic = brainTopicFromFileName(file.name);
      return topic === null ? [] : [{ ...file, topic, updaterName: updaterName(file) }];
    })
    .sort((left, right) => left.topic.localeCompare(right.topic));
}

function versionLabel(count: number): string {
  return `${count} ${count === 1 ? "version" : "versions"}`;
}

/** Binds the plain list/read/edit brain surface to the existing file callbacks. */
export function createBrainView(
  targets: BrainViewTargets,
  options: BrainViewOptions,
): BrainView {
  let topics: BrainTopic[] = [];
  let activeTopic = "";
  /* The open pane binds to the FILE, not the slug. Two workspaces can hold the
   * same topic name; keying by slug alone kept workspace A's body across a
   * workspace switch and let Save publish it into workspace B's file (found by
   * the exact-review arm on a0b6734, reproduced in Chrome). */
  let activeFileId = "";
  let activeVersion = 0;
  let activeMarkdown = "";
  let requestVersion = 0;

  const setRawMode = (showRaw: boolean): void => {
    /* Keep the full source out of the DOM until a reader asks for it. The default
     * rendered view stays bounded even when the stored topic is large. */
    targets.raw.textContent = showRaw ? activeMarkdown : "";
    targets.rawToggle.setAttribute("aria-pressed", String(showRaw));
    targets.markdown.hidden = showRaw;
    targets.raw.hidden = !showRaw;
  };

  const setError = (message = ""): void => {
    targets.error.textContent = message;
    targets.error.hidden = message.length === 0;
  };

  const setStatus = (message = ""): void => {
    targets.status.textContent = message;
  };

  const renderHistory = (topic: BrainTopic): void => {
    targets.historyList.replaceChildren();
    for (let version = topic.currentVersion; version >= 1; version -= 1) {
      const item = document.createElement("li");
      const link = document.createElement("a");
      link.href = `#brain-${encodeURIComponent(topic.topic)}-v${version}`;
      link.dataset.brainVersion = String(version);
      link.textContent = `v${version}${version === topic.currentVersion ? " · latest" : ""}`;
      if (version === activeVersion) link.setAttribute("aria-current", "page");
      link.addEventListener("click", (event) => {
        event.preventDefault();
        void open(topic.topic, version);
      });
      item.append(link);
      targets.historyList.append(item);
    }
  };

  const renderList = (): void => {
    targets.list.replaceChildren();
    targets.empty.hidden = topics.length > 0;
    targets.list.hidden = topics.length === 0;
    targets.empty.textContent = topics.length === 0
      ? "No brain topics yet. Agents can add one with cswarm brain put <topic>."
      : "";
    for (const topic of topics) {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.brainTopic = topic.topic;
      if (topic.topic === activeTopic) button.setAttribute("aria-current", "page");
      const name = document.createElement("strong");
      name.textContent = topic.topic;
      const detail = document.createElement("span");
      const age = formatFileAge(topic.committedAt, options.now);
      detail.textContent = `${versionLabel(topic.currentVersion)} · ${age.relative} · ${topic.updaterName}`;
      button.append(name, detail);
      button.addEventListener("click", () => void open(topic.topic));
      item.append(button);
      targets.list.append(item);
    }
  };

  const open = async (topicName: string, version?: number): Promise<void> => {
    const topic = topics.find((candidate) => candidate.topic === topicName);
    if (!topic) return;
    const selectedVersion = version ?? topic.currentVersion;
    if (selectedVersion < 1 || selectedVersion > topic.currentVersion) return;
    const request = ++requestVersion;
    activeTopic = topic.topic;
    activeFileId = topic.fileId;
    activeVersion = selectedVersion;
    targets.detail.hidden = false;
    targets.title.textContent = topic.topic;
    targets.meta.textContent = "Loading topic…";
    targets.markdown.replaceChildren();
    targets.raw.textContent = "";
    targets.bodyMode.hidden = true;
    targets.rawToggle.disabled = true;
    setRawMode(false);
    targets.edit.hidden = true;
    targets.form.hidden = true;
    targets.history.open = false;
    setError();
    setStatus();
    renderList();
    try {
      const markdown = await options.read(topic, selectedVersion);
      if (request !== requestVersion) return;
      activeMarkdown = markdown;
      const age = formatFileAge(topic.committedAt, options.now);
      targets.meta.textContent =
        `${versionLabel(topic.currentVersion)} · updated ${age.relative} by ${topic.updaterName}` +
        (selectedVersion === topic.currentVersion ? "" : ` · viewing v${selectedVersion}`);
      setSanitizedMessageMarkdown(targets.markdown, markdown, { headingOffset: 1 });
      targets.bodyMode.hidden = false;
      targets.rawToggle.disabled = false;
      targets.edit.hidden = selectedVersion !== topic.currentVersion;
      renderHistory(topic);
    } catch (error) {
      if (request !== requestVersion) return;
      targets.meta.textContent = `${versionLabel(topic.currentVersion)} · ${topic.updaterName}`;
      setError(error instanceof Error ? error.message : "The topic could not be loaded.");
      renderHistory(topic);
    }
  };

  targets.rawToggle.addEventListener("click", () => {
    setRawMode(targets.rawToggle.getAttribute("aria-pressed") !== "true");
  });

  targets.edit.addEventListener("click", () => {
    targets.textarea.value = activeMarkdown;
    targets.form.hidden = false;
    targets.edit.hidden = true;
    setError();
    setStatus();
    targets.textarea.focus();
  });
  targets.cancel.addEventListener("click", () => {
    targets.form.hidden = true;
    targets.edit.hidden = activeVersion !== 0;
    targets.textarea.value = activeMarkdown;
    setError();
    setStatus();
  });
  targets.form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const topic = topics.find((candidate) => candidate.topic === activeTopic);
    /* Second line of the workspace-binding defense: even if a stale pane
     * survived, a save may only target the file the pane was opened on. */
    if (!topic || topic.fileId !== activeFileId) {
      setError("This topic changed underneath the editor. Reopen it, then save.");
      return;
    }
    const markdown = targets.textarea.value;
    if (markdown.trim().length === 0) {
      setError("A brain topic cannot be empty. Nothing was saved.");
      return;
    }
    targets.save.disabled = true;
    targets.save.textContent = "Saving…";
    setError();
    setStatus("Saving a new file version…");
    try {
      const saved = await options.save(topic, markdown);
      topics = topics
        .filter((candidate) => candidate.topic !== saved.topic)
        .concat(saved)
        .sort((left, right) => left.topic.localeCompare(right.topic));
      targets.form.hidden = true;
      setStatus(`Saved ${saved.topic} as v${saved.currentVersion}.`);
      renderList();
      await open(saved.topic, saved.currentVersion);
      setStatus(`Saved ${saved.topic} as v${saved.currentVersion}.`);
    } catch (error) {
      setError(error instanceof Error ? error.message : "The topic was not saved.");
      setStatus(
        error instanceof BrainSaveCompletedElsewhere
          ? "The new version is saved. Open that workspace to read it."
          : "Nothing was saved.",
      );
    } finally {
      targets.save.disabled = false;
      targets.save.textContent = "Save new version";
    }
  });

  return {
    open,
    setTopics(nextTopics) {
      requestVersion += 1;
      topics = [...nextTopics];
      renderList();
      const survivor = topics.find((topic) => topic.topic === activeTopic);
      if (activeTopic && (!survivor || survivor.fileId !== activeFileId)) {
        activeTopic = "";
        activeFileId = "";
        activeVersion = 0;
        activeMarkdown = "";
        targets.bodyMode.hidden = true;
        targets.markdown.replaceChildren();
        targets.raw.textContent = "";
        targets.rawToggle.disabled = true;
        setRawMode(false);
        targets.detail.hidden = true;
        targets.form.hidden = true;
      }
    },
  };
}
