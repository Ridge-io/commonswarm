/*
 * The one list of OAuth sign-in providers.
 *
 * WHY A MODULE FOR THREE STRINGS. AGENTS.md records four measured releases (v0.1.48-v0.1.50)
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
 * WHAT IS ENABLED IS A DEPLOYMENT FACT, NOT A CODE FACT. `AUTH_PROVIDERS` is everything the
 * code can render. `enabledProviders()` decides what THIS build renders, from the
 * PUBLIC_SWARM_AUTH_PROVIDERS build variable. A provider must be turned on in the Supabase
 * dashboard as well; a button whose provider is off in GoTrue returns
 * "Unsupported provider: provider is not enabled", which is why the two are flipped in the
 * order given in docs/design/2026-09-04-GOOGLE-SIGNIN.md.
 */

/** Every provider this code can render. Add here or the button cannot exist. */
export interface AuthProvider {
  /** The literal string GoTrue accepts as `provider`. */
  readonly id: "github" | "google";
  /** The whole button label. Never rebuild this from `name` at a call site. */
  readonly label: string;
  /** The provider's name on its own, for sentences that list the choices. */
  readonly name: string;
}

export const AUTH_PROVIDERS: readonly AuthProvider[] = Object.freeze([
  Object.freeze({ id: "github", label: "Sign in with GitHub", name: "GitHub" }),
  Object.freeze({ id: "google", label: "Sign in with Google", name: "Google" }),
]) as readonly AuthProvider[];

export type AuthProviderId = AuthProvider["id"];

/**
 * What a build renders when PUBLIC_SWARM_AUTH_PROVIDERS is unset.
 *
 * GitHub only, which is what the deployment actually has: `/auth/v1/settings` on
 * https://api.commonswarm.com reported `"github":true,"google":false` on 2026-09-04. The
 * default is the measured state, not an aspiration, so a build with no configuration cannot
 * offer a door that is shut.
 */
export const DEFAULT_AUTH_PROVIDER_IDS: readonly AuthProviderId[] = Object.freeze([
  "github",
]) as readonly AuthProviderId[];

/** The build variable that opens a provider. Named once so tests and docs cannot drift. */
export const AUTH_PROVIDERS_ENV_VAR = "PUBLIC_SWARM_AUTH_PROVIDERS";

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

/** Look one up, or fail loudly. This is the enforcement every sign-in call must pass. */
export function authProvider(id: string): AuthProvider {
  const found = AUTH_PROVIDERS.find((provider) => provider.id === id);
  if (!found) throw new UnknownAuthProvider(id);
  return found;
}

/**
 * The providers THIS build renders, in AUTH_PROVIDERS order so the button order is stable.
 *
 * `setting` is the raw PUBLIC_SWARM_AUTH_PROVIDERS value: a comma-separated list of ids.
 * Empty or absent means the default. An id the code does not know is dropped rather than
 * thrown, because a build variable is operator input and a typo must not blank the sign-in
 * page — but a typo that removes every known id falls back to the default rather than
 * rendering nothing.
 */
export function enabledProviders(setting: string | null | undefined): readonly AuthProvider[] {
  const requested = (setting ?? "")
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length > 0);
  const known = requested.filter((id): id is AuthProviderId =>
    AUTH_PROVIDERS.some((provider) => provider.id === id),
  );
  const ids: readonly AuthProviderId[] = known.length > 0 ? known : DEFAULT_AUTH_PROVIDER_IDS;
  return AUTH_PROVIDERS.filter((provider) => ids.includes(provider.id));
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
