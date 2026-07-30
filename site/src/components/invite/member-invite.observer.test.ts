import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  assertInviteDeployment,
  decodeMemberInvite,
  encodeMemberInvite,
  forgetInvite,
  memberInviteUrl,
  recalledInvite,
  rememberInvite,
  type MemberInvitePayload,
} from "../../lib/member-invite";

const payload: MemberInvitePayload = {
  v: 1,
  url: "https://example.supabase.co",
  anon_key: "public-anon-key",
  workspace_id: "3ab184b3-fbb4-5ee9-afad-3842a604439a",
  invitation_token: `swm_inv_${"A".repeat(43)}`,
  workspace_name: "Dogfood Workspace",
  inviter_display_name: "Calvin",
  inviter_user_id: "d37e2ff2-2efb-4bdc-b8fb-176ce4bfccbc",
};

class MemoryStorage implements Storage {
  readonly values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

test("invite payload is strict, canonical, and fragment-only", () => {
  const encoded = encodeMemberInvite(payload);
  assert.deepEqual(decodeMemberInvite(encoded), payload);
  const link = memberInviteUrl("https://commonswarm.com/app", payload);
  const parsed = new URL(link);
  assert.equal(parsed.pathname, "/invite");
  assert.equal(parsed.search, "");
  assert.equal(parsed.hash, `#invite=${encoded}`);
  assert.equal(parsed.href.includes(payload.invitation_token), false);
  assert.throws(() => decodeMemberInvite(`${encoded}=`), /strict base64url/);
  assert.throws(
    () => decodeMemberInvite(`${encoded.slice(0, -1)}!`),
    /strict base64url/,
  );
});

test("invite target is pinned and auth resume storage is erasable", () => {
  assert.doesNotThrow(() =>
    assertInviteDeployment(payload, {
      url: payload.url,
      anonKey: payload.anon_key,
    })
  );
  assert.throws(
    () =>
      assertInviteDeployment(payload, {
        url: "https://other.supabase.co",
        anonKey: payload.anon_key,
      }),
    /different CommonSwarm deployment/,
  );
  const storage = new MemoryStorage();
  const id = "b3e91444-100f-494f-8784-eb1d01fb17e0";
  rememberInvite(payload, storage, id);
  assert.deepEqual(recalledInvite(id, storage), payload);
  forgetInvite(id, storage);
  assert.equal(recalledInvite(id, storage), null);
});

test("/invite specifies the complete first-time recipient journey", async () => {
  const source = await readFile(new URL("./InviteOnramp.astro", import.meta.url), "utf8");
  assert.match(source, /A teammate<\/span> invited you to/);
  assert.match(source, /Sign in[\s\S]*Join the workspace[\s\S]*Copy one prompt/);
  assert.match(source, /payload\.inviter_user_id === session\.user\.id/);
  assert.match(source, /acceptWorkspaceInvitation/);
  assert.match(source, /forgetInvite/);
  assert.match(source, /history\.replaceState/);
  assert.match(
    source,
    /if \(encoded\) \{\s*history\.replaceState\(null, "", new URL\("\/invite"/,
  );
  assert.match(source, /error instanceof CommandOutcomeUnknown/);
  assert.match(source, /data-retry-join/);
  assert.match(source, /<AgentConnect/);
  assert.doesNotMatch(source, /searchParams\.set\([^,]+,\s*payload\.invitation_token/);
  assert.doesNotMatch(source, /innerHTML/);
});
