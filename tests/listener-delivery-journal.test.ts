import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  ackCommandId,
  claimCommandId,
  openListenerDeliveryJournal,
  parseJournalRecord,
} from "../src/listener/delivery-journal.js";
import { listenerInstanceKey } from "../src/listener/file-store.js";

// Valid RFC4122 letter-bearing UUIDs for strict uppercase / noncanonical rejection testing
const WORKSPACE_ID = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";
const PRINCIPAL_ID = "b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e";
const INSTANCE_ID_1 = "c3d4e5f6-a7b8-4c9d-8e1f-2a3b4c5d6e7f";
const INSTANCE_ID_2 = "d4e5f6a7-b8c9-4d0e-9f2a-3b4c5d6e7f8a";
const INSTANCE_ID_3 = "e5f6a7b8-c9d0-4e1f-af2a-3b4c5d6e7f8a";
const SIGNAL_ID = "f6a7b8c9-d0e1-4f2a-bf4c-5d6e7f8a9b0c";
const LEASE_ID = "a7b8c9d0-e1f2-4a3b-8c5d-6e7f8a9b0c1d";

const UPPERCASE_WORKSPACE_ID = "A1B2C3D4-E5F6-4A7B-8C9D-0E1F2A3B4C5D";
const UPPERCASE_LEASE_ID = "A7B8C9D0-E1F2-4A3B-8C5D-6E7F8A9B0C1D";

const SENTINEL_VALUES = [
  WORKSPACE_ID,
  PRINCIPAL_ID,
  INSTANCE_ID_1,
  SIGNAL_ID,
  LEASE_ID,
  "SECRET_BEARER_TOKEN_VAL",
  "SECRET_PROMPT_VAL",
  "SECRET_REPLY_VAL",
];

async function makeTempDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "cswarm-journal-test-"));
}

function assertNoSentinelInError(err: Error): void {
  for (const val of SENTINEL_VALUES) {
    assert.equal(
      err.message.includes(val),
      false,
      `Error message "${err.message}" must not contain sentinel value "${val}"`,
    );
  }
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
    assert.equal(expectedClaimId, `claim_c3d4e5f6a7b84c9d8e1f2a3b4c5d6e7f_0`);

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

test("3. Comprehensive schema, phase/null invariants, strict RFC3339 timestamps, letter-bearing UUIDs, and storage error normalization", async () => {
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

    // Mismatched workspace/principal path identities
    assert.throws(() => parseJournalRecord(validJson, INSTANCE_ID_2, PRINCIPAL_ID));
    assert.throws(() => parseJournalRecord(validJson, WORKSPACE_ID, INSTANCE_ID_2));

    // Uppercase letter-bearing UUID rejection
    const upperUuidJson = JSON.parse(validJson);
    upperUuidJson.workspaceId = UPPERCASE_WORKSPACE_ID;
    assert.throws(() => parseJournalRecord(JSON.stringify(upperUuidJson)));

    // Unsafe / equal ordinals
    const unsafeOrd = JSON.parse(validJson);
    unsafeOrd.nextClaimOrdinal = 1.5;
    assert.throws(() => parseJournalRecord(JSON.stringify(unsafeOrd)));

    // Ordinal claimOrdinal >= nextClaimOrdinal
    const equalOrdJson = JSON.parse(validJson);
    equalOrdJson.nextClaimOrdinal = 1;
    equalOrdJson.active = {
      phase: "claim_pending",
      claimOrdinal: 1, // Equal to nextClaimOrdinal!
      claimCommandId: claimCommandId(INSTANCE_ID_1, 1),
      claimCreatedAt: "2026-07-31T12:00:00.000Z",
      claimLastAttemptAt: null,
      signalId: null,
      leaseId: null,
      leasedUntil: null,
      ack: null,
    };
    assert.throws(() => parseJournalRecord(JSON.stringify(equalOrdJson)));

    // Unknown top-level, active, or ack keys
    const extraActiveKey = JSON.parse(validJson);
    extraActiveKey.active = {
      phase: "claim_pending",
      claimOrdinal: 0,
      claimCommandId: claimCommandId(INSTANCE_ID_1, 0),
      claimCreatedAt: "2026-07-31T12:00:00.000Z",
      claimLastAttemptAt: null,
      signalId: null,
      leaseId: null,
      leasedUntil: null,
      ack: null,
      unknownActiveField: 123,
    };
    assert.throws(() => parseJournalRecord(JSON.stringify(extraActiveKey)));

    // Unknown version
    const badVer = JSON.parse(validJson);
    badVer.version = 2;
    assert.throws(() => parseJournalRecord(JSON.stringify(badVer)));

    // Strict RFC3339 / ISO timestamp validation edge cases across all timestamp fields
    const invalidTimestamps = [
      "0",
      "2026-02-30T12:00:00Z", // Non-existent date
      "2026-07-31T24:00:00Z", // Hour 24
      "2025-02-29T12:00:00Z", // Non-leap year Feb 29
      "not-a-date",
    ];

    for (const badTs of invalidTimestamps) {
      const badUpdatedAt = JSON.parse(validJson);
      badUpdatedAt.updatedAt = badTs;
      assert.throws(() => parseJournalRecord(JSON.stringify(badUpdatedAt)));
    }

    // Phase invariants: claim_pending with non-null leaseId
    const badActive = JSON.parse(validJson);
    badActive.active = {
      phase: "claim_pending",
      claimOrdinal: 0,
      claimCommandId: claimCommandId(INSTANCE_ID_1, 0),
      claimCreatedAt: "2026-07-31T12:00:00.000Z",
      claimLastAttemptAt: null,
      signalId: null,
      leaseId: LEASE_ID,
      leasedUntil: null,
      ack: null,
    };
    assert.throws(() => parseJournalRecord(JSON.stringify(badActive)));

    // Deterministic command ID mismatch
    const badCmdId = JSON.parse(validJson);
    badCmdId.active = {
      phase: "claim_pending",
      claimOrdinal: 0,
      claimCommandId: "claim_wrongcommandid_0",
      claimCreatedAt: "2026-07-31T12:00:00.000Z",
      claimLastAttemptAt: null,
      signalId: null,
      leaseId: null,
      leasedUntil: null,
      ack: null,
    };
    assert.throws(() => parseJournalRecord(JSON.stringify(badCmdId)));

    // Storage error normalization: actual > 8 KiB file on disk
    const profileIdOversized = "test-profile-oversized";
    const instKeyOversized = listenerInstanceKey({ profileId: profileIdOversized, workspaceId: WORKSPACE_ID, principalId: PRINCIPAL_ID });
    const oversizedDir = join(dir, instKeyOversized);
    await mkdir(oversizedDir, { recursive: true, mode: 0o700 });
    const oversizedFile = join(oversizedDir, "delivery-journal.json");
    await writeFile(oversizedFile, JSON.stringify({
      version: 1,
      workspaceId: WORKSPACE_ID,
      principalId: PRINCIPAL_ID,
      listenerInstanceId: INSTANCE_ID_1,
      nextClaimOrdinal: 0,
      active: null,
      updatedAt: "2026-07-31T12:00:00.000Z",
      padding: "x".repeat(9000),
    }), { mode: 0o600 });

    await assert.rejects(
      async () => {
        const { journal: oversizedJ } = await openListenerDeliveryJournal({
          profileId: profileIdOversized,
          workspaceId: WORKSPACE_ID,
          principalId: PRINCIPAL_ID,
          proposedListenerInstanceId: INSTANCE_ID_1,
          stateDirectory: dir,
          now: "2026-07-31T12:00:00.000Z",
        });
        await oversizedJ.read();
      },
      (err: Error) => err.message === "stored delivery journal is malformed",
    );
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
          leaseId: INSTANCE_ID_2,
          leasedUntil: tLease,
          now: t0,
        });
      },
      (err: Error) => err.message === "delivery journal state conflict",
    );

    // Uppercase lease ID rejection
    await assert.rejects(
      async () => {
        await journal.recordLease({
          signalId: SIGNAL_ID,
          leaseId: UPPERCASE_LEASE_ID,
          leasedUntil: tLease,
          now: t0,
        });
      },
      (err: Error) => err.message === "delivery journal mutation rejected",
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
    assert.equal(expectedAckId, "ack_a7b8c9d0e1f24a3b8c5d6e7f8a9b0c1d");

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
    assert.equal(c2.claimCommandId, `claim_c3d4e5f6a7b84c9d8e1f2a3b4c5d6e7f_1`);
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
    assert.equal(reOpen5.listenerInstanceId, INSTANCE_ID_2);
    assert.equal(reOpen5.record.active, null);
    assert.equal(reOpen5.record.nextClaimOrdinal, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("9. Required filesystem causality: wrong-mode dir/file, symlinks, and atomic replacement controls", async () => {
  const dir = await makeTempDir();
  try {
    const t0 = "2026-07-31T12:00:00.000Z";
    const profileId = "test-profile-causality";
    const instKey = listenerInstanceKey({ profileId, workspaceId: WORKSPACE_ID, principalId: PRINCIPAL_ID });

    const { journal } = await openListenerDeliveryJournal({
      profileId,
      workspaceId: WORKSPACE_ID,
      principalId: PRINCIPAL_ID,
      proposedListenerInstanceId: INSTANCE_ID_1,
      stateDirectory: dir,
      now: t0,
    });

    // 9a. Normal permissions check
    const dirStat = await lstat(journal.instanceDirectory);
    assert.equal(dirStat.isDirectory(), true);
    assert.equal(dirStat.isSymbolicLink(), false);
    assert.equal(dirStat.mode & 0o777, 0o700);

    const fileStat = await lstat(journal.journalPath);
    assert.equal(fileStat.isFile(), true);
    assert.equal(fileStat.isSymbolicLink(), false);
    assert.equal(fileStat.mode & 0o777, 0o600);

    // 9b. Instance-directory symlink attack control
    const symlinkStateDir = join(dir, "symlink-state-dir");
    const realStateDir = join(dir, "real-state-dir");
    await mkdir(realStateDir, { mode: 0o700 });

    const symlinkInstDir = join(symlinkStateDir, instKey);
    const realInstDir = join(realStateDir, instKey);
    await mkdir(realInstDir, { mode: 0o700 });
    await mkdir(symlinkStateDir, { mode: 0o700 });
    await symlink(realInstDir, symlinkInstDir);

    await assert.rejects(
      async () => {
        await openListenerDeliveryJournal({
          profileId,
          workspaceId: WORKSPACE_ID,
          principalId: PRINCIPAL_ID,
          proposedListenerInstanceId: INSTANCE_ID_1,
          stateDirectory: symlinkStateDir,
          now: t0,
        });
      },
      (err: Error) => err.message.includes("not a real directory"),
    );

    // 9c. Journal-file symlink attack control
    const symlinkFileStateDir = join(dir, "symlink-file-state-dir");
    const targetSymlinkInstDir = join(symlinkFileStateDir, instKey);
    await mkdir(targetSymlinkInstDir, { recursive: true, mode: 0o700 });

    const fakeTargetFile = join(symlinkFileStateDir, "outside-target.json");
    await writeFile(fakeTargetFile, "{}", { mode: 0o600 });
    const symlinkJournalFile = join(targetSymlinkInstDir, "delivery-journal.json");
    await symlink(fakeTargetFile, symlinkJournalFile);

    await assert.rejects(
      async () => {
        const { journal: symlinkJ } = await openListenerDeliveryJournal({
          profileId,
          workspaceId: WORKSPACE_ID,
          principalId: PRINCIPAL_ID,
          proposedListenerInstanceId: INSTANCE_ID_1,
          stateDirectory: symlinkFileStateDir,
          now: t0,
        });
        await symlinkJ.read();
      },
      (err: Error) => err.message.includes("not a regular file"),
    );

    // 9d. Wrong-mode existing directory control (0755 instead of 0700)
    const wrongModeStateDir = join(dir, "wrong-mode-state-dir");
    const wrongModeInstDir = join(wrongModeStateDir, instKey);
    await mkdir(wrongModeInstDir, { recursive: true, mode: 0o755 });
    await chmod(wrongModeInstDir, 0o755);

    await assert.rejects(
      async () => {
        await openListenerDeliveryJournal({
          profileId,
          workspaceId: WORKSPACE_ID,
          principalId: PRINCIPAL_ID,
          proposedListenerInstanceId: INSTANCE_ID_1,
          stateDirectory: wrongModeStateDir,
          now: t0,
        });
      },
      (err: Error) => err.message.includes("must be mode 0700"),
    );

    // 9e. Wrong-mode existing file control (0644 instead of 0600)
    const wrongFileStateDir = join(dir, "wrong-file-state-dir");
    const wrongFileInstDir = join(wrongFileStateDir, instKey);
    await mkdir(wrongFileInstDir, { recursive: true, mode: 0o700 });
    const wrongModeJournalFile = join(wrongFileInstDir, "delivery-journal.json");
    await writeFile(wrongModeJournalFile, JSON.stringify({
      version: 1,
      workspaceId: WORKSPACE_ID,
      principalId: PRINCIPAL_ID,
      listenerInstanceId: INSTANCE_ID_1,
      nextClaimOrdinal: 0,
      active: null,
      updatedAt: t0,
    }), { mode: 0o644 });
    await chmod(wrongModeJournalFile, 0o644);

    await assert.rejects(
      async () => {
        const { journal: wrongFileJ } = await openListenerDeliveryJournal({
          profileId,
          workspaceId: WORKSPACE_ID,
          principalId: PRINCIPAL_ID,
          proposedListenerInstanceId: INSTANCE_ID_1,
          stateDirectory: wrongFileStateDir,
          now: t0,
        });
        await wrongFileJ.read();
      },
      (err: Error) => err.message.includes("must be mode 0600"),
    );

    // 9f. Atomic replacement causality: write replaces file atomically and maintains 0600 mode
    const statBefore = await lstat(journal.journalPath);
    const contentBefore = await readFile(journal.journalPath, "utf8");
    const parsedBefore = parseJournalRecord(contentBefore, WORKSPACE_ID, PRINCIPAL_ID);
    assert.equal(parsedBefore.active, null);

    await journal.reserveClaim(t0);

    const statAfter = await lstat(journal.journalPath);
    const contentAfter = await readFile(journal.journalPath, "utf8");
    const parsedAfter = parseJournalRecord(contentAfter, WORKSPACE_ID, PRINCIPAL_ID);
    assert.notEqual(parsedAfter.active, null);

    assert.notEqual(contentBefore, contentAfter);
    assert.notEqual(statBefore.ino, statAfter.ino, "Atomic replacement must yield a replacement inode");
    assert.equal(statAfter.mode & 0o777, 0o600);
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

test("11. Public mutation inputs reject non-plain objects, proxies, getters, symbols, extra keys, and pre-path non-strings", async () => {
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

    const initialContent = await readFile(journal.journalPath, "utf8");

    // 11a. Proxy hiding an extra property
    const proxyTarget = {
      signalId: SIGNAL_ID,
      leaseId: LEASE_ID,
      leasedUntil: tLease,
      secretBearerToken: "SECRET_BEARER_TOKEN_VAL",
    };
    const proxyHidingExtra = new Proxy(proxyTarget, {
      ownKeys() {
        return ["signalId", "leaseId", "leasedUntil"];
      },
      getOwnPropertyDescriptor(target, prop) {
        if (prop === "secretBearerToken") return undefined;
        return Object.getOwnPropertyDescriptor(target, prop);
      },
    });

    await assert.rejects(
      async () => {
        await journal.recordLease(proxyHidingExtra as any);
      },
      (err: Error) => err.message === "delivery journal mutation rejected",
    );

    // Assert disk file is byte-identical and unaffected!
    const postProxyContent = await readFile(journal.journalPath, "utf8");
    assert.equal(initialContent, postProxyContent);

    // 11b. Proxy with a trap throwing attacker sentinel text
    const throwingProxy = new Proxy({
      signalId: SIGNAL_ID,
      leaseId: LEASE_ID,
      leasedUntil: tLease,
    }, {
      ownKeys() {
        throw new Error("SECRET_BEARER_TOKEN_VAL");
      },
      get(target, prop) {
        throw new Error("SECRET_BEARER_TOKEN_VAL");
      },
    });

    await assert.rejects(
      async () => {
        await journal.recordLease(throwingProxy as any);
      },
      (err: Error) => {
        assertNoSentinelInError(err);
        return err.message === "delivery journal mutation rejected";
      },
    );

    // 11c. Revoked proxy control
    const revocable = Proxy.revocable({
      signalId: SIGNAL_ID,
      leaseId: LEASE_ID,
      leasedUntil: tLease,
    }, {});
    revocable.revoke();

    await assert.rejects(
      async () => {
        await journal.recordLease(revocable.proxy as any);
      },
      (err: Error) => err.message === "delivery journal mutation rejected",
    );

    // 11d. Class instance input
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

    // 11e. Input with getter
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

    // 11f. Input with symbol
    const symbolInput = {
      signalId: SIGNAL_ID,
      leaseId: LEASE_ID,
      leasedUntil: tLease,
      [Symbol("secret")]: "SECRET_BEARER_TOKEN_VAL",
    };
    await assert.rejects(
      async () => {
        await journal.recordLease(symbolInput as any);
      },
      (err: Error) => err.message === "delivery journal mutation rejected",
    );

    // 11g. Input with toJSON method
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

    // 11h. Input with unknown extra key
    const extraInput = {
      signalId: SIGNAL_ID,
      leaseId: LEASE_ID,
      leasedUntil: tLease,
      bearer: "SECRET_BEARER_TOKEN_VAL",
    };
    await assert.rejects(
      async () => {
        await journal.recordLease(extraInput as any);
      },
      (err: Error) => err.message === "delivery journal mutation rejected",
    );

    // 11i. Pre-path type check: non-string stateDirectory passed to openListenerDeliveryJournal
    await assert.rejects(
      async () => {
        await openListenerDeliveryJournal({
          profileId: "test-profile",
          workspaceId: WORKSPACE_ID,
          principalId: PRINCIPAL_ID,
          proposedListenerInstanceId: INSTANCE_ID_1,
          stateDirectory: 12345 as any,
          now: t0,
        });
      },
      (err: Error) => err.message === "delivery journal configuration rejected",
    );

    // Ensure final state on disk is still byte-identical!
    const finalContent = await readFile(journal.journalPath, "utf8");
    assert.equal(initialContent, finalContent);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("12. Generic error sanitization: no sentinel values in thrown error messages for all hostile operations", async () => {
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

    await assert.rejects(
      async () => {
        await journal.recordLease({
          signalId: SIGNAL_ID,
          leaseId: LEASE_ID,
          leasedUntil: "2026-07-31T13:00:00.000Z",
        });
      },
      (err: Error) => {
        assertNoSentinelInError(err);
        return err.message === "delivery journal state conflict";
      },
    );

    await assert.rejects(
      async () => {
        await journal.recordLease({
          signalId: "invalid-uuid-SECRET_BEARER_TOKEN_VAL",
          leaseId: LEASE_ID,
          leasedUntil: "2026-07-31T13:00:00.000Z",
        } as any);
      },
      (err: Error) => {
        assertNoSentinelInError(err);
        return err.message === "delivery journal mutation rejected";
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("13. TOCTOU deferred-read snapshot controls for open, recordLease, and prepareAck", async () => {
  const dir = await makeTempDir();
  try {
    const t0 = "2026-07-31T12:00:00.000Z";
    const tLease = "2026-07-31T13:00:00.000Z";

    // 13a. TOCTOU in openListenerDeliveryJournal
    const openOptions = {
      profileId: "test-profile",
      workspaceId: WORKSPACE_ID,
      principalId: PRINCIPAL_ID,
      proposedListenerInstanceId: INSTANCE_ID_1,
      stateDirectory: dir,
      now: t0,
    };

    // Initiate open without awaiting immediately
    const openPromise = openListenerDeliveryJournal(openOptions);

    // Synchronously mutate caller's options object while open is in flight
    openOptions.proposedListenerInstanceId = INSTANCE_ID_2;
    openOptions.workspaceId = INSTANCE_ID_2;

    const { journal, record, listenerInstanceId } = await openPromise;

    // Verify snapshot was used, ignoring caller's post-call mutation
    assert.equal(listenerInstanceId, INSTANCE_ID_1);
    assert.equal(record.workspaceId, WORKSPACE_ID);
    assert.equal(record.listenerInstanceId, INSTANCE_ID_1);

    await journal.reserveClaim(t0);

    // 13b. TOCTOU in recordLease
    const leaseInput = {
      signalId: SIGNAL_ID,
      leaseId: LEASE_ID,
      leasedUntil: tLease,
      now: t0,
    };

    const leasePromise = journal.recordLease(leaseInput);

    // Synchronously mutate caller's lease input object while recordLease is in flight
    leaseInput.signalId = INSTANCE_ID_2;
    leaseInput.leaseId = INSTANCE_ID_2;

    await leasePromise;

    const recLease = await journal.read();
    assert.equal(recLease.active?.signalId, SIGNAL_ID);
    assert.equal(recLease.active?.leaseId, LEASE_ID);

    // 13c. TOCTOU in prepareAck
    const ackInput = {
      outcome: "replied" as const,
      lastErrorCode: null,
      now: t0,
    };

    const ackPromise = journal.prepareAck(ackInput);

    // Synchronously mutate caller's ack input object while prepareAck is in flight
    (ackInput as any).outcome = "failed_terminal";
    (ackInput as any).lastErrorCode = "provider_refused";

    await ackPromise;

    const recAck = await journal.read();
    assert.equal(recAck.active?.ack?.outcome, "replied");
    assert.equal(recAck.active?.ack?.lastErrorCode, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("14. Causal defect table for numeric offset timestamps across all record fields and valid offset controls", async () => {
  const dir = await makeTempDir();
  try {
    // 14a. Causal defect reproduction across all 5 timestamp fields with invalid offset timestamps
    const defectCases = [
      { field: "updatedAt", invalidOffsetTs: "2025-02-29T12:00:00+01:00" },
      { field: "claimCreatedAt", invalidOffsetTs: "2026-02-30T12:00:00-05:00" },
      { field: "claimLastAttemptAt", invalidOffsetTs: "2025-02-29T12:00:00+01:00" },
      { field: "leasedUntil", invalidOffsetTs: "2030-02-30T12:00:00+01:00" },
      { field: "preparedAt", invalidOffsetTs: "2025-02-29T12:00:00+01:00" },
    ];

    for (const c of defectCases) {
      const fullRecord: any = {
        version: 1,
        workspaceId: WORKSPACE_ID,
        principalId: PRINCIPAL_ID,
        listenerInstanceId: INSTANCE_ID_1,
        nextClaimOrdinal: 1,
        active: {
          phase: "ack_pending",
          claimOrdinal: 0,
          claimCommandId: claimCommandId(INSTANCE_ID_1, 0),
          claimCreatedAt: "2026-07-31T12:00:00.000Z",
          claimLastAttemptAt: "2026-07-31T12:01:00.000Z",
          signalId: SIGNAL_ID,
          leaseId: LEASE_ID,
          leasedUntil: "2026-07-31T13:00:00.000Z",
          ack: {
            commandId: ackCommandId(LEASE_ID),
            outcome: "replied",
            lastErrorCode: null,
            preparedAt: "2026-07-31T12:02:00.000Z",
          },
        },
        updatedAt: "2026-07-31T12:00:00.000Z",
      };

      if (c.field === "updatedAt") {
        fullRecord.updatedAt = c.invalidOffsetTs;
      } else if (c.field === "claimCreatedAt") {
        fullRecord.active.claimCreatedAt = c.invalidOffsetTs;
      } else if (c.field === "claimLastAttemptAt") {
        fullRecord.active.claimLastAttemptAt = c.invalidOffsetTs;
      } else if (c.field === "leasedUntil") {
        fullRecord.active.leasedUntil = c.invalidOffsetTs;
      } else if (c.field === "preparedAt") {
        fullRecord.active.ack.preparedAt = c.invalidOffsetTs;
      }

      assert.throws(
        () => parseJournalRecord(JSON.stringify(fullRecord), WORKSPACE_ID, PRINCIPAL_ID),
        (err: Error) => err.message === "stored delivery journal is malformed",
        `Field ${c.field} with invalid offset timestamp ${c.invalidOffsetTs} must be rejected`,
      );
    }

    // 14b. Valid controls for leap-day Z, positive offset, and negative offset
    const validLeapDayTimestamps = [
      "2024-02-29T12:00:00Z",
      "2024-02-29T12:00:00+01:00",
      "2024-02-29T12:00:00-05:00",
    ];

    for (const validTs of validLeapDayTimestamps) {
      const validLeapRecord: any = {
        version: 1,
        workspaceId: WORKSPACE_ID,
        principalId: PRINCIPAL_ID,
        listenerInstanceId: INSTANCE_ID_1,
        nextClaimOrdinal: 0,
        active: null,
        updatedAt: validTs,
      };
      assert.doesNotThrow(
        () => parseJournalRecord(JSON.stringify(validLeapRecord), WORKSPACE_ID, PRINCIPAL_ID),
        `Valid leap-day timestamp ${validTs} must be accepted`,
      );
    }

    // 14c. Valid controls for ordinary timestamps with Z, +00:00, and a nonzero offset
    const validOrdinaryTimestamps = [
      "2026-07-31T12:00:00Z",
      "2026-07-31T12:00:00+00:00",
      "2026-07-31T12:00:00-05:00",
      "2026-07-31T12:00:00+02:00",
    ];

    for (const validTs of validOrdinaryTimestamps) {
      const validOrdRecord: any = {
        version: 1,
        workspaceId: WORKSPACE_ID,
        principalId: PRINCIPAL_ID,
        listenerInstanceId: INSTANCE_ID_1,
        nextClaimOrdinal: 0,
        active: null,
        updatedAt: validTs,
      };
      assert.doesNotThrow(
        () => parseJournalRecord(JSON.stringify(validOrdRecord), WORKSPACE_ID, PRINCIPAL_ID),
        `Valid timestamp ${validTs} must be accepted`,
      );
    }

    // 14d. Transition methods using valid offset timestamps where surrounding chronology is valid
    const tInit = "2026-07-31T12:00:00+02:00";
    const tReserve = "2026-07-31T12:01:00+02:00";
    const tAttempt = "2026-07-31T12:02:00+02:00";
    const tLeaseUntil = "2026-07-31T13:00:00+02:00";
    const tAckPrepared = "2026-07-31T12:05:00+02:00";
    const tClear = "2026-07-31T12:10:00+02:00";

    const { journal } = await openListenerDeliveryJournal({
      profileId: "test-profile-offset-transitions",
      workspaceId: WORKSPACE_ID,
      principalId: PRINCIPAL_ID,
      proposedListenerInstanceId: INSTANCE_ID_1,
      stateDirectory: dir,
      now: tInit,
    });

    const recInit = await journal.read();
    assert.equal(recInit.updatedAt, tInit);

    const claim = await journal.reserveClaim(tReserve);
    assert.equal(claim.claimCreatedAt, tReserve);

    await journal.recordClaimAttempt(tAttempt);
    const recAttempt = await journal.read();
    assert.equal(recAttempt.active?.claimLastAttemptAt, tAttempt);

    await journal.recordLease({
      signalId: SIGNAL_ID,
      leaseId: LEASE_ID,
      leasedUntil: tLeaseUntil,
      now: tAttempt,
    });
    const recLease = await journal.read();
    assert.equal(recLease.active?.leasedUntil, tLeaseUntil);

    await journal.prepareAck({
      outcome: "replied",
      lastErrorCode: null,
      preparedAt: tAckPrepared,
      now: tAckPrepared,
    });
    const recAck = await journal.read();
    assert.equal(recAck.active?.ack?.preparedAt, tAckPrepared);

    await journal.clearActive(tClear);
    const recClear = await journal.read();
    assert.equal(recClear.active, null);
    assert.equal(recClear.updatedAt, tClear);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("15. Concurrency and locking causality: concurrent recordLease + recordClaimAttempt, two concurrent reserveClaim", async () => {
  const dir = await makeTempDir();
  try {
    const t0 = "2026-07-31T12:00:00.000Z";
    const tLease = "2026-07-31T13:00:00.000Z";
    const tAttempt = "2026-07-31T12:30:00.000Z";

    // 15a. Concurrent recordLease + recordClaimAttempt over 30 runs
    for (let i = 0; i < 30; i++) {
      const profileId = `test-profile-concurrent-${i}`;
      const { journal } = await openListenerDeliveryJournal({
        profileId,
        workspaceId: WORKSPACE_ID,
        principalId: PRINCIPAL_ID,
        proposedListenerInstanceId: INSTANCE_ID_1,
        stateDirectory: dir,
        now: t0,
      });

      await journal.reserveClaim(t0);

      await Promise.all([
        journal.recordLease({
          signalId: SIGNAL_ID,
          leaseId: LEASE_ID,
          leasedUntil: tLease,
          now: t0,
        }),
        journal.recordClaimAttempt(tAttempt),
      ]);

      const finalRecord = await journal.read();
      assert.equal(
        finalRecord.active?.phase,
        "leased",
        `Run ${i}: Lease phase must be preserved`,
      );
      assert.equal(
        finalRecord.active?.leaseId,
        LEASE_ID,
        `Run ${i}: Lease ID must be preserved`,
      );
      assert.equal(
        finalRecord.active?.signalId,
        SIGNAL_ID,
        `Run ${i}: Signal ID must be preserved`,
      );
      assert.equal(
        finalRecord.active?.claimLastAttemptAt,
        tAttempt,
        `Run ${i}: Attempt timestamp must be preserved`,
      );
    }

    // 15b. Two concurrent reserveClaim: exactly one reservation, one state conflict, one ordinal advance
    const { journal: reserveJ } = await openListenerDeliveryJournal({
      profileId: "test-profile-concurrent-reserve",
      workspaceId: WORKSPACE_ID,
      principalId: PRINCIPAL_ID,
      proposedListenerInstanceId: INSTANCE_ID_1,
      stateDirectory: dir,
      now: t0,
    });

    const reserveResults = await Promise.allSettled([
      reserveJ.reserveClaim(t0),
      reserveJ.reserveClaim(t0),
    ]);

    const fulfilled = reserveResults.filter((r) => r.status === "fulfilled");
    const rejected = reserveResults.filter((r) => r.status === "rejected");

    assert.equal(fulfilled.length, 1, "Exactly one reserveClaim must succeed");
    assert.equal(rejected.length, 1, "Exactly one reserveClaim must reject");
    if (rejected[0]?.status === "rejected") {
      assert.equal(
        (rejected[0].reason as Error).message,
        "delivery journal state conflict",
      );
    }

    const recAfterReserve = await reserveJ.read();
    assert.equal(recAfterReserve.nextClaimOrdinal, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("16. Oversize fractional timestamps: fresh open, inactive rotation, and transition guards", async () => {
  const dir = await makeTempDir();
  try {
    const t0 = "2026-07-31T12:00:00.000Z";
    const oversizeTs = "2026-07-31T12:00:00." + "9".repeat(9000) + "Z";

    // 16a. Fresh open with 9,000 fractional digits rejects, creates no journal file, leaves no lock
    const profileIdFresh = "test-profile-oversize-fresh";
    await assert.rejects(
      async () => {
        await openListenerDeliveryJournal({
          profileId: profileIdFresh,
          workspaceId: WORKSPACE_ID,
          principalId: PRINCIPAL_ID,
          proposedListenerInstanceId: INSTANCE_ID_1,
          stateDirectory: dir,
          now: oversizeTs,
        });
      },
      (err: Error) => err.message === "delivery journal configuration rejected",
    );

    const instKeyFresh = listenerInstanceKey({
      profileId: profileIdFresh,
      workspaceId: WORKSPACE_ID,
      principalId: PRINCIPAL_ID,
    });
    const journalPathFresh = join(dir, instKeyFresh, "delivery-journal.json");
    const lockPathFresh = join(dir, instKeyFresh, "delivery-journal.lock");

    await assert.rejects(async () => await lstat(journalPathFresh));
    await assert.rejects(async () => await lstat(lockPathFresh));

    // 16b. Inactive existing open with 9,000 fractional digits rejects and preserves exact bytes and inode
    const profileIdInactive = "test-profile-oversize-inactive";
    const { journal: inactiveJ } = await openListenerDeliveryJournal({
      profileId: profileIdInactive,
      workspaceId: WORKSPACE_ID,
      principalId: PRINCIPAL_ID,
      proposedListenerInstanceId: INSTANCE_ID_1,
      stateDirectory: dir,
      now: t0,
    });

    const statBefore = await lstat(inactiveJ.journalPath);
    const contentBefore = await readFile(inactiveJ.journalPath, "utf8");

    await assert.rejects(
      async () => {
        await openListenerDeliveryJournal({
          profileId: profileIdInactive,
          workspaceId: WORKSPACE_ID,
          principalId: PRINCIPAL_ID,
          proposedListenerInstanceId: INSTANCE_ID_2,
          stateDirectory: dir,
          now: oversizeTs,
        });
      },
      (err: Error) => err.message === "delivery journal configuration rejected",
    );

    const statAfter = await lstat(inactiveJ.journalPath);
    const contentAfter = await readFile(inactiveJ.journalPath, "utf8");

    assert.equal(statBefore.ino, statAfter.ino, "Inode must remain unchanged");
    assert.equal(contentBefore, contentAfter, "Bytes must remain unchanged");

    const lockPathInactive = join(inactiveJ.instanceDirectory, "delivery-journal.lock");
    await assert.rejects(async () => await lstat(lockPathInactive));

    // 16c. Oversize timestamps in transitions reject before modification
    await assert.rejects(
      async () => await inactiveJ.reserveClaim(oversizeTs),
      (err: Error) => err.message === "delivery journal mutation rejected",
    );

    await inactiveJ.reserveClaim(t0);

    await assert.rejects(
      async () => await inactiveJ.recordClaimAttempt(oversizeTs),
      (err: Error) => err.message === "delivery journal mutation rejected",
    );

    await assert.rejects(
      async () =>
        await inactiveJ.recordLease({
          signalId: SIGNAL_ID,
          leaseId: LEASE_ID,
          leasedUntil: "2026-07-31T13:00:00Z",
          now: oversizeTs,
        }),
      (err: Error) => err.message === "delivery journal mutation rejected",
    );

    await assert.rejects(
      async () =>
        await inactiveJ.recordLease({
          signalId: SIGNAL_ID,
          leaseId: LEASE_ID,
          leasedUntil: oversizeTs,
          now: t0,
        }),
      (err: Error) => err.message === "delivery journal mutation rejected",
    );

    await inactiveJ.recordLease({
      signalId: SIGNAL_ID,
      leaseId: LEASE_ID,
      leasedUntil: "2026-07-31T13:00:00Z",
      now: t0,
    });

    await assert.rejects(
      async () =>
        await inactiveJ.prepareAck({
          outcome: "replied",
          lastErrorCode: null,
          now: oversizeTs,
        }),
      (err: Error) => err.message === "delivery journal mutation rejected",
    );

    await assert.rejects(
      async () =>
        await inactiveJ.prepareAck({
          outcome: "replied",
          lastErrorCode: null,
          preparedAt: oversizeTs,
          now: t0,
        }),
      (err: Error) => err.message === "delivery journal mutation rejected",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("17. Fractional timestamp precision (3- and 9-digit) and immediate post-write read <= 8192 bytes", async () => {
  const dir = await makeTempDir();
  try {
    const t3 = "2026-07-31T12:00:00.123Z";
    const t9 = "2026-07-31T12:00:00.123456789Z";
    const tLease = "2026-07-31T13:00:00.987654321Z";

    const { journal } = await openListenerDeliveryJournal({
      profileId: "test-profile-fractional",
      workspaceId: WORKSPACE_ID,
      principalId: PRINCIPAL_ID,
      proposedListenerInstanceId: INSTANCE_ID_1,
      stateDirectory: dir,
      now: t3,
    });

    const rec0 = await journal.read();
    assert.equal(rec0.updatedAt, t3);
    assert.ok(Buffer.byteLength(JSON.stringify(rec0), "utf8") <= 8192);

    const claim = await journal.reserveClaim(t9);
    assert.equal(claim.claimCreatedAt, t9);

    const rec1 = await journal.read();
    assert.equal(rec1.updatedAt, t9);
    assert.ok(Buffer.byteLength(JSON.stringify(rec1), "utf8") <= 8192);

    await journal.recordLease({
      signalId: SIGNAL_ID,
      leaseId: LEASE_ID,
      leasedUntil: tLease,
      now: t9,
    });

    const rec2 = await journal.read();
    assert.equal(rec2.active?.leasedUntil, tLease);
    assert.ok(Buffer.byteLength(JSON.stringify(rec2), "utf8") <= 8192);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
