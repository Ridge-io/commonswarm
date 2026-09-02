/** Reached by `npm --prefix site test` through the recursive observer-test glob. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  HUMAN_SEEN_BATCH_MAX,
  HumanSeenReporter,
  humanSeenBatches,
  type HumanSeenIntersection,
} from "../../lib/human-seen-reporter.js";

const dashboard = readFileSync(new URL("./LiveDashboard.astro", import.meta.url), "utf8");
const reporterSource = readFileSync(
  new URL("../../lib/human-seen-reporter.ts", import.meta.url),
  "utf8",
);

function dispatchIntersections(
  target: EventTarget,
  entries: readonly HumanSeenIntersection[],
): void {
  const event = new Event("intersection") as Event & {
    entries?: readonly HumanSeenIntersection[];
  };
  event.entries = entries;
  target.dispatchEvent(event);
}

test("seen reports deduplicate and stay inside the 50-id command cap", () => {
  const ids = Array.from({ length: 121 }, (_, index) => `signal-${index}`);
  const batches = humanSeenBatches([...ids, ids[0]!, ids[50]!]);
  assert.deepEqual(batches.map((batch) => batch.length), [50, 50, 21]);
  assert.equal(new Set(batches.flat()).size, 121);
  assert.ok(batches.every((batch) => batch.length <= HUMAN_SEEN_BATCH_MAX));
});

test("the reporter sends only after viewport intersection and document focus", async () => {
  let focused = false;
  const sends: Array<{ scope: string; ids: readonly string[] }> = [];
  const windowEvents = new EventTarget();
  const intersectionEvents = new EventTarget();
  const reporter = new HumanSeenReporter({
    hasFocus: () => focused,
    send: async (scope, ids) => sends.push({ scope, ids: [...ids] }),
  });
  windowEvents.addEventListener("focus", () => reporter.focus());
  windowEvents.addEventListener("blur", () => {});
  intersectionEvents.addEventListener("intersection", (event) => {
    reporter.intersections(
      (event as Event & { entries: readonly HumanSeenIntersection[] }).entries,
    );
  });

  windowEvents.dispatchEvent(new Event("blur"));
  dispatchIntersections(intersectionEvents, [{
    scope: "member:workspace",
    signalId: "background-row",
    isIntersecting: true,
  }]);
  await reporter.flush();
  assert.deepEqual(sends, [], "a background-tab intersection is not seen");

  focused = true;
  windowEvents.dispatchEvent(new Event("focus"));
  await reporter.flush();
  assert.deepEqual(sends, [{
    scope: "member:workspace",
    ids: ["background-row"],
  }]);

  dispatchIntersections(intersectionEvents, [{
    scope: "member:workspace",
    signalId: "below-fold-row",
    isIntersecting: false,
  }]);
  windowEvents.dispatchEvent(new Event("focus"));
  await reporter.flush();
  assert.equal(sends.length, 1, "focus alone cannot report a row outside the viewport");

  dispatchIntersections(intersectionEvents, [{
    scope: "member:workspace",
    signalId: "focused-row",
    isIntersecting: true,
  }]);
  await reporter.flush();
  assert.deepEqual(sends[1], {
    scope: "member:workspace",
    ids: ["focused-row"],
  });

  dispatchIntersections(intersectionEvents, [{
    scope: "member:workspace",
    signalId: "visibility-flush-row",
    isIntersecting: true,
  }]);
  reporter.visibilityChange(false);
  await reporter.flush();
  assert.deepEqual(sends[2], {
    scope: "member:workspace",
    ids: ["visibility-flush-row"],
  });
});

test("the reporter's default timer sends a focused intersection", async () => {
  const sent = Promise.withResolvers<{ scope: string; ids: readonly string[] }>();
  const reporter = new HumanSeenReporter({
    hasFocus: () => true,
    send: async (scope, ids) => sent.resolve({ scope, ids: [...ids] }),
    flushMs: 20,
  });

  reporter.intersections([{
    scope: "member:workspace",
    signalId: "default-timer-row",
    isIntersecting: true,
  }]);

  const deadline = Promise.withResolvers<never>();
  const timer = setTimeout(
    () => deadline.reject(new Error("default reporter timer did not flush")),
    1_000,
  );
  try {
    assert.deepEqual(await Promise.race([sent.promise, deadline.promise]), {
      scope: "member:workspace",
      ids: ["default-timer-row"],
    });
  } finally {
    clearTimeout(timer);
  }
});

test("the dashboard wires focused viewport rows to a best-effort command batch", () => {
  assert.match(dashboard, /new IntersectionObserver\(/);
  assert.match(dashboard, /document\.hasFocus\(\)/);
  assert.match(dashboard, /window\.addEventListener\("focus", \(\) => humanSeenReporter\.focus\(\)\)/);
  assert.match(dashboard, /document\.addEventListener\("visibilitychange"/);
  assert.match(dashboard, /humanSeenReporter\.visibilityChange/);
  assert.match(dashboard, /row\.dataset\.humanSeenSignalId = signal\.id/);
  assert.match(dashboard, /reportBrowserSignalsSeen\(/);
  assert.doesNotMatch(
    dashboard.slice(
      dashboard.indexOf("const observeHumanSeenRows"),
      dashboard.indexOf("const NEAR_BOTTOM_PX"),
    ),
    /await /,
    "intersection delivery must not block transcript rendering",
  );
});

function assertFocusGate(source: string): void {
  const start = source.indexOf("#queue(entry:");
  const end = source.indexOf("/** Apply one IntersectionObserver delivery. */", start);
  assert.ok(start >= 0 && end > start, "focus-gate control must reach the queue method");
  assert.match(
    source.slice(start, end),
    /if \(!this\.#hasFocus\(\)\) return;/,
    "focused-viewport reporter lost its document-focus gate",
  );
}

test("mutation control goes red when render alone can report seen", () => {
  assertFocusGate(reporterSource);
  const mutated = reporterSource.replace("if (!this.#hasFocus()) return;", "");
  assert.notEqual(mutated, reporterSource, "mutation must reach the focus gate");
  assert.throws(
    () => assertFocusGate(mutated),
    /focused-viewport reporter lost its document-focus gate/,
  );
});
