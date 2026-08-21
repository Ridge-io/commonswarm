export interface WorkspaceSettingsOptions {
  name: string;
  workspaceId: string;
  memberCount: number;
  agentCount: number;
  canClose: boolean;
  onCopy(): Promise<void>;
  onClose(): Promise<void>;
}

export interface WorkspaceSettingsControls {
  confirmInput: HTMLInputElement;
  closeButton: HTMLButtonElement;
}

function countLabel(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

/** Renders the real workspace settings panel and owns its exact-name close gate. */
export function renderWorkspaceSettings(
  root: HTMLElement,
  options: WorkspaceSettingsOptions,
): WorkspaceSettingsControls {
  const document = root.ownerDocument;
  const heading = document.createElement("h2");
  heading.className = "dashboard__workspace-settings-title";
  heading.textContent = options.name;

  const counts = document.createElement("p");
  counts.className = "dashboard__workspace-settings-counts";
  counts.textContent = `${countLabel(options.memberCount, "person", "people")} · ${
    countLabel(options.agentCount, "agent", "agents")
  }`;

  const idLabel = document.createElement("p");
  idLabel.className = "dashboard__popover-label";
  idLabel.textContent = "Workspace ID";
  const id = document.createElement("code");
  id.className = "dashboard__workspace-id";
  id.dataset.channelId = "";
  id.textContent = options.workspaceId;
  const copy = document.createElement("button");
  copy.className = "dashboard__text-button";
  copy.type = "button";
  copy.dataset.copyWorkspaceId = "";
  copy.textContent = "Copy workspace ID";
  const copyStatus = document.createElement("span");
  copyStatus.className = "dashboard__copy-status";
  copyStatus.dataset.workspaceIdStatus = "";
  copyStatus.setAttribute("role", "status");
  copyStatus.setAttribute("aria-live", "polite");
  copy.addEventListener("click", async () => {
    try {
      await options.onCopy();
      copyStatus.textContent = "Copied";
    } catch {
      copyStatus.textContent = "Could not copy";
    }
  });

  const danger = document.createElement("section");
  danger.className = "dashboard__workspace-danger";
  danger.dataset.workspaceCloseSection = "";
  const dangerTitle = document.createElement("h3");
  dangerTitle.textContent = "Close workspace";
  const warning = document.createElement("p");
  warning.textContent =
    "This hides the workspace for everyone and frees its free-tier slot. Members lose access. Support can restore it.";
  const form = document.createElement("form");
  form.dataset.workspaceCloseForm = "";
  const label = document.createElement("label");
  label.textContent = `Type ${options.name} to confirm.`;
  const input = document.createElement("input");
  input.type = "text";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.dataset.workspaceCloseConfirm = "";
  input.setAttribute("aria-label", `Type ${options.name} to confirm workspace close`);
  const button = document.createElement("button");
  button.type = "submit";
  button.className = "dashboard__danger-button";
  button.dataset.workspaceCloseSubmit = "";
  button.textContent = "Close workspace";
  button.disabled = true;
  const status = document.createElement("p");
  status.className = "dashboard__form-error";
  status.dataset.workspaceCloseError = "";
  status.setAttribute("role", "alert");
  status.hidden = true;

  if (!options.canClose) {
    input.disabled = true;
    label.textContent = "Only a workspace owner can close this workspace.";
  }
  const syncGate = (): void => {
    button.disabled = !options.canClose || input.value !== options.name;
  };
  input.addEventListener("input", syncGate);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    syncGate();
    if (button.disabled) return;
    button.disabled = true;
    input.disabled = true;
    button.setAttribute("aria-busy", "true");
    button.textContent = "Closing workspace…";
    status.hidden = true;
    status.textContent = "";
    try {
      await options.onClose();
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : "Workspace close failed.";
      status.hidden = false;
      input.disabled = false;
      button.removeAttribute("aria-busy");
      button.textContent = "Close workspace";
      syncGate();
    }
  });

  label.append(input);
  form.append(label, button, status);
  danger.append(dangerTitle, warning, form);
  root.replaceChildren(heading, counts, idLabel, id, copy, copyStatus, danger);
  return { confirmInput: input, closeButton: button };
}
