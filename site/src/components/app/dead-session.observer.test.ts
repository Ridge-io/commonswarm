import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const userId = "11111111-1111-4111-8111-111111111111";
const user = {
  id: userId,
  aud: "authenticated",
  role: "authenticated",
  email: "owner@example.com",
  email_confirmed_at: "2026-08-01T00:00:00.000Z",
  phone: "",
  confirmed_at: "2026-08-01T00:00:00.000Z",
  last_sign_in_at: "2026-08-01T00:00:00.000Z",
  app_metadata: { provider: "email", providers: ["email"] },
  user_metadata: {},
  identities: [],
  created_at: "2026-08-01T00:00:00.000Z",
  updated_at: "2026-08-01T00:00:00.000Z",
  is_anonymous: false,
};

const encode = (value: unknown): string =>
  Buffer.from(JSON.stringify(value)).toString("base64url");
const accessToken = [
  encode({ alg: "ES256", typ: "JWT" }),
  encode({
    aud: "authenticated",
    exp: Math.floor(Date.now() / 1_000) + 3_600,
    iat: Math.floor(Date.now() / 1_000),
    iss: "https://example.supabase.co/auth/v1",
    role: "authenticated",
    session_id: "22222222-2222-4222-8222-222222222222",
    sub: userId,
    email: user.email,
    user_metadata: {},
    app_metadata: user.app_metadata,
  }),
  encode({ signature: true }),
].join(".");

let userEndpointStatus = 200;
let commandStatus = 200;

Object.assign(globalThis, {
  document: {
    querySelector(selector: string) {
      if (selector.includes("commonswarm:url")) {
        return { content: "https://example.supabase.co" };
      }
      if (selector.includes("commonswarm:anon-key")) {
        return { content: "test-anon-key" };
      }
      return null;
    },
  },
  fetch: async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/auth/v1/user")) {
      return userEndpointStatus === 200
        ? Response.json(user)
        : Response.json(
            {
              code: 403,
              error_code: "session_not_found",
              msg: "Session from session_id claim in JWT does not exist",
            },
            { status: 403 },
          );
    }
    if (url.endsWith("/functions/v1/command")) {
      return commandStatus === 200
        ? Response.json({ status: "accepted" })
        : Response.json({ error: "unauthenticated" }, { status: commandStatus });
    }
    if (url.endsWith("/auth/v1/logout")) return new Response(null, { status: 204 });
    throw new Error(`Unexpected request: ${url}`);
  },
});

const commonswarm = await import("../../lib/commonswarm.ts");
const api = commonswarm.client();
assert.ok(api);

const dashboard = readFileSync(new URL("./LiveDashboard.astro", import.meta.url), "utf8");

const seedSession = async (): Promise<void> => {
  userEndpointStatus = 200;
  const { error } = await api.auth.setSession({
    access_token: accessToken,
    refresh_token: "test-refresh-token",
  });
  assert.equal(error, null);
};

test("QA-010 load rejects a locally persisted session missing on the server", async () => {
  await seedSession();
  userEndpointStatus = 403;

  let caught: unknown;
  try {
    await commonswarm.currentSession();
  } catch (error) {
    caught = error;
  }

  assert.equal((await api.auth.getSession()).data.session, null);
  assert.equal((caught as Error | undefined)?.name, "SessionExpired");
});

test("QA-010 command 401 clears the session and requests re-authentication", async () => {
  await seedSession();
  userEndpointStatus = 200;
  commandStatus = 401;
  const session = await commonswarm.currentSession();
  assert.ok(session);

  let caught: unknown;
  try {
    await commonswarm.inviteWorkspaceMember(
      session,
      "33333333-3333-4333-8333-333333333333",
      "44444444-4444-4444-8444-444444444444",
      "teammate@example.com",
    );
  } catch (error) {
    caught = error;
  }

  assert.equal((await api.auth.getSession()).data.session, null);
  assert.equal((caught as Error | undefined)?.name, "SessionExpired");
  assert.match((caught as Error).message, /session expired.*sign in again/i);
});

test("QA-010 invite email validation distinguishes input errors from auth", () => {
  assert.equal(typeof commonswarm.inviteEmailValidationMessage, "function");
  assert.match(commonswarm.inviteEmailValidationMessage(""), /email/i);
  assert.match(commonswarm.inviteEmailValidationMessage("not-an-email"), /valid email/i);
  assert.equal(commonswarm.inviteEmailValidationMessage("teammate@example.com"), null);
  assert.notEqual(
    commonswarm.inviteEmailValidationMessage(""),
    "CommonSwarm did not create the invitation (unauthenticated).",
  );
});

test("QA-010 dashboard renders an expired session as signed out with a re-auth prompt", () => {
  assert.match(
    dashboard,
    /error instanceof SessionExpired[\s\S]*?session = null;[\s\S]*?showPanel\("signed-out"\);[\s\S]*?authError\(error\.message\)/,
  );
});

test("QA-010 invite form routes empty and malformed input through the validator", () => {
  assert.match(dashboard, /<form class="dashboard__invite-form" data-invite-form novalidate>/);
  assert.match(
    dashboard,
    /const emailValidationMessage = inviteEmailValidationMessage\(email\);[\s\S]*?if \(emailValidationMessage\)[\s\S]*?error\.textContent = emailValidationMessage/,
  );
});
