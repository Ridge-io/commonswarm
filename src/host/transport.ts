/**
 * NDJSON JSON-RPC transport over a duplex stdio pair.
 * Strictly bounds line/frame size and pending-request cardinality.
 */

import { EventEmitter } from "node:events";
import type { Readable, Writable } from "node:stream";
import {
  ACP_DEFAULT_REQUEST_TIMEOUT_MS,
  ACP_MAX_FRAME_BYTES,
  ACP_MAX_LINE_BYTES,
  ACP_MAX_PENDING_REQUESTS,
} from "./bounds.js";
import {
  AcpChildExitError,
  AcpProtocolError,
  AcpTimeoutError,
  type JsonRpcId,
} from "./types.js";

export type TransportHandlers = {
  onNotification?: (method: string, params: unknown) => void;
  onRequest?: (
    id: JsonRpcId,
    method: string,
    params: unknown,
  ) => void | Promise<void>;
  onProtocolError?: (error: Error) => void;
};

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  method: string;
};

export type AcpTransportOptions = {
  readable: Readable;
  writable: Writable;
  handlers?: TransportHandlers;
  requestTimeoutMs?: number;
  /** Optional child-exit signal — rejects all pending when fired. */
  onChildExit?: (handler: (code: number | null, signal: NodeJS.Signals | null) => void) => void;
};

/**
 * Line-framed JSON-RPC 2.0 client for an ACP agent subprocess.
 */
export class AcpTransport extends EventEmitter {
  private readonly writable: Writable;
  private readonly handlers: TransportHandlers;
  private readonly requestTimeoutMs: number;
  private readonly pending = new Map<string, Pending>();
  private nextId = 1;
  private closed = false;
  private buffer = Buffer.alloc(0);
  private childExit: { code: number | null; signal: NodeJS.Signals | null } | null = null;

  constructor(options: AcpTransportOptions) {
    super();
    this.writable = options.writable;
    this.handlers = options.handlers ?? {};
    this.requestTimeoutMs = options.requestTimeoutMs ?? ACP_DEFAULT_REQUEST_TIMEOUT_MS;

    options.readable.on("data", (chunk: Buffer | string) => {
      this.onData(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    });
    options.readable.on("end", () => {
      this.failAll(new AcpChildExitError(this.childExit?.code ?? null, this.childExit?.signal ?? null));
    });
    options.readable.on("error", (err: Error) => {
      this.failAll(err);
    });
    options.writable.on("error", (err: Error) => {
      this.failAll(err);
    });

    options.onChildExit?.((code, signal) => {
      this.childExit = { code, signal };
      this.failAll(new AcpChildExitError(code, signal));
    });
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new AcpProtocolError("transport closed", "closed"));
    }
    if (this.childExit) {
      return Promise.reject(
        new AcpChildExitError(this.childExit.code, this.childExit.signal),
      );
    }
    if (this.pending.size >= ACP_MAX_PENDING_REQUESTS) {
      return Promise.reject(
        new AcpProtocolError(
          `pending request limit ${ACP_MAX_PENDING_REQUESTS} exceeded`,
          "pending_limit",
        ),
      );
    }
    const id = this.nextId++;
    const key = String(id);
    const frame = {
      jsonrpc: "2.0" as const,
      id,
      method,
      ...(params !== undefined ? { params } : {}),
    };
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(key);
        reject(new AcpTimeoutError(`ACP request timed out: ${method}`));
      }, timeoutMs ?? this.requestTimeoutMs);
      this.pending.set(key, { resolve, reject, timer, method });
      try {
        this.writeFrame(frame);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(key);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /** Notification — no id field (ACP session/cancel). */
  notify(method: string, params?: unknown): void {
    if (this.closed) {
      throw new AcpProtocolError("transport closed", "closed");
    }
    const frame: Record<string, unknown> = {
      jsonrpc: "2.0",
      method,
    };
    if (params !== undefined) frame.params = params;
    this.writeFrame(frame);
  }

  respond(id: JsonRpcId, result: unknown): void {
    this.writeFrame({ jsonrpc: "2.0", id, result });
  }

  respondError(id: JsonRpcId, code: number, message: string): void {
    this.writeFrame({
      jsonrpc: "2.0",
      id,
      error: { code, message },
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.failAll(new AcpProtocolError("transport closed", "closed"));
    try {
      this.writable.end();
    } catch {
      // ignore
    }
  }

  private writeFrame(frame: unknown): void {
    const line = JSON.stringify(frame);
    const bytes = Buffer.byteLength(line, "utf8");
    if (bytes > ACP_MAX_FRAME_BYTES) {
      throw new AcpProtocolError(
        `outbound frame exceeds ${ACP_MAX_FRAME_BYTES} bytes`,
        "frame_too_large",
      );
    }
    this.writable.write(line + "\n");
  }

  private onData(chunk: Buffer): void {
    if (this.closed) return;
    if (this.buffer.length + chunk.length > ACP_MAX_LINE_BYTES * 2) {
      // Cap the reassembled buffer; drop and report.
      this.buffer = Buffer.alloc(0);
      const err = new AcpProtocolError(
        "inbound buffer exceeded safe limit",
        "buffer_overflow",
      );
      this.handlers.onProtocolError?.(err);
      this.emit("protocolError", err);
      return;
    }
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const nl = this.buffer.indexOf(0x0a);
      if (nl === -1) {
        if (this.buffer.length > ACP_MAX_LINE_BYTES) {
          this.buffer = Buffer.alloc(0);
          const err = new AcpProtocolError(
            `inbound line exceeds ${ACP_MAX_LINE_BYTES} bytes`,
            "line_too_large",
          );
          this.handlers.onProtocolError?.(err);
          this.emit("protocolError", err);
        }
        break;
      }
      const lineBuf = this.buffer.subarray(0, nl);
      this.buffer = this.buffer.subarray(nl + 1);
      // Strip trailing CR for CRLF.
      const end = lineBuf.length > 0 && lineBuf[lineBuf.length - 1] === 0x0d
        ? lineBuf.length - 1
        : lineBuf.length;
      if (end === 0) continue;
      if (end > ACP_MAX_LINE_BYTES) {
        const err = new AcpProtocolError(
          `inbound line exceeds ${ACP_MAX_LINE_BYTES} bytes`,
          "line_too_large",
        );
        this.handlers.onProtocolError?.(err);
        this.emit("protocolError", err);
        continue;
      }
      const line = lineBuf.subarray(0, end).toString("utf8");
      this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      const err = new AcpProtocolError("malformed JSON line", "malformed_json");
      this.handlers.onProtocolError?.(err);
      this.emit("protocolError", err);
      return;
    }
    if (!msg || typeof msg !== "object") {
      const err = new AcpProtocolError("non-object JSON-RPC frame", "malformed_frame");
      this.handlers.onProtocolError?.(err);
      this.emit("protocolError", err);
      return;
    }
    const rec = msg as Record<string, unknown>;
    if (rec.jsonrpc !== "2.0") {
      // Tolerate missing jsonrpc on some agent quirks? Spec requires it — reject.
      const err = new AcpProtocolError("missing jsonrpc 2.0", "malformed_frame");
      this.handlers.onProtocolError?.(err);
      this.emit("protocolError", err);
      return;
    }

    // Response (has id, result or error, no method)
    if ("id" in rec && rec.id !== null && rec.id !== undefined && !("method" in rec)) {
      this.handleResponse(rec);
      return;
    }

    // Request from agent (method + id)
    if (typeof rec.method === "string" && "id" in rec && rec.id !== null && rec.id !== undefined) {
      const id = rec.id as JsonRpcId;
      if (typeof id !== "string" && typeof id !== "number") {
        const err = new AcpProtocolError("invalid request id", "malformed_frame");
        this.handlers.onProtocolError?.(err);
        return;
      }
      void Promise.resolve(this.handlers.onRequest?.(id, rec.method, rec.params)).catch(
        (err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          try {
            this.respondError(id, -32000, message);
          } catch {
            // ignore
          }
        },
      );
      return;
    }

    // Notification (method, no id)
    if (typeof rec.method === "string") {
      try {
        this.handlers.onNotification?.(rec.method, rec.params);
      } catch (err) {
        // Host handler bugs must not kill the transport.
        this.emit("handlerError", err);
      }
      return;
    }

    const err = new AcpProtocolError("unrecognized JSON-RPC frame", "malformed_frame");
    this.handlers.onProtocolError?.(err);
    this.emit("protocolError", err);
  }

  private handleResponse(rec: Record<string, unknown>): void {
    const key = String(rec.id);
    const pending = this.pending.get(key);
    if (!pending) {
      // Late or unknown id — ignore safely.
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(key);
    if ("error" in rec && rec.error !== undefined) {
      const errObj = rec.error as { message?: unknown; code?: unknown } | null;
      const message =
        errObj && typeof errObj.message === "string"
          ? errObj.message
          : `RPC error for ${pending.method}`;
      pending.reject(new AcpProtocolError(message, "rpc_error"));
      return;
    }
    pending.resolve(rec.result);
  }

  private failAll(error: Error): void {
    if (this.closed && this.pending.size === 0) return;
    for (const [key, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(key);
    }
  }
}
