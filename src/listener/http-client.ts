import {
  Agent as HttpAgent,
  request as httpRequest,
  type ClientRequest,
  type IncomingMessage,
} from "node:http";
import {
  Agent as HttpsAgent,
  request as httpsRequest,
} from "node:https";
import type { Socket } from "node:net";

/** A stopped listener leaves no idle Cloud socket past this fixed bound. */
export const LISTENER_HTTP_IDLE_TIMEOUT_MS = 60_000;

export interface ListenerHttpMetrics {
  requests: number;
  connectionsOpened: number;
  connectionReuseRatio: number;
}

export interface ListenerHttpClientOptions {
  idleTimeoutMs?: number;
}

type IdleTimer = ReturnType<typeof setTimeout>;

function responseHeaders(message: IncomingMessage): Headers {
  const headers = new Headers();
  for (let index = 0; index < message.rawHeaders.length; index += 2) {
    const name = message.rawHeaders[index];
    const value = message.rawHeaders[index + 1];
    if (name !== undefined && value !== undefined) headers.append(name, value);
  }
  return headers;
}

/**
 * Owns one bounded keep-alive pool for the lifetime of one listener process.
 *
 * Node's bundled fetch implementation does not expose its dispatcher without
 * the optional `undici` package. This native HTTP adapter is the platform
 * equivalent: one non-pipelined socket per origin, no transport retry, and an
 * explicit idle close. Callers still receive a standard Response and keep
 * their existing auth, deadline, parsing, and retry rules.
 */
export class ListenerHttpClient {
  readonly fetch: typeof fetch;

  private readonly httpAgent = new HttpAgent({
    keepAlive: true,
    maxSockets: 1,
    maxFreeSockets: 1,
    maxTotalSockets: 1,
    scheduling: "fifo",
  });
  private readonly httpsAgent = new HttpsAgent({
    keepAlive: true,
    maxSockets: 1,
    maxFreeSockets: 1,
    maxTotalSockets: 1,
    scheduling: "fifo",
  });
  private readonly idleTimeoutMs: number;
  private readonly sockets = new WeakSet<Socket>();
  private requestCount = 0;
  private openedCount = 0;
  private activeRequests = 0;
  private idleTimer: IdleTimer | null = null;
  private closed = false;

  constructor(options: ListenerHttpClientOptions = {}) {
    const idleTimeoutMs = options.idleTimeoutMs ?? LISTENER_HTTP_IDLE_TIMEOUT_MS;
    if (!Number.isSafeInteger(idleTimeoutMs) || idleTimeoutMs <= 0) {
      throw new Error("listener HTTP idle timeout must be a positive integer");
    }
    this.idleTimeoutMs = idleTimeoutMs;
    this.fetch = this.request.bind(this) as typeof fetch;
  }

  /** Snapshot process-local counts without exposing the agents themselves. */
  metrics(): ListenerHttpMetrics {
    return {
      requests: this.requestCount,
      connectionsOpened: this.openedCount,
      connectionReuseRatio: this.openedCount === 0
        ? 0
        : this.requestCount / this.openedCount,
    };
  }

  /** Close every idle or active socket when the listener process stops. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.clearIdleTimer();
    this.destroyAgents();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer === null) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private destroyAgents(): void {
    this.httpAgent.destroy();
    this.httpsAgent.destroy();
  }

  private beginRequest(): void {
    if (this.closed) throw new Error("listener HTTP client is closed");
    this.clearIdleTimer();
    this.requestCount += 1;
    this.activeRequests += 1;
  }

  private finishRequest(): void {
    this.activeRequests -= 1;
    if (this.activeRequests !== 0 || this.closed) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.activeRequests === 0 && !this.closed) this.destroyAgents();
    }, this.idleTimeoutMs);
    this.idleTimer.unref?.();
  }

  private trackSocket(request: ClientRequest): void {
    request.once("socket", (socket: Socket) => {
      if (this.sockets.has(socket)) return;
      this.sockets.add(socket);
      const opened = () => {
        this.openedCount += 1;
      };
      if (socket.connecting) socket.once("connect", opened);
      else opened();
    });
  }

  private async request(
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> {
    const webRequest = new Request(input, init);
    const url = new URL(webRequest.url);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new TypeError("listener HTTP client accepts only http and https URLs");
    }
    const body = webRequest.method === "GET" || webRequest.method === "HEAD"
      ? null
      : Buffer.from(await webRequest.arrayBuffer());
    const headers = Object.fromEntries(webRequest.headers.entries());
    if (!("accept-encoding" in headers)) headers["accept-encoding"] = "identity";
    if (
      body !== null &&
      !("content-length" in headers) &&
      !("transfer-encoding" in headers)
    ) {
      headers["content-length"] = String(body.byteLength);
    }

    this.beginRequest();
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      this.finishRequest();
    };

    return await new Promise<Response>((resolve, reject) => {
      const send = url.protocol === "https:" ? httpsRequest : httpRequest;
      const agent = url.protocol === "https:" ? this.httpsAgent : this.httpAgent;
      let request: ClientRequest;
      try {
        request = send(url, {
          agent,
          method: webRequest.method,
          headers,
          signal: webRequest.signal,
        });
      } catch (error) {
        finish();
        reject(error);
        return;
      }
      this.trackSocket(request);
      request.once("error", (error) => {
        finish();
        reject(error);
      });
      request.once("response", (message) => {
        const chunks: Buffer[] = [];
        let settled = false;
        const rejectResponse = (error: Error) => {
          if (settled) return;
          settled = true;
          finish();
          reject(error);
        };
        message.on("data", (chunk: Buffer | string) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        message.once("aborted", () => {
          rejectResponse(new TypeError("response body was aborted"));
        });
        message.once("error", rejectResponse);
        message.once("end", () => {
          if (settled) return;
          settled = true;
          finish();
          const status = message.statusCode ?? 0;
          const bytes = Buffer.concat(chunks);
          const responseBody = status === 204 || status === 205 || status === 304
            ? null
            : bytes;
          try {
            resolve(new Response(responseBody, {
              status,
              statusText: message.statusMessage,
              headers: responseHeaders(message),
            }));
          } catch (error) {
            reject(error);
          }
        });
      });
      if (body !== null && body.byteLength > 0) request.write(body);
      request.end();
    });
  }
}
