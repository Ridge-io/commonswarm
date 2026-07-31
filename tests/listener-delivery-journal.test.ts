import assert from "node:assert/strict";
import { lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  ackCommandId,
  claimCommandId,
  openListenerDeliveryJournal,
  parseJournalRecord,
} from "../src/listener/delivery-journal.js";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const PRINCIPAL_ID = "22222222-2222-4222-8222-222222222222";
const INSTANCE_ID_1 = "33333333-3333-4333-8333-333333333333";
const INSTANCE_ID_2 = "44444444-4444-4444-8444-444444444444";
const INSTANCE_ID_3 = "55555555-5555-4555-8555-555555555555";
const SIGNAL_ID = "66666666-6666-4666-8666-666666666666";
const LEASE_ID = "77777777-7777-4777-8777-777777777777";

async function makeTempDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "cswarm-journal-test-"));
}

test("1. Generation selection API: missing file initializes, active resumes old ID, inactive starts fresh generation", async () => {
  const dir = await makeTempDir();
  try {
    const t0 = "2026-07-31T12:00:00.000Z";

    // 1a. Missing file initializes new generation
    const res1 = await openListenerDeliveryJournal({
      profileId: "test-profile",
      workspaceId: WORKSPACE_ID,
      principalId: PRINCIPAL_ID,
      proposedListenerInstanceId: INSTANCE_ID_1,
      stateDirectory: dir,
      now: t0,
    });
    assert.equal(res1.listenerInstanceId, INSTANCE_ID_1);
    assert.equal(res1.record.nextClaimOrdinal, 0);
    assert.equal(res1.record.active, null);

    // 1b. Reserve claim so active !== null
    await res1.journal.reserveClaim(t0);

    // Re-open with a proposed different instance ID -> must resume old INSTANCE_ID_1
    const res2 = await openListenerDeliveryJournal({
      profileId: "test-profile",
      workspaceId: WORKSPACE_ID,
      principalId: PRINCIPAL_ID,
      proposedListenerInstanceId: INSTANCE_ID_2,
      stateDirectory: dir,
      now: t0,
    });
    assert.equal(res2.listenerInstanceId, INSTANCE_ID_1);
    assert.notEqual(res2.record.active, null);

    // 1c. Clear active claim so active === null
    await res1.journal.clearActive(t0);

    // Re-open with a proposed INSTANCE_ID_3 -> must begin fresh generation with INSTANCE_ID_3 and reset ordinal
    const res3 = await openListenerDeliveryJournal({
      profileId: "test-profile",
      workspaceId: WORKSPACE_ID,
      principalId: PRINCIPAL_ID,
      proposedListenerInstanceId: INSTANCE_ID_3,
      stateDirectory: dir,
      now: t0,
    });
    assert.equal(res3.listenerInstanceId, INSTANCE_ID_3);
    assert.equal(res3.record.nextClaimOrdinal, 0);
    assert.equal(res3.record.active, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("2. Reserve claim, claim ID generation, attempt recording, and retries", async () => {
  const dir = await makeTempDir();
  try {
    const t0 = "2026-07-31T12:00:00.000Z";
    const { journal, listenerInstanceId } = await openListenerDeliveryJournal({
      profileId: "test-profile",
      workspaceId: WORKSPACE_ID,
      principalId: PRINCIPAL_ID,
      proposedListenerInstanceId: INSTANCE_ID_1,
      stateDirectory: dir,
      now: t0,
    });

    const expectedClaimId = claimCommandId(listenerInstanceId, 0);
    assert.equal(expectedClaimId, `claim_33333333333343338333333333333333_0`);

    const claim = await journal.reserveClaim(t0);
    assert.equal(claim.phase, "claim_pending");
    assert.equal(claim.claimOrdinal, 0);
    assert.equal(claim.claimCommandId, expectedClaimId);
    assert.equal(claim.claimLastAttemptAt, null);

    const recAfterReserve = await journal.read();
    assert.equal(recAfterReserve.nextClaimOrdinal, 1);

    const t1 = "2026-07-31T12:01:00.000Z";
    await journal.recordClaimAttempt(t1);

    const recAfterAttempt = await journal.read();
    assert.equal(recAfterAttempt.active?.claimLastAttemptAt, t1);
    assert.equal(recAfterAttempt.active?.claimCommandId, expectedClaimId);
    assert.equal(recAfterAttempt.nextClaimOrdinal, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("3. Schema, phase, null-field invariants, and malformed/oversized file rejection", async () => {
  const dir = await makeTempDir();
  try {
    const validJson = JSON.stringify({
      version: 1,
      workspaceId: WORKSPACE_ID,
      principalId: PRINCIPAL_ID,
      listenerInstanceId: INSTANCE_ID_1,
      nextClaimOrdinal: 1,
      active: null,
      updatedAt: "2026-07-31T12:00:00.000Z",
    });

    // Valid parses
    assert.doesNotThrow(() => parseJournalRecord(validJson, WORKSPACE_ID, PRINCIPAL_ID));

    // Mismatched workspace/principal
    assert.throws(() => parseJournalRecord(validJson, "ffffffff-ffff-4fff-8fff-ffffffffffff", PRINCIPAL_ID));

    // Unsafe ordinal
    const unsafeOrd = JSON.parse(validJson);
    unsafeOrd.nextClaimOrdinal = 1.5;
    assert.throws(() => parseJournalRecord(JSON.stringify(unsafeOrd)));

    // Unknown version
    const badVer = JSON.parse(validJson);
    badVer.version = 2;
    assert.throws(() => parseJournalRecord(JSON.stringify(badVer)));

    // Unknown top key
    const extraKey = JSON.parse(validJson);
    extraKey.extra = "junk";
    assert.throws(() => parseJournalRecord(JSON.stringify(extraKey)));

    // Malformed timestamp
    const badTime = JSON.parse(validJson);
    badTime.updatedAt = "invalid-date";
    assert.throws(() => parseJournalRecord(JSON.stringify(badTime)));

    // Oversized file (> 8 KiB)
    const oversized = JSON.stringify({
      ...JSON.parse(validJson),
      padding: "x".repeat(9000),
    });
    assert.throws(() => parseJournalRecord(oversized));

    // Phase invariants: claim_pending with non-null leaseId
    const badActive = JSON.parse(validJson);
    badActive.active = {
      phase: "claim_pending",
      claimOrdinal: 0,
      claimCommandId: claimCommandId(INSTANCE_ID_1, 0),
      claimCreatedAt: "2026-07-31T12:00:00.000Z",
      claimLastAttemptAt: null,
      signalId: null,
      leaseId: LEASE_ID, // Violation!
      leasedUntil: null,
      ack: null,
    };
    assert.throws(() => parseJournalRecord(JSON.stringify(badActive)));

    // Phase invariants: leased with leasedUntil <= claimCreatedAt
    const badLeasedTime = JSON.parse(validJson);
    badLeasedTime.active = {
      phase: "leased",
      claimOrdinal: 0,
      claimCommandId: claimCommandId(INSTANCE_ID_1, 0),
      claimCreatedAt: "2026-07-31T12:00:00.000Z",
      claimLastAttemptAt: "2026-07-31T12:00:01.000Z",
      signalId: SIGNAL_ID,
      leaseId: LEASE_ID,
      leasedUntil: "2026-07-31T12:00:00.000Z", // Violation: leasedUntil <= claimCreatedAt
      ack: null,
    };
    assert.throws(() => parseJournalRecord(JSON.stringify(badLeasedTime)));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("4. Record lease idempotence and hostile mismatch controls", async () => {
  const dir = await makeTempDir();
  try {
    const t0 = "2026-07-31T12:00:00.000Z";
    const tLease = "2026-07-31T13:00:00.000Z";
    const { journal } = await openListenerDeliveryJournal({
      profileId: "test-profile",
      workspaceId: WORKSPACE_ID,
      principalId: PRINCIPAL_ID,
      proposedListenerInstanceId: INSTANCE_ID_1,
      stateDirectory: dir,
      now: t0,
    });

    await journal.reserveClaim(t0);

    // Record lease
    await journal.recordLease({
      signalId: SIGNAL_ID,
      leaseId: LEASE_ID,
      leasedUntil: tLease,
      now: t0,
    });

    const rec = await journal.read();
    assert.equal(rec.active?.phase, "leased");
    assert.equal(rec.active?.signalId, SIGNAL_ID);
    assert.equal(rec.active?.leaseId, LEASE_ID);

    // Exact repeat -> idempotent success
    await assert.doesNotReject(async () => {
      await journal.recordLease({
        signalId: SIGNAL_ID,
        leaseId: LEASE_ID,
        leasedUntil: tLease,
        now: t0,
      });
    });

    // Hostile mismatch -> rejects without overwriting
    await assert.rejects(
      async () => {
        await journal.recordLease({
          signalId: SIGNAL_ID,
          leaseId: "88888888-8888-4888-8888-888888888888", // hostile lease ID
          leasedUntil: tLease,
          now: t0,
        });
      },
      (err: Error) => err.message === "delivery journal state conflict",
    );

    // State remains unmodified
    const recUnmodified = await journal.read();
    assert.equal(recUnmodified.active?.leaseId, LEASE_ID);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("5. Prepare ACK idempotence, ACK command ID, and outcome/error immutability", async () => {
  const dir = await makeTempDir();
  try {
    const t0 = "2026-07-31T12:00:00.000Z";
    const tLease = "2026-07-31T13:00:00.000Z";
    const { journal } = await openListenerDeliveryJournal({
      profileId: "test-profile",
      workspaceId: WORKSPACE_ID,
      principalId: PRINCIPAL_ID,
      proposedListenerInstanceId: INSTANCE_ID_1,
      stateDirectory: dir,
      now: t0,
    });

    await journal.reserveClaim(t0);
    await journal.recordLease({
      signalId: SIGNAL_ID,
      leaseId: LEASE_ID,
      leasedUntil: tLease,
      now: t0,
    });

    const expectedAckId = ackCommandId(LEASE_ID);
    assert.equal(expectedAckId, "ack_77777777777747778777777777777777");

    await journal.prepareAck({
      outcome: "replied",
      lastErrorCode: null,
      now: t0,
    });

    const rec = await journal.read();
    assert.equal(rec.active?.phase, "ack_pending");
    assert.equal(rec.active?.ack?.commandId, expectedAckId);
    assert.equal(rec.active?.ack?.outcome, "replied");

    // Exact repeat -> idempotent success
    await assert.doesNotReject(async () => {
      await journal.prepareAck({
        outcome: "replied",
        lastErrorCode: null,
        now: t0,
      });
    });

    // Mismatch outcome -> rejects without overwriting
    await assert.rejects(
      async () => {
        await journal.prepareAck({
          outcome: "failed_terminal",
          lastErrorCode: "provider_refused",
          now: t0,
        });
      },
      (err: Error) => err.message === "delivery journal state conflict",
    );

    // Verify state unchanged
    const recUnmodified = await journal.read();
    assert.equal(recUnmodified.active?.ack?.outcome, "replied");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("6. Outcome/error pairings and reversed invalid pairings", async () => {
  const dir = await makeTempDir();
  try {
    const t0 = "2026-07-31T12:00:00.000Z";
    const tLease = "2026-07-31T13:00:00.000Z";

    const allowedTerminalCodes = [
      "provider_refused",
      "local_effect_failed",
      "host_session_failed",
      "credential_unavailable",
    ] as const;

    for (const code of allowedTerminalCodes) {
      const { journal } = await openListenerDeliveryJournal({
        profileId: `test-profile-${code}`,
        workspaceId: WORKSPACE_ID,
        principalId: PRINCIPAL_ID,
        proposedListenerInstanceId: INSTANCE_ID_1,
        stateDirectory: dir,
        now: t0,
      });
      await journal.reserveClaim(t0);
      await journal.recordLease({
        signalId: SIGNAL_ID,
        leaseId: LEASE_ID,
        leasedUntil: tLease,
        now: t0,
      });
      await journal.prepareAck({
        outcome: "failed_terminal",
        lastErrorCode: code,
        now: t0,
      });
      const rec = await journal.read();
      assert.equal(rec.active?.ack?.lastErrorCode, code);
    }

    // Invalid pairings: replied with non-null lastErrorCode
    const { journal: jInvalid } = await openListenerDeliveryJournal({
      profileId: "test-profile-invalid",
      workspaceId: WORKSPACE_ID,
      principalId: PRINCIPAL_ID,
      proposedListenerInstanceId: INSTANCE_ID_1,
      stateDirectory: dir,
      now: t0,
    });
    await jInvalid.reserveClaim(t0);
    await jInvalid.recordLease({
      signalId: SIGNAL_ID,
      leaseId: LEASE_ID,
      leasedUntil: tLease,
      now: t0,
    });

    await assert.rejects(
      async () => {
        await jInvalid.prepareAck({
          outcome: "replied",
          lastErrorCode: "provider_refused" as any,
          now: t0,
        });
      },
      (err: Error) => err.message === "delivery journal mutation rejected",
    );

    // Invalid pairing: failed_terminal with null lastErrorCode
    await assert.rejects(
      async () => {
        await jInvalid.prepareAck({
          outcome: "failed_terminal",
          lastErrorCode: null,
          now: t0,
        });
      },
      (err: Error) => err.message === "delivery journal mutation rejected",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("7. Clear active preserves next ordinal and future reserve gets next ID", async () => {
  const dir = await makeTempDir();
  try {
    const t0 = "2026-07-31T12:00:00.000Z";
    const { journal } = await openListenerDeliveryJournal({
      profileId: "test-profile",
      workspaceId: WORKSPACE_ID,
      principalId: PRINCIPAL_ID,
      proposedListenerInstanceId: INSTANCE_ID_1,
      stateDirectory: dir,
      now: t0,
    });

    const c1 = await journal.reserveClaim(t0);
    assert.equal(c1.claimOrdinal, 0);

    await journal.clearActive(t0);
    const recCleared = await journal.read();
    assert.equal(recCleared.active, null);
    assert.equal(recCleared.nextClaimOrdinal, 1);

    const c2 = await journal.reserveClaim(t0);
    assert.equal(c2.claimOrdinal, 1);
    assert.equal(c2.claimCommandId, claimCommandId(INSTANCE_ID_1, 1));
    assert.equal(c2.claimCommandId, `claim_33333333333343338333333333333333_1`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("8. Crash-boundary re-open after reserve, attempt, lease, ACK prepare, and clear", async () => {
  const dir = await makeTempDir();
  try {
    const t0 = "2026-07-31T12:00:00.000Z";
    const tLease = "2026-07-31T13:00:00.000Z";

    // 8a. Re-open after reserve
    const s1 = await openListenerDeliveryJournal({
      profileId: "test-profile",
      workspaceId: WORKSPACE_ID,
      principalId: PRINCIPAL_ID,
      proposedListenerInstanceId: INSTANCE_ID_1,
      stateDirectory: dir,
      now: t0,
    });
    await s1.journal.reserveClaim(t0);

    const reOpen1 = await openListenerDeliveryJournal({
      profileId: "test-profile",
      workspaceId: WORKSPACE_ID,
      principalId: PRINCIPAL_ID,
      proposedListenerInstanceId: INSTANCE_ID_2,
      stateDirectory: dir,
      now: t0,
    });
    assert.equal(reOpen1.listenerInstanceId, INSTANCE_ID_1);
    assert.equal(reOpen1.record.active?.phase, "claim_pending");

    // 8b. Re-open after attempt
    await reOpen1.journal.recordClaimAttempt(t0);
    const reOpen2 = await openListenerDeliveryJournal({
      profileId: "test-profile",
      workspaceId: WORKSPACE_ID,
      principalId: PRINCIPAL_ID,
      proposedListenerInstanceId: INSTANCE_ID_2,
      stateDirectory: dir,
      now: t0,
    });
    assert.equal(reOpen2.record.active?.claimLastAttemptAt, t0);

    // 8c. Re-open after lease
    await reOpen2.journal.recordLease({
      signalId: SIGNAL_ID,
      leaseId: LEASE_ID,
      leasedUntil: tLease,
      now: t0,
    });
    const reOpen3 = await openListenerDeliveryJournal({
      profileId: "test-profile",
      workspaceId: WORKSPACE_ID,
      principalId: PRINCIPAL_ID,
      proposedListenerInstanceId: INSTANCE_ID_2,
      stateDirectory: dir,
      now: t0,
    });
    assert.equal(reOpen3.record.active?.phase, "leased");
    assert.equal(reOpen3.record.active?.leaseId, LEASE_ID);

    // 8d. Re-open after ACK prepare
    await reOpen3.journal.prepareAck({
      outcome: "observed",
      lastErrorCode: null,
      now: t0,
    });
    const reOpen4 = await openListenerDeliveryJournal({
      profileId: "test-profile",
      workspaceId: WORKSPACE_ID,
      principalId: PRINCIPAL_ID,
      proposedListenerInstanceId: INSTANCE_ID_2,
      stateDirectory: dir,
      now: t0,
    });
    assert.equal(reOpen4.record.active?.phase, "ack_pending");
    assert.equal(reOpen4.record.active?.ack?.outcome, "observed");

    // 8e. Re-open after clear
    await reOpen4.journal.clearActive(t0);
    const reOpen5 = await openListenerDeliveryJournal({
      profileId: "test-profile",
      workspaceId: WORKSPACE_ID,
      principalId: PRINCIPAL_ID,
      proposedListenerInstanceId: INSTANCE_ID_2,
      stateDirectory: dir,
      now: t0,
    });
    assert.equal(reOpen5.listenerInstanceId, INSTANCE_ID_2); // Fresh generation!
    assert.equal(reOpen5.record.active, null);
    assert.equal(reOpen5.record.nextClaimOrdinal, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("9. File/directory permissions and symlink controls", async () => {
  const dir = await makeTempDir();
  try {
    const t0 = "2026-07-31T12:00:00.000Z";
    const { journal } = await openListenerDeliveryJournal({
      profileId: "test-profile",
      workspaceId: WORKSPACE_ID,
      principalId: PRINCIPAL_ID,
      proposedListenerInstanceId: INSTANCE_ID_1,
      stateDirectory: dir,
      now: t0,
    });

    const dirStat = await lstat(journal.instanceDirectory);
    assert.equal(dirStat.isDirectory(), true);
    assert.equal(dirStat.isSymbolicLink(), false);
    assert.equal(dirStat.mode & 0o777, 0o700);

    const fileStat = await lstat(journal.journalPath);
    assert.equal(fileStat.isFile(), true);
    assert.equal(fileStat.isSymbolicLink(), false);
    assert.equal(fileStat.mode & 0o777, 0o600);

    // Symlink attack control
    const symlinkPath = join(dir, "symlink-dir");
    const targetFile = join(dir, "target.json");
    await writeFile(targetFile, "{}");
    await symlink(targetFile, symlinkPath);

    await assert.rejects(async () => {
      await openListenerDeliveryJournal({
        profileId: "test-profile-symlink",
        workspaceId: WORKSPACE_ID,
        principalId: PRINCIPAL_ID,
        proposedListenerInstanceId: INSTANCE_ID_1,
        stateDirectory: symlinkPath,
        now: t0,
      });
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("10. Serialized positive metadata exists, while known bearer/body/owner/prompt/reply sentinels are absent", async () => {
  const dir = await makeTempDir();
  try {
    const t0 = "2026-07-31T12:00:00.000Z";
    const tLease = "2026-07-31T13:00:00.000Z";
    const { journal } = await openListenerDeliveryJournal({
      profileId: "test-profile",
      workspaceId: WORKSPACE_ID,
      principalId: PRINCIPAL_ID,
      proposedListenerInstanceId: INSTANCE_ID_1,
      stateDirectory: dir,
      now: t0,
    });

    await journal.reserveClaim(t0);
    await journal.recordLease({
      signalId: SIGNAL_ID,
      leaseId: LEASE_ID,
      leasedUntil: tLease,
      now: t0,
    });
    await journal.prepareAck({
      outcome: "replied",
      lastErrorCode: null,
      now: t0,
    });

    const rawJson = await readFile(journal.journalPath, "utf8");

    // Positive metadata checks
    assert.ok(rawJson.includes(WORKSPACE_ID));
    assert.ok(rawJson.includes(PRINCIPAL_ID));
    assert.ok(rawJson.includes(INSTANCE_ID_1));
    assert.ok(rawJson.includes(SIGNAL_ID));
    assert.ok(rawJson.includes(LEASE_ID));

    // Forbidden sentinels check
    const forbidden = ["bearer", "anon", "signal_body", "ask_body", "owner", "prompt", "reply_body"];
    for (const key of forbidden) {
      assert.equal(rawJson.includes(`"${key}"`), false, `Sentinel key "${key}" must be absent`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("11. Public mutation inputs reject non-plain objects, getters, symbols, extra keys", async () => {
  const dir = await makeTempDir();
  try {
    const t0 = "2026-07-31T12:00:00.000Z";
    const tLease = "2026-07-31T13:00:00.000Z";
    const { journal } = await openListenerDeliveryJournal({
      profileId: "test-profile",
      workspaceId: WORKSPACE_ID,
      principalId: PRINCIPAL_ID,
      proposedListenerInstanceId: INSTANCE_ID_1,
      stateDirectory: dir,
      now: t0,
    });

    await journal.reserveClaim(t0);

    // 11a. Class instance input
    class CustomLeaseInput {
      signalId = SIGNAL_ID;
      leaseId = LEASE_ID;
      leasedUntil = tLease;
    }
    await assert.rejects(
      async () => {
        await journal.recordLease(new CustomLeaseInput() as any);
      },
      (err: Error) => err.message === "delivery journal mutation rejected",
    );

    // 11b. Input with getter
    const getterInput = {
      get signalId() {
        return SIGNAL_ID;
      },
      leaseId: LEASE_ID,
      leasedUntil: tLease,
    };
    await assert.rejects(
      async () => {
        await journal.recordLease(getterInput as any);
      },
      (err: Error) => err.message === "delivery journal mutation rejected",
    );

    // 11c. Input with symbol
    const symbolInput = {
      signalId: SIGNAL_ID,
      leaseId: LEASE_ID,
      leasedUntil: tLease,
      [Symbol("secret")]: "hidden",
    };
    await assert.rejects(
      async () => {
        await journal.recordLease(symbolInput as any);
      },
      (err: Error) => err.message === "delivery journal mutation rejected",
    );

    // 11d. Input with toJSON method
    const toJsonInput = {
      signalId: SIGNAL_ID,
      leaseId: LEASE_ID,
      leasedUntil: tLease,
      toJSON() {
        return {};
      },
    };
    await assert.rejects(
      async () => {
        await journal.recordLease(toJsonInput as any);
      },
      (err: Error) => err.message === "delivery journal mutation rejected",
    );

    // 11e. Input with unknown extra key
    const extraInput = {
      signalId: SIGNAL_ID,
      leaseId: LEASE_ID,
      leasedUntil: tLease,
      bearer: "sb-secret-bearer-token",
    };
    await assert.rejects(
      async () => {
        await journal.recordLease(extraInput as any);
      },
      (err: Error) => err.message === "delivery journal mutation rejected",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("12. Generic error sanitization: no UUIDs or sentinels in thrown error messages", async () => {
  const dir = await makeTempDir();
  try {
    const t0 = "2026-07-31T12:00:00.000Z";
    const sentinels = [WORKSPACE_ID, PRINCIPAL_ID, INSTANCE_ID_1, SIGNAL_ID, LEASE_ID, "bearer-token", "secret-prompt"];

    const assertGenericError = (err: Error) => {
      for (const sentinel of sentinels) {
        assert.equal(
          err.message.includes(sentinel),
          false,
          `Error message "${err.message}" must not contain sentinel "${sentinel}"`,
        );
      }
    };

    const { journal } = await openListenerDeliveryJournal({
      profileId: "test-profile",
      workspaceId: WORKSPACE_ID,
      principalId: PRINCIPAL_ID,
      proposedListenerInstanceId: INSTANCE_ID_1,
      stateDirectory: dir,
      now: t0,
    });

    try {
      await journal.recordLease({
        signalId: SIGNAL_ID,
        leaseId: LEASE_ID,
        leasedUntil: "2026-07-31T13:00:00.000Z",
      });
    } catch (e) {
      assertGenericError(e as Error);
    }

    try {
      await journal.recordLease({
        signalId: "invalid-uuid",
        leaseId: LEASE_ID,
        leasedUntil: "2026-07-31T13:00:00.000Z",
      } as any);
    } catch (e) {
      assertGenericError(e as Error);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
