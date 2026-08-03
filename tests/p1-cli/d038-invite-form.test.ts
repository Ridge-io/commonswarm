import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import {
  decodeInviteLink,
  encodeInviteLink,
  parseAcceptPositional,
  type InviteLinkPayload,
} from "../../src/cloud/invite-link.js";

function payload(): InviteLinkPayload {
  return {
    v: 1,
    url: "http://127.0.0.1:54321",
    anon_key: "local-anon-key",
    workspace_id: randomUUID(),
    invitation_token: `swm_inv_${randomBytes(32).toString("base64url")}`,
    workspace_name: "Design swarm",
    inviter_display_name: "Taylor",
    inviter_user_id: randomUUID(),
  };
}

function forms(value: InviteLinkPayload): {
  cli: string;
  web: string;
  encoded: string;
} {
  const cli = encodeInviteLink(value);
  const encoded = cli.slice("cswarm://accept/".length);
  return {
    cli,
    web: `https://commonswarm.com/invite#invite=${encoded}`,
    encoded,
  };
}

test("D-038: 1 exact product web form decodes like the CLI form", () => {
  const original = payload();
  const { cli, web, encoded } = forms(original);
  assert.deepEqual(decodeInviteLink(web), decodeInviteLink(cli));
  assert.deepEqual(
    decodeInviteLink(`https://untrusted.example/anything#invite=${encoded}`),
    original,
  );
});

test("D-038: 2 current cswarm wrapper remains accepted beside the web form", () => {
  const original = payload();
  const { cli, web } = forms(original);
  assert.deepEqual(parseAcceptPositional(cli), parseAcceptPositional(web));
});

test("D-038: 3 bare invitation capability remains accepted beside the web form", () => {
  const original = payload();
  const { web } = forms(original);
  assert.deepEqual(parseAcceptPositional(original.invitation_token), {
    mode: "token",
    token: original.invitation_token,
  });
  assert.deepEqual(parseAcceptPositional(web), {
    mode: "link",
    payload: original,
  });
});

test("D-038: 4 retired coswarm wrapper is a compatibility alias", () => {
  const original = payload();
  const { encoded } = forms(original);
  assert.deepEqual(decodeInviteLink(`coswarm://accept/${encoded}`), original);
});

test("D-038: 5 malformed payload in a web wrapper keeps strict base64url validation", () => {
  const original = payload();
  const { web, encoded } = forms(original);
  assert.deepEqual(decodeInviteLink(web), original);
  assert.throws(
    () => decodeInviteLink("https://commonswarm.com/invite#invite=abc="),
    /invite link payload must be strict unpadded base64url/,
  );
  const escapedFirstCharacter = `%${encoded[0]!.charCodeAt(0).toString(16)}`;
  assert.throws(
    () => decodeInviteLink(
      `https://commonswarm.com/invite#invite=${escapedFirstCharacter}${encoded.slice(1)}`,
    ),
    /invite link payload must be strict unpadded base64url/,
  );
});

test("D-038: 6 unrecognized wrapper is not blamed on payload encoding", () => {
  assert.throws(
    () => decodeInviteLink("https://commonswarm.com/invite#other=value"),
    /invite link wrapper is not recognized/,
  );
  assert.throws(
    () => decodeInviteLink("not an invite"),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, /payload must be strict unpadded base64url/);
      return true;
    },
  );
  assert.throws(
    () => parseAcceptPositional("not an invite"),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /accept input was not recognized/);
      assert.doesNotMatch(error.message, /payload must be strict unpadded base64url/);
      return true;
    },
  );
});
