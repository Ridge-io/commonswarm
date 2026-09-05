/*
 * The one list of OAuth sign-in providers, and the one place that decides which of them a
 * build renders.
 *
 * WHY A MODULE FOR TWO STRINGS. AGENTS.md records four measured releases (v0.1.48-v0.1.50)
 * where a user-facing sentence enumerated something the code enforces — required fields, a
 * login verb, a delivery outcome — and drifted from the enforcement, each time AFTER two
 * review arms passed. A typed list inside a correct-looking sentence is a claim with no
 * control on it. So: the button labels, any sentence that names the providers, and the
 * enforcement that decides which `provider` string reaches Supabase all read THIS array.
 * Nothing else may name a provider in a string literal.
 *
 * THE ID IS THE SUPABASE PROVIDER STRING ON PURPOSE. GoTrue takes `provider=github` and
 * `provider=google` verbatim (measured 2026-09-04 against https://api.commonswarm.com — see
 * `/auth/v1/settings`, which enumerates every provider GoTrue knows). Keeping one field
 * removes the chance of a mapping table disagreeing with the labels beside it.
 *
 * WHAT IS ENABLED IS THE DEPLOYMENT'S ANSWER, NOT OURS. `AUTH_PROVIDERS` is everything the
 * code can render. Which of them a build actually renders is read from GoTrue's own
 * `/auth/v1/settings`, so a button can exist only if the deployment it points at reports that
 * provider as enabled. There is no flag to set, and therefore no way to publish a button that
 * leads to "Unsupported provider: provider is not enabled". See
 * docs/design/2026-09-04-GOOGLE-SIGNIN.md.
 *
 * RETIRED 2026-09-04, kept here because the design doc and the first commit message name it:
 * an earlier draft chose the rendered set from a `PUBLIC_SWARM_AUTH_PROVIDERS` build
 * variable. That is a hand-set flag; it let an operator publish a button for a provider that
 * was still off in the dashboard, and the reader of that button got raw JSON. The variable is
 * gone and nothing reads it.
 */

/*
 * THE ONE PLACE A PROVIDER IS NAMED. Everything below is derived from it, including the id
 * type: writing that union by hand would be a second list, and a second list drifts.
 */
const PROVIDERS = [
  { id: "github", label: "Sign in with GitHub", name: "GitHub" },
  { id: "google", label: "Sign in with Google", name: "Google" },
] as const;

/** The literal strings GoTrue accepts as `provider`, read off the array above. */
export type AuthProviderId = (typeof PROVIDERS)[number]["id"];

export interface AuthProvider {
  /** The literal string GoTrue accepts as `provider`. */
  readonly id: AuthProviderId;
  /** The whole button label. Never rebuild this from `name` at a call site. */
  readonly label: string;
  /** The provider's name on its own, for sentences that list the choices. */
  readonly name: string;
}

/** Every provider this code can render. Add to PROVIDERS or the button cannot exist. */
export const AUTH_PROVIDERS: readonly AuthProvider[] = Object.freeze(
  PROVIDERS.map((provider) => Object.freeze({ ...provider })),
) as readonly AuthProvider[];

/** GoTrue's own report of what it will accept. Named once so docs and tests cannot drift. */
export const AUTH_SETTINGS_PATH = "/auth/v1/settings";

/** How long a build waits for that answer before it gives up and fails loudly. */
export const AUTH_SETTINGS_TIMEOUT_MS = 10_000;

/** A provider string nothing in AUTH_PROVIDERS names. Never sent to Supabase. */
export class UnknownAuthProvider extends Error {
  override name = "UnknownAuthProvider";
  constructor(readonly requested: string) {
    super(
      `CommonSwarm has no sign-in provider called "${requested}". ` +
        `It knows ${listSentence(AUTH_PROVIDERS.map((provider) => provider.name))}.`,
    );
  }
}

/**
 * The deployment could not be asked which providers are enabled.
 *
 * This FAILS THE BUILD on purpose. The alternative is to guess a provider list and publish
 * it, which is the whole failure this module exists to prevent: a guessed list is a claim
 * with no control on it. A sign-in page whose doors cannot be confirmed is not published.
 */
export class AuthSettingsUnreadable extends Error {
  override name = "AuthSettingsUnreadable";
  /** The HTTP status, when there was one. A caller classifies on this, never on the prose. */
  readonly status?: number;
  constructor(
    readonly endpoint: string,
    readonly reason: string,
    options?: { cause?: unknown; status?: number },
  ) {
    super(
      `CommonSwarm could not read the sign-in providers from ${endpoint}: ${reason}. ` +
        `The build stops here rather than guess which sign-in buttons to publish. ` +
        `Check PUBLIC_SUPABASE_URL and PUBLIC_SUPABASE_ANON_KEY in site/.env, confirm the ` +
        `deployment answers ` +
        `\`curl -s -H "apikey: <anon key>" <PUBLIC_SUPABASE_URL>${AUTH_SETTINGS_PATH}\`, ` +
        `then build again.`,
      options,
    );
    this.status = options?.status;
  }
}

/** Look one up, or fail loudly. This is the enforcement every sign-in call must pass. */
export function authProvider(id: string): AuthProvider {
  const found = AUTH_PROVIDERS.find((provider) => provider.id === id);
  if (!found) throw new UnknownAuthProvider(id);
  return found;
}

/**
 * Read GoTrue's `/auth/v1/settings` body and return the providers it reports as enabled.
 *
 * Pure, so the decision can be exercised without a network: the shapes below are the ones the
 * live API returned on 2026-09-04, including `"google":false`.
 *
 * The body must carry a REAL BOOLEAN for every id in AUTH_PROVIDERS, and a provider is
 * rendered only when its flag is exactly `true`. A missing key, the string `"true"`, a `1` or
 * a `null` is not GoTrue answering this question, so it fails loudly rather than being read as
 * "shut": reading a body we do not understand as "every door is closed" is how a working door
 * goes missing with no error anywhere. Order follows AUTH_PROVIDERS so the buttons never
 * reorder themselves.
 *
 * The set is an INTERSECTION. A provider GoTrue enables that AUTH_PROVIDERS does not name gets
 * no button, because there is no label for it here. The direction that matters is closed:
 * nothing the deployment reports as off can be rendered.
 */
export function providersFromSettings(body: unknown): readonly AuthProvider[] {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new AuthSettingsUnreadable(AUTH_SETTINGS_PATH, "the response was not a JSON object");
  }
  const external = (body as { external?: unknown }).external;
  if (typeof external !== "object" || external === null || Array.isArray(external)) {
    throw new AuthSettingsUnreadable(
      AUTH_SETTINGS_PATH,
      'the response has no "external" object, so it is not a GoTrue settings body',
    );
  }
  const flags = external as Record<string, unknown>;
  /*
   * GoTrue reports EVERY provider it knows as a real boolean — 26 keys on
   * https://api.commonswarm.com on 2026-09-04, most of them false. So a settings body always
   * carries a boolean for each id in AUTH_PROVIDERS, and a body that does not is a truncated
   * read, a proxy page that happens to be JSON, or a different API. Returning an empty door
   * list from it would be a guess wearing a success, so it fails the way an unreachable host
   * does. The names checked come from AUTH_PROVIDERS, so this cannot drift from the array.
   */
  const missing = AUTH_PROVIDERS.filter((provider) => typeof flags[provider.id] !== "boolean");
  if (missing.length > 0) {
    throw new AuthSettingsUnreadable(
      AUTH_SETTINGS_PATH,
      `its "external" object has no boolean for ` +
        `${listSentence(missing.map((provider) => provider.id))}, so it is not an answer about ` +
        `the providers this site can render`,
    );
  }
  return AUTH_PROVIDERS.filter((provider) => flags[provider.id] === true);
}

/**
 * Ask a deployment which OAuth providers it has enabled.
 *
 * `fetchImpl` exists so tests drive every branch — 200 with Google off, 200 with Google on,
 * 401, a body that is not settings, and a transport failure — without a network. Nothing but
 * a test passes it.
 */
export async function fetchEnabledProviders(options: {
  readonly url: string;
  readonly anonKey: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}): Promise<readonly AuthProvider[]> {
  const endpoint = new URL(AUTH_SETTINGS_PATH, options.url).href;
  const call = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await call(endpoint, {
      headers: { apikey: options.anonKey, Authorization: `Bearer ${options.anonKey}` },
      signal: AbortSignal.timeout(options.timeoutMs ?? AUTH_SETTINGS_TIMEOUT_MS),
    });
  } catch (caught) {
    throw new AuthSettingsUnreadable(endpoint, describe(caught), { cause: caught });
  }
  if (!response.ok) {
    throw new AuthSettingsUnreadable(endpoint, `it answered HTTP ${response.status}`, {
      status: response.status,
    });
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch (caught) {
    throw new AuthSettingsUnreadable(endpoint, "the response was not JSON", { cause: caught });
  }
  try {
    return providersFromSettings(body);
  } catch (caught) {
    if (caught instanceof AuthSettingsUnreadable) {
      throw new AuthSettingsUnreadable(endpoint, caught.reason, { cause: caught });
    }
    throw caught;
  }
}

/**
 * What THIS build renders, decided from the two PUBLIC_SUPABASE_ values and nothing else.
 *
 * Three inputs, three outcomes, and the middle one is the reason this function exists:
 *
 * - **Neither set.** No OAuth buttons, build succeeds. astro.config.mjs requires that build to
 *   work: it is the honest "not pointed at a backend" site, and there is nothing to sign in to.
 * - **Exactly one set.** The build FAILS. A half-configured deployment is a typo, not a state:
 *   treating it like "no backend" would publish an email-only sign-in page that looks finished,
 *   and the operator would have no way to tell that from the state above.
 * - **Both set.** The deployment is asked, and its answer is the button list.
 */
export async function enabledProvidersForBuild(options: {
  readonly url: string | undefined;
  readonly anonKey: string | undefined;
  readonly fetchImpl?: typeof fetch;
}): Promise<readonly AuthProvider[]> {
  const url = options.url?.trim() ?? "";
  const anonKey = options.anonKey?.trim() ?? "";
  if (!url && !anonKey) return [];
  if (!url || !anonKey) {
    const missing = url ? "PUBLIC_SUPABASE_ANON_KEY" : "PUBLIC_SUPABASE_URL";
    const present = url ? "PUBLIC_SUPABASE_URL" : "PUBLIC_SUPABASE_ANON_KEY";
    throw new AuthSettingsUnreadable(
      url || AUTH_SETTINGS_PATH,
      `${present} is set but ${missing} is empty, so the deployment cannot be asked which ` +
        `sign-in providers it has enabled. Set both in site/.env, or neither`,
    );
  }
  return fetchEnabledProviders({ url, anonKey, fetchImpl: options.fetchImpl });
}

function describe(caught: unknown): string {
  if (caught instanceof Error && caught.name === "TimeoutError") return "it did not answer in time";
  if (caught instanceof Error) return `the request failed (${caught.name})`;
  return "the request failed";
}

/** "GitHub", "GitHub or Google", "GitHub, Google, or X" — an Oxford comma list. */
export function listSentence(items: readonly string[]): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0] as string;
  if (items.length === 2) return `${items[0]} or ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, or ${items[items.length - 1]}`;
}

/**
 * The provider names for a sentence, e.g. "Sign in with ${providerChoices(...)} instead."
 * Every user-facing sentence that names a provider must be built through this.
 */
export function providerChoices(providers: readonly AuthProvider[]): string {
  return listSentence(providers.map((provider) => provider.name));
}
