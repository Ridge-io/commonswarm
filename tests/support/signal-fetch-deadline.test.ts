/**
 * D-034 — signal status could wait forever because its fetches had no deadline.
 *
 * Pure: no Supabase, no network, no database. The fake fetch never settles on its own,
 * which distinguishes an application deadline from a fast provider failure.
 *
 * ★ THIS FILE IS NAMED IN `npm test`, AND THAT IS LOAD-BEARING.
 *
 * `test:p1-cli` also covers signal behavior, but that suite owns a shared database stack.
 * This deadline observer must stay runnable by every contributor without coordination.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { CloudTarget } from "../../src/cloud/config.js";
import {
  CommandHttpError,
  CommandTransportError,
  SIGNAL_REQUEST_TIMEOUT_MS,
  ThinCommandClient,
  type PostSignalRequest,
} from "../../src/cloud/command-client.js";
import {
  readAgentSignalMembers,
  readSignals,
  settleSignalStatus,
  SIGNAL_STATUS_UNAVAILABLE_MESSAGE,
} from "../../src/cloud/signals.js";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";
const TARGET: CloudTarget = {
  url: "https://example.supabase.co",
  anonKey: "test-anon-key",
  profileId: "test-profile",
};

/**
 * Real-time bound for promises that must settle without the mocked 30-second
 * deadline. If a settlement arm is deleted, the pending promise never settles
 * and the test fails after one real second instead of hanging the whole suite.
 * Captured before mock timers replace globalThis.setTimeout/clearTimeout.
 */
const REAL_SET_TIMEOUT = globalThis.setTimeout;
const REAL_CLEAR_TIMEOUT = globalThis.clearTimeout;

async function boundedRealWait<T>(
  pending: Promise<T>,
  label: string,
): Promise<T | string> {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<string>((resolve) => {
    handle = REAL_SET_TIMEOUT(() => resolve(`still pending after ${label}`), 1_000);
  });
  return Promise.race([pending, bound]).finally(() => {
    if (handle !== undefined) REAL_CLEAR_TIMEOUT(handle);
  });
}

function hangingFetch(observed: AbortSignal[]): typeof fetch {
  return (async (_input, init) => {
    const signal = init?.signal;
    assert.ok(
      signal instanceof AbortSignal,
      "every production signal read must propagate an AbortSignal",
    );
    observed.push(signal);
    return await new Promise<Response>((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        const error = new Error("signal read timed out");
        error.name = "AbortError";
        reject(error);
      }, { once: true });
    });
  }) as typeof fetch;
}

function ignoringAbortFetch(observed: AbortSignal[]): typeof fetch {
  return (async (_input, init) => {
    const signal = init?.signal;
    assert.ok(
      signal instanceof AbortSignal,
      "the production read must still propagate its AbortSignal",
    );
    observed.push(signal);
    return await new Promise<Response>(() => {});
  }) as typeof fetch;
}

function headersThenHangingBody(observed: AbortSignal[]): typeof fetch {
  return (async (_input, init) => {
    const signal = init?.signal;
    assert.ok(
      signal instanceof AbortSignal,
      "the body read must remain under the production AbortSignal",
    );
    observed.push(signal);
    return {
      ok: true,
      status: 200,
      json: async () => await new Promise<never>(() => {}),
    } as unknown as Response;
  }) as typeof fetch;
}

function signalPostRequest(signal?: AbortSignal): PostSignalRequest {
  return {
    workspaceId: WORKSPACE_ID,
    credential: "test-agent-credential",
    command: {
      kind: "post_signal",
      signal_kind: "note",
      body: "runtime reply",
      to_user_id: null,
      to_agent_principal_id: null,
      in_reply_to: "33333333-3333-4333-8333-333333333333",
      about: null,
    },
    ...(signal === undefined ? {} : { signal }),
  };
}

function signalReceipt(): Record<string, unknown> {
  return {
    ok: true,
    status: "accepted",
    event_ids: [],
    signal: {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      workspace_id: WORKSPACE_ID,
      from: "44444444-4444-4444-8444-444444444444",
      from_kind: "agent",
      to: null,
      to_agent: null,
      in_reply_to: null,
      about: null,
      kind: "note",
      body: "runtime reply",
      until: "2026-08-30T00:00:00.000Z",
      created_at: "2026-07-30T00:00:00.000Z",
    },
  };
}

function signalPostSuccess(observed: AbortSignal[]): typeof fetch {
  return (async (_input, init) => {
    const signal = init?.signal;
    assert.ok(
      signal instanceof AbortSignal,
      "sendSignal must propagate one effective AbortSignal",
    );
    observed.push(signal);
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(signalReceipt()),
    } as unknown as Response;
  }) as typeof fetch;
}

/** Headers arrive immediately; the body never settles and ignores abort. */
function signalHeadersThenHangingBody(observed: AbortSignal[]): typeof fetch {
  return (async (_input, init) => {
    const signal = init?.signal;
    assert.ok(
      signal instanceof AbortSignal,
      "the signal post must propagate an AbortSignal",
    );
    observed.push(signal);
    return {
      ok: true,
      status: 200,
      text: async () => await new Promise<never>(() => {}),
    } as unknown as Response;
  }) as typeof fetch;
}

/** Fetch never settles, but rejects with AbortError when its signal aborts. */
function signalHangingFetch(observed: AbortSignal[]): typeof fetch {
  return (async (_input, init) => {
    const signal = init?.signal;
    assert.ok(
      signal instanceof AbortSignal,
      "the signal post must propagate an AbortSignal",
    );
    observed.push(signal);
    return await new Promise<Response>((_resolve, reject) => {
      const fail = () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      };
      if (signal.aborted) {
        fail();
      } else {
        signal.addEventListener("abort", fail, { once: true });
      }
    });
  }) as typeof fetch;
}

/** Headers arrive immediately; the body hangs but honours abort like a real read. */
function signalHeadersThenAbortableBody(observed: AbortSignal[]): typeof fetch {
  return (async (_input, init) => {
    const signal = init?.signal;
    assert.ok(
      signal instanceof AbortSignal,
      "the signal post must propagate an AbortSignal",
    );
    observed.push(signal);
    return {
      ok: true,
      status: 200,
      text: async () =>
        await new Promise<never>((_resolve, reject) => {
          const fail = () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          };
          if (signal.aborted) {
            fail();
          } else {
            signal.addEventListener("abort", fail, { once: true });
          }
        }),
    } as unknown as Response;
  }) as typeof fetch;
}

function signalRefusal(observed: AbortSignal[]): typeof fetch {
  return (async (_input, init) => {
    const signal = init?.signal;
    assert.ok(signal instanceof AbortSignal);
    observed.push(signal);
    return {
      ok: false,
      status: 500,
      text: async () => JSON.stringify({ error: "boom" }),
    } as unknown as Response;
  }) as typeof fetch;
}

function signalMalformedBody(observed: AbortSignal[]): typeof fetch {
  return (async (_input, init) => {
    const signal = init?.signal;
    assert.ok(signal instanceof AbortSignal);
    observed.push(signal);
    return {
      ok: true,
      status: 200,
      text: async () => "not json at all",
    } as unknown as Response;
  }) as typeof fetch;
}

function signalRejectingFetch(observed: AbortSignal[]): typeof fetch {
  return (async (_input, init) => {
    const signal = init?.signal;
    assert.ok(signal instanceof AbortSignal);
    observed.push(signal);
    throw new Error("network down");
  }) as typeof fetch;
}

/** Wraps a caller signal so add/removeEventListener calls can be counted. */
function countingSignal(): {
  signal: AbortSignal;
  adds: () => number;
  removes: () => number;
  abort: () => void;
} {
  const controller = new AbortController();
  const signal = controller.signal;
  let adds = 0;
  let removes = 0;
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  Object.defineProperty(signal, "addEventListener", {
    configurable: true,
    value: (
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: AddEventListenerOptions,
    ) => {
      adds += 1;
      add(type, listener, options);
    },
  });
  Object.defineProperty(signal, "removeEventListener", {
    configurable: true,
    value: (
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: EventListenerOptions,
    ) => {
      removes += 1;
      remove(type, listener, options);
    },
  });
  return {
    signal,
    adds: () => adds,
    removes: () => removes,
    abort: () => controller.abort(),
  };
}

test("sendSignal keeps one deadline through response-body settlement", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const observed: AbortSignal[] = [];
  const client = new ThinCommandClient(
    TARGET,
    signalHeadersThenHangingBody(observed),
  );
  const pending = client.sendSignal(signalPostRequest());

  // Let the fetch resolve so the response-body race is the only live arm.
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(observed.length, 1, "the signal post reached the fetcher");
  const marker = Symbol("still pending");
  t.mock.timers.tick(SIGNAL_REQUEST_TIMEOUT_MS - 1);
  const early = await Promise.race([
    pending.then(() => "settled", () => "settled"),
    Promise.resolve(marker),
  ]);
  assert.equal(
    early,
    marker,
    "the deadline must not fire before SIGNAL_REQUEST_TIMEOUT_MS",
  );

  t.mock.timers.tick(1);
  await assert.rejects(pending, {
    name: "CommandTransportError",
    message: "signal request timed out",
  });
  assert.equal(
    observed[0]!.aborted,
    true,
    "the deadline must abort the request signal",
  );
});

test("sendSignal caller abort during fetch is AbortError, never CommandTransportError", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const observed: AbortSignal[] = [];
  const client = new ThinCommandClient(TARGET, signalHangingFetch(observed));
  const caller = new AbortController();
  const pending = client.sendSignal(signalPostRequest(caller.signal));

  assert.equal(observed.length, 1, "the signal post reached the fetcher");
  caller.abort();
  const caught = await pending.then(() => null, (error: unknown) => error);
  assert.ok(caught instanceof Error);
  assert.equal(caught.name, "AbortError");
  assert.equal(caught instanceof CommandTransportError, false);
  assert.equal(observed[0]!.aborted, true);
});

test("sendSignal caller abort during body settlement is AbortError", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const observed: AbortSignal[] = [];
  const client = new ThinCommandClient(
    TARGET,
    signalHeadersThenAbortableBody(observed),
  );
  const caller = new AbortController();
  const pending = client.sendSignal(signalPostRequest(caller.signal));

  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(observed.length, 1, "headers arrived");
  caller.abort();
  const caught = await pending.then(() => null, (error: unknown) => error);
  assert.ok(caught instanceof Error);
  assert.equal(caught.name, "AbortError");
  assert.equal(caught instanceof CommandTransportError, false);
});

test("sendSignal caller abort settles an abort-ignoring pending fetch as AbortError without the deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const observed: AbortSignal[] = [];
  const client = new ThinCommandClient(TARGET, ignoringAbortFetch(observed));
  const caller = new AbortController();
  const pending = client.sendSignal(signalPostRequest(caller.signal));

  assert.equal(observed.length, 1, "the signal post reached the fetcher");
  caller.abort();
  const caught = await boundedRealWait(
    pending.then(() => null, (error: unknown) => error),
    "caller abort during an abort-ignoring fetch",
  );
  assert.ok(
    caught instanceof Error,
    "the pending fetch must reject promptly without the 30-second timer; got: " +
      String(caught),
  );
  assert.equal(caught.name, "AbortError");
  assert.equal(caught instanceof CommandTransportError, false);
  assert.equal(
    observed[0]!.aborted,
    true,
    "the effective request signal must be aborted",
  );
});

test("sendSignal caller abort settles an abort-ignoring pending body as AbortError without the deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const observed: AbortSignal[] = [];
  const client = new ThinCommandClient(
    TARGET,
    signalHeadersThenHangingBody(observed),
  );
  const caller = new AbortController();
  const pending = client.sendSignal(signalPostRequest(caller.signal));

  // Let the fetch resolve so the response-body race is the only live arm.
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(observed.length, 1, "headers arrived");
  caller.abort();
  const caught = await boundedRealWait(
    pending.then(() => null, (error: unknown) => error),
    "caller abort during an abort-ignoring body",
  );
  assert.ok(
    caught instanceof Error,
    "the pending body must reject promptly without the 30-second timer; got: " +
      String(caught),
  );
  assert.equal(caught.name, "AbortError");
  assert.equal(caught instanceof CommandTransportError, false);
  assert.equal(
    observed[0]!.aborted,
    true,
    "the effective request signal must be aborted",
  );
});

test("sendSignal removes its caller-abort listener on every outcome", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });

  // Success.
  {
    const counted = countingSignal();
    const client = new ThinCommandClient(TARGET, signalPostSuccess([]));
    const result = await client.sendSignal(signalPostRequest(counted.signal));
    assert.equal(result.response.status, "accepted");
    assert.equal(counted.adds(), 1);
    assert.equal(counted.removes(), 1);
  }

  // HTTP refusal.
  {
    const counted = countingSignal();
    const client = new ThinCommandClient(TARGET, signalRefusal([]));
    await assert.rejects(
      client.sendSignal(signalPostRequest(counted.signal)),
      CommandHttpError,
    );
    assert.equal(counted.adds(), 1);
    assert.equal(counted.removes(), 1);
  }

  // Malformed 2xx body.
  {
    const counted = countingSignal();
    const client = new ThinCommandClient(TARGET, signalMalformedBody([]));
    await assert.rejects(
      client.sendSignal(signalPostRequest(counted.signal)),
      /non-JSON/,
    );
    assert.equal(counted.adds(), 1);
    assert.equal(counted.removes(), 1);
  }

  // Transport failure before a response.
  {
    const counted = countingSignal();
    const client = new ThinCommandClient(TARGET, signalRejectingFetch([]));
    await assert.rejects(
      client.sendSignal(signalPostRequest(counted.signal)),
      { name: "CommandTransportError" },
    );
    assert.equal(counted.adds(), 1);
    assert.equal(counted.removes(), 1);
  }

  // Caller abort during fetch.
  {
    const counted = countingSignal();
    const client = new ThinCommandClient(TARGET, signalHangingFetch([]));
    const pending = client.sendSignal(signalPostRequest(counted.signal));
    counted.abort();
    await assert.rejects(pending, { name: "AbortError" });
    assert.equal(counted.adds(), 1);
    assert.equal(counted.removes(), 1);
  }

  // Internal deadline during a body that ignores abort.
  {
    const counted = countingSignal();
    const client = new ThinCommandClient(
      TARGET,
      signalHeadersThenHangingBody([]),
    );
    const pending = client.sendSignal(signalPostRequest(counted.signal));
    await Promise.resolve();
    await Promise.resolve();
    t.mock.timers.tick(SIGNAL_REQUEST_TIMEOUT_MS);
    await assert.rejects(pending, {
      name: "CommandTransportError",
      message: "signal request timed out",
    });
    assert.equal(counted.adds(), 1);
    assert.equal(counted.removes(), 1);
  }

  // Already aborted before the call: no listener is ever attached.
  {
    const counted = countingSignal();
    counted.abort();
    const client = new ThinCommandClient(TARGET, signalPostSuccess([]));
    await assert.rejects(
      client.sendSignal(signalPostRequest(counted.signal)),
      { name: "AbortError" },
    );
    assert.equal(counted.adds(), 0);
    assert.equal(counted.removes(), 0);
  }
});

test("D-034: every signal fetch aborts at the 30 second application deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const observed: AbortSignal[] = [];
  const fetcher = hangingFetch(observed);

  const human = readSignals(TARGET, {
    kind: "human",
    accessToken: "human-access-token",
    userId: USER_ID,
  }, {
    workspaceId: WORKSPACE_ID,
    inbox: false,
  }, fetcher);
  const agent = readSignals(TARGET, {
    kind: "agent",
    token: "agent-token",
  }, {
    workspaceId: WORKSPACE_ID,
    inbox: true,
  }, fetcher);
  const members = readAgentSignalMembers(
    TARGET,
    "agent-token",
    WORKSPACE_ID,
    fetcher,
  );

  const humanFailure = assert.rejects(
    human,
    { message: "signal read could not reach the cloud service" },
  );
  const agentFailure = assert.rejects(
    agent,
    { message: "signal read could not reach the cloud service" },
  );
  const memberFailure = assert.rejects(
    members,
    { message: "member read could not reach the cloud service" },
  );

  assert.equal(observed.length, 3, "all three production fetch sites were reached");
  t.mock.timers.tick(29_999);
  assert.deepEqual(
    observed.map((signal) => signal.aborted),
    [false, false, false],
    "the deadline must not fire early",
  );
  t.mock.timers.tick(1);
  await Promise.all([humanFailure, agentFailure, memberFailure]);
  assert.deepEqual(
    observed.map((signal) => signal.aborted),
    [true, true, true],
    "the deadline must abort every production fetch site",
  );
});

test("D-034: response headers cannot end the deadline before the body settles", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const observed: AbortSignal[] = [];
  const read = readSignals(TARGET, {
    kind: "agent",
    token: "agent-token",
  }, {
    workspaceId: WORKSPACE_ID,
    inbox: false,
  }, headersThenHangingBody(observed));
  const failure = assert.rejects(
    read,
    { message: "signal read could not reach the cloud service" },
  );

  // Let fetchSignalRead receive the Response and enter its pending json() call before
  // advancing time. Merely observing the fetch double is not proof that headers were handled.
  await Promise.resolve();
  assert.equal(observed.length, 1, "the response returned its headers");
  t.mock.timers.tick(29_999);
  assert.equal(observed[0]!.aborted, false, "the deadline must not fire early");
  t.mock.timers.tick(1);
  await failure;
  assert.equal(
    observed[0]!.aborted,
    true,
    "the body stall must remain covered by the production deadline",
  );
});

test("D-034: the signal status fallback settles when providers never answer", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const observed: AbortSignal[] = [];
  const fetcher = ignoringAbortFetch(observed);
  const recent = readSignals(TARGET, {
    kind: "agent",
    token: "agent-token",
  }, {
    workspaceId: WORKSPACE_ID,
    inbox: false,
  }, fetcher);
  const asks = readSignals(TARGET, {
    kind: "agent",
    token: "agent-token",
  }, {
    workspaceId: WORKSPACE_ID,
    inbox: true,
    kind: "ask",
  }, fetcher);

  const status = settleSignalStatus(recent, asks);
  assert.equal(observed.length, 2, "both status reads were started");
  t.mock.timers.tick(30_000);
  assert.deepEqual(await status, {
    recentSignals: null,
    waitingAsks: null,
    warning: SIGNAL_STATUS_UNAVAILABLE_MESSAGE,
  });
  assert.deepEqual(
    observed.map((signal) => signal.aborted),
    [true, true],
    "status must settle even though both fetch calls ignored the abort",
  );
});
