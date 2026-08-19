/**
 * The manage-dialog's inline model editor, extracted so the observer can drive
 * the REAL builder instead of hand-writing the markup it asserts on (the trap
 * the rail observers were refuted for). The model value is free text a
 * workspace member typed; it reaches the DOM only through element PROPERTIES
 * (input.value, textContent, setAttribute) — never through markup.
 */
export interface AgentModelEditorOptions {
  agentName: string;
  currentModel: string | null;
  onCancel: () => void;
  /** Receives the normalized value: trimmed, empty submitted as null (clear). */
  onSave: (model: string | null) => Promise<void> | void;
}

export function buildAgentModelEditor(
  doc: Document,
  options: AgentModelEditorOptions,
): HTMLFormElement {
  const editor = doc.createElement("form");
  editor.className = "dashboard__model-editor";
  editor.dataset.modelEditor = "";
  const input = doc.createElement("input");
  input.type = "text";
  input.maxLength = 120;
  input.value = options.currentModel ?? "";
  input.placeholder = "claude, gpt-5, gemini… empty clears";
  input.setAttribute("aria-label", `Model for ${options.agentName}`);
  const save = doc.createElement("button");
  save.type = "submit";
  save.className = "dashboard__text-button";
  save.textContent = "Save";
  const cancel = doc.createElement("button");
  cancel.type = "button";
  cancel.className = "dashboard__text-button";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => {
    options.onCancel();
  });
  editor.append(input, save, cancel);
  editor.addEventListener("submit", (submitEvent) => {
    submitEvent.preventDefault();
    const trimmed = input.value.trim();
    save.disabled = true;
    void (async () => {
      try {
        await options.onSave(trimmed === "" ? null : trimmed);
      } finally {
        save.disabled = false;
      }
    })();
  });
  return editor;
}
