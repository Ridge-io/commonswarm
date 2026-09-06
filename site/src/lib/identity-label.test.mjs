/** Reached by `npm --prefix site test` through the src/lib/*.test.mjs glob. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { browserSignalCommand } from "./commonswarm.ts";
import {
  ALLOW_DUPLICATE_NAME_FIELD,
  createAgentPrincipalCommand,
  identityDisplayLabel,
  identityUuidSuffix,
  lookupByDisplayName,
  parseStoredIdentityRef,
  resolveStoredIdentityRef,
  resolveStoredIdentityRefs,
} from "./identity-label.ts";

const WREN_A = "11111111-1111-4111-8111-111111111111";
const WREN_B = "22222222-2222-4222-8222-222222222222";
const ORBIT = "33333333-3333-4333-8333-333333333333";
const DANA = "44444444-4444-4444-8444-444444444444";

const agents = [
  { id: WREN_A, name: "Wren" },
  { id: WREN_B, name: "Wren" },
  { id: ORBIT, name: "Orbit" },
];
const members = [{ id: DANA, name: "Dana" }];
const roster = { agents, members };

test("unique names stay bare and duplicate names get a short UUID suffix", () => {
  assert.equal(
    identityDisplayLabel({ id: ORBIT, name: "Orbit" }, agents),
    "Orbit",
  );
  assert.equal(
    identityDisplayLabel({ id: WREN_A, name: "Wren" }, agents),
    `Wren · ${identityUuidSuffix(WREN_A, agents)}`,
  );
  assert.equal(
    identityDisplayLabel({ id: WREN_B, name: "Wren" }, agents),
    `Wren · ${identityUuidSuffix(WREN_B, agents)}`,
  );
  assert.notEqual(
    identityDisplayLabel({ id: WREN_A, name: "Wren" }, agents),
    identityDisplayLabel({ id: WREN_B, name: "Wren" }, agents),
  );
});

test("a name-only lookup resolves only when unique and never takes the first match", () => {
  assert.deepEqual(lookupByDisplayName("Orbit", agents), {
    status: "unique",
    id: ORBIT,
  });
  assert.deepEqual(lookupByDisplayName("Wren", agents), {
    status: "ambiguous",
    name: "Wren",
  });
  assert.notEqual(lookupByDisplayName("Wren", agents).status, "unique");
  assert.deepEqual(lookupByDisplayName("Mercury", agents), {
    status: "missing",
    name: "Mercury",
  });
});

test("two same-name UUIDs stay separately selectable after rename and revoke", () => {
  const chosen = { kind: "agent", id: WREN_A };
  const renamed = {
    agents: [
      { id: WREN_A, name: "Orbit" },
      { id: WREN_B, name: "Wren" },
    ],
    members,
  };
  assert.deepEqual(resolveStoredIdentityRef(chosen, renamed), {
    status: "resolved",
    kind: "agent",
    id: WREN_A,
  });

  const revoked = {
    agents: [{ id: WREN_B, name: "Wren" }],
    members,
  };
  const kept = resolveStoredIdentityRefs([chosen], revoked);
  assert.deepEqual(kept.recipients, [{ kind: "agent", id: WREN_A }]);
  assert.deepEqual(kept.ambiguous, []);
});

test("an old name-only draft resolves only when unique and otherwise clears", () => {
  const unique = resolveStoredIdentityRefs(
    [{ kind: "agent", name: "Orbit" }],
    roster,
  );
  assert.deepEqual(unique.recipients, [{ kind: "agent", id: ORBIT }]);

  const ambiguous = resolveStoredIdentityRefs(
    [{ kind: "agent", name: "Wren" }, { kind: "agent", id: "Wren" }],
    roster,
  );
  assert.deepEqual(ambiguous.recipients, []);
  assert.deepEqual(ambiguous.ambiguous, ["Wren"]);
});

test("a stored non-UUID roster id still restores, so sample and legacy keys keep their target", () => {
  const sample = {
    agents: [{ id: "sample-orbit", name: "Orbit" }],
    members: [],
  };
  assert.deepEqual(
    resolveStoredIdentityRef({ kind: "agent", id: "sample-orbit" }, sample),
    { status: "resolved", kind: "agent", id: "sample-orbit" },
  );
});

test("parseStoredIdentityRef keeps UUID ids and name-only rows", () => {
  assert.deepEqual(
    parseStoredIdentityRef({ kind: "agent", id: WREN_A }),
    { kind: "agent", id: WREN_A },
  );
  assert.deepEqual(
    parseStoredIdentityRef({ kind: "person", name: "Dana" }),
    { kind: "person", name: "Dana" },
  );
  assert.equal(parseStoredIdentityRef({ kind: "agent" }), null);
  assert.equal(parseStoredIdentityRef({ id: WREN_A }), null);
});

test("the outgoing command names the UUID, not the display name", () => {
  const recipients = [{ kind: "agent", id: WREN_A }];
  const command = browserSignalCommand("please look", recipients, "ask");
  assert.deepEqual(command.to, [{ kind: "agent", id: WREN_A }]);
  assert.notEqual(command.to[0].id, "Wren");
  assert.equal(command.to_agent_principal_id, null);
});

test("create_agent_principal sends allow_duplicate_name only after an explicit choice", () => {
  const omitted = createAgentPrincipalCommand("echo");
  assert.equal(omitted.kind, "create_agent_principal");
  assert.equal(omitted.name, "echo");
  assert.equal(Object.hasOwn(omitted, ALLOW_DUPLICATE_NAME_FIELD), false);
  assert.doesNotMatch(JSON.stringify(omitted), /allow_duplicate_name/);

  const refused = createAgentPrincipalCommand("echo", undefined, false);
  assert.equal(Object.hasOwn(refused, ALLOW_DUPLICATE_NAME_FIELD), false);

  const allowed = createAgentPrincipalCommand("echo", undefined, true);
  assert.equal(allowed[ALLOW_DUPLICATE_NAME_FIELD], true);
  assert.match(JSON.stringify(allowed), /"allow_duplicate_name":true/);
  assert.equal(Object.keys(allowed).includes("model"), false);
});
