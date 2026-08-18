import type { WorkspaceFile } from "./commonswarm.js";

export interface DisplayFile extends WorkspaceFile {
  uploaderName: string;
}

export interface FileListTargets {
  list: HTMLUListElement;
  empty: HTMLElement;
  warning: HTMLElement;
}

export interface FileListOptions {
  contentWarning: string;
  download: (file: DisplayFile) => Promise<void>;
  now?: number;
}

/** Keeps workspace file sizes short enough to scan beside names and authors. */
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "Size unavailable";
  if (bytes < 1_000) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1_000;
  let unit = units[0]!;
  for (const next of units.slice(1)) {
    if (value < 1_000) break;
    value /= 1_000;
    unit = next;
  }
  const digits = value >= 10 ? 0 : 1;
  return `${value.toFixed(digits).replace(/\.0$/, "")} ${unit}`;
}

/** Formats one committed timestamp as a short age, with an exact tooltip. */
export function formatFileAge(
  value: string,
  now = Date.now(),
): { relative: string; absolute: string } {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return { relative: "Age unavailable", absolute: "" };
  const seconds = Math.round((date.getTime() - now) / 1_000);
  const ranges: Array<[number, Intl.RelativeTimeFormatUnit]> = [
    [60, "second"],
    [60, "minute"],
    [24, "hour"],
    [7, "day"],
    [4.345, "week"],
    [12, "month"],
    [Number.POSITIVE_INFINITY, "year"],
  ];
  let amount = seconds;
  let unit: Intl.RelativeTimeFormatUnit = "second";
  for (const [range, next] of ranges) {
    unit = next;
    if (Math.abs(amount) < range) break;
    amount /= range;
  }
  return {
    relative: new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(
      Math.round(amount),
      unit,
    ),
    absolute: new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(date),
  };
}

function restoreDeadline(tombstonedAt: string): { label: string; iso: string } | null {
  const date = new Date(tombstonedAt);
  if (Number.isNaN(date.getTime())) return null;
  date.setUTCDate(date.getUTCDate() + 30);
  return {
    label: new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date),
    iso: date.toISOString(),
  };
}

/** Renders the live file rows with DOM text nodes so workspace names cannot become markup. */
export function renderFileList(
  targets: FileListTargets,
  files: DisplayFile[],
  options: FileListOptions,
): void {
  targets.list.replaceChildren();
  const hasFiles = files.length > 0;
  targets.list.hidden = !hasFiles;
  targets.empty.hidden = hasFiles;
  targets.warning.hidden = !hasFiles;
  targets.empty.textContent = hasFiles ? "" : "No files shared yet.";
  targets.warning.textContent = hasFiles ? options.contentWarning : "";

  for (const file of files) {
    const item = document.createElement("li");
    item.className = "dashboard__file-row";
    if (file.tombstonedAt !== null) item.classList.add("dashboard__file-row--removed");

    const identity = document.createElement("div");
    identity.className = "dashboard__file-identity";
    const name = document.createElement("strong");
    name.dataset.fileName = "";
    name.textContent = file.name;
    const state = document.createElement("span");
    state.className = "dashboard__file-state";
    if (file.tombstonedAt === null) {
      state.textContent = "Shared with this workspace";
    } else {
      const deadline = restoreDeadline(file.tombstonedAt);
      state.append("Removed");
      if (deadline) {
        state.append(" · restorable until ");
        const time = document.createElement("time");
        time.dateTime = deadline.iso;
        time.textContent = deadline.label;
        state.append(time);
      }
    }
    identity.append(name, state);

    const size = document.createElement("span");
    size.className = "dashboard__file-size";
    size.dataset.fileSize = "";
    size.dataset.fieldLabel = "Size";
    size.textContent = formatFileSize(file.sizeBytes);

    const version = document.createElement("span");
    version.className = "dashboard__file-version";
    version.dataset.fileVersion = "";
    version.dataset.fieldLabel = "Version";
    version.textContent = `v${file.currentVersion}`;

    const uploader = document.createElement("span");
    uploader.className = "dashboard__file-uploader";
    uploader.dataset.fileUploader = "";
    uploader.dataset.fieldLabel = "Uploader";
    uploader.textContent = file.uploaderName;

    const ageValue = formatFileAge(file.committedAt, options.now);
    const age = document.createElement("time");
    age.className = "dashboard__file-age";
    age.dataset.fileAge = "";
    age.dataset.fieldLabel = "Age";
    age.dateTime = file.committedAt;
    age.textContent = ageValue.relative;
    if (ageValue.absolute) age.title = ageValue.absolute;

    const action = document.createElement("div");
    action.className = "dashboard__file-action";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "dashboard__button dashboard__button--secondary dashboard__file-download";
    button.textContent = "Download";
    button.disabled = file.tombstonedAt !== null;
    button.setAttribute("aria-label", `Download ${file.name}, version ${file.currentVersion}`);
    const status = document.createElement("span");
    status.className = "dashboard__file-download-status";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    button.addEventListener("click", async () => {
      button.disabled = true;
      button.textContent = "Preparing…";
      status.textContent = "";
      try {
        await options.download(file);
      } catch (error) {
        status.textContent = error instanceof Error ? error.message : "Download failed.";
      } finally {
        button.disabled = false;
        button.textContent = "Download";
      }
    });
    action.append(button, status);

    item.append(identity, size, version, uploader, age, action);
    targets.list.append(item);
  }
}
