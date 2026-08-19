import { commandEndpoint, type CloudTarget } from "./config.js";
import { newCommandId } from "./command-client.js";

/** Transport never returned a response; retrying is safe (nothing landed). */
export class FeedbackTransportError extends Error {
  override name = "FeedbackTransportError";
}

/** The deployment refused the submission; `code` is the server's stable code. */
export class FeedbackRefusedError extends Error {
  override name = "FeedbackRefusedError";
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export interface SubmitFeedbackResult {
  status: string;
  duplicate?: boolean;
  message?: string;
  [key: string]: unknown;
}

const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Product feedback from whoever is holding the credential — agents are the
 * primary authors by design (operator ruling 2026-08-19). Attribution is
 * server-derived; this client sends only the content.
 */
export async function submitFeedback(
  options: {
    target: CloudTarget;
    workspaceId: string;
    credential: string;
    fetcher?: typeof fetch;
  },
  request: {
    category: "bug" | "idea" | "friction";
    body: string;
    context?: Record<string, string> | null;
  },
): Promise<SubmitFeedbackResult> {
  const fetcher = options.fetcher ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetcher(commandEndpoint(options.target), {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.credential}`,
        apikey: options.target.anonKey,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        command_id: newCommandId(),
        client_version: "0.1.0",
        workspace_id: options.workspaceId,
        stream: { kind: "workspace" },
        command: {
          kind: "submit_feedback",
          feedback_id: crypto.randomUUID(),
          category: request.category,
          body: request.body,
          context: request.context ?? null,
        },
      }),
      signal: controller.signal,
    });
  } catch (error) {
    if ((error as Error).name === "AbortError") {
      throw new FeedbackTransportError("feedback submission timed out");
    }
    throw new FeedbackTransportError("feedback submission failed before a response");
  } finally {
    clearTimeout(timer);
  }
  const body = await response.json().catch(() => null) as
    | Record<string, unknown>
    | null;
  if (!response.ok) {
    const code = typeof body?.error === "string" ? body.error : "http_error";
    const message = typeof body?.message === "string"
      ? body.message
      : `feedback submission was refused (HTTP ${response.status})`;
    throw new FeedbackRefusedError(code, message);
  }
  if (body === null || typeof body.status !== "string") {
    throw new FeedbackTransportError("the deployment answered without a readable result");
  }
  return body as SubmitFeedbackResult;
}
