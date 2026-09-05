/*
 * Controls on the provider list.
 *
 * The load-bearing one is "the rendered buttons and the provider list agree". AGENTS.md
 * records four releases in a row (v0.1.48-v0.1.50) where a user-facing enumeration drifted
 * from the enforcement AFTER two review arms passed, because reading such a sentence means
 * re-deriving the enforcement by hand. These tests do that re-derivation mechanically.
 *
 * THEY MEASURE THE BUILT HTML, NOT THE TEMPLATE. A template that loops over the array proves
 * nothing on its own — a hand-written extra button beside the loop would still render. The
 * dist file is the artifact a visitor receives, so that is what is compared against the
 * array. Run `npm run build` in site/ first; without it these fail for the wrong reason, and
 * the first test says so.
 *
 * WHAT THESE CONTROLS DO NOT REACH. Which providers a build renders is read from the
 * deployment's own /auth/v1/settings at build time, so the built page and the deployment
 * agree by construction. Re-checking that agreement here would measure the network, not the
 * code, so it is a deploy step instead — docs/design/2026-09-04-GOOGLE-SIGNIN.md carries the
 * curl with its positive control. What runs here is offline: the decision function against
 * recorded GoTrue bodies, and the rendering against the constant.
 */
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  AUTH_PROVIDERS,
  AUTH_SETTINGS_PATH,
  AuthSettingsUnreadable,
  UnknownAuthProvider,
  authProvider,
  enabledProvidersForBuild,
  fetchEnabledProviders,
  listSentence,
  providerChoices,
  providersFromSettings,
} from "../../lib/auth-providers.js";

const INVITE_HTML = new URL("../../../dist/invite/index.html", import.meta.url);
const COMMONSWARM = new URL("../../lib/commonswarm.ts", import.meta.url);
const ONRAMP = new URL("../invite/InviteOnramp.astro", import.meta.url);
const BUTTONS = new URL("./ProviderButtons.astro", import.meta.url);
const SRC = new URL("../../", import.meta.url);
const DIST = new URL("../../../dist/", import.meta.url);

/*
 * The sign-in buttons are generated. The SENTENCES around them, on the landing page, the
 * privacy policy, the terms, and /app, are hand-written and name GitHub. They are true while
 * GitHub is the only door and false the day a second one opens, which is the drift AGENTS.md
 * records four times. The control below reads them out of the BUILT site, so nobody has to
 * remember they exist.
 */
const SIGNIN_WORDS = /\bsign(?:ing|ed)?[ -]?(?:in|up)\b|\blog[ -]?in\b/i;

/*
 * Where one claim ends and the next begins. Block ends close a unit; inline tags do not, so
 * `Sign in with <a>GitHub</a>` and `<strong>GitHub</strong>` stay inside their sentence.
 *
 * `</a>` is deliberately NOT here. It was, and it split exactly the sentences this control is
 * for. The footer case it was added for — "Sign up", "Log in", and a "GitHub" repo link, three
 * separate links — is handled by `</li>` and `</div>`, which already close each one. Measured:
 * with `</a>` gone, the sweep is still green today and still names all eight sentences against
 * a build that renders Google.
 */
const UNIT_END = /<\/(?:p|li|h[1-6]|div|button|td|th|option|label|figcaption|blockquote|nav|section|footer)>|<br\s*\/?>/gi;

/*
 * The copy a reader meets that is not in the page body: the meta description and the Open
 * Graph description, which are what a search result and a shared link show. privacy.astro's
 * says "Sign-in comes from GitHub" and lives in an attribute, so tag-stripping loses it.
 */
const META_COPY = /<meta[^>]*(?:name="description"|property="og:description"|name="twitter:description")[^>]*content="([^"]*)"/gi;

/** Every .html file the build produced, so the sweep cannot miss a page someone added. */
async function builtPages(dir: URL = DIST): Promise<URL[]> {
  const found: URL[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const child = new URL(entry.name + (entry.isDirectory() ? "/" : ""), dir);
    if (entry.isDirectory()) found.push(...(await builtPages(child)));
    else if (entry.name.endsWith(".html")) found.push(child);
  }
  return found;
}

/**
 * The words a reader sees: script and style bodies dropped, tags removed, entities decoded.
 *
 * Attribute values go with the tags on purpose. `apple-touch-icon` is in the markup of every
 * page here, so a raw-HTML scan for a provider name would go red for a provider that appears
 * nowhere a reader can see it. That is a control failing for a reason it does not claim.
 */
function decode(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, " ");
}

function copyOf(html: string): string {
  return decode(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  ).replace(/\s+/g, " ");
}

/** The page's copy cut into one claim per unit: block ends first, then sentence punctuation. */
function copyUnits(html: string): string[] {
  return decode(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(UNIT_END, "\u0000")
      .replace(/<[^>]+>/g, " "),
  )
    .split("\u0000")
    .flatMap((chunk) => chunk.split(/(?<=[.!?])\s+/))
    .concat(metaCopyUnits(html))
    .map((unit) => unit.replace(/\s+/g, " ").trim())
    .filter((unit) => unit.length > 0);
}

/** The description attributes on their own, so the sweep can prove it read them. */
function metaCopyUnits(html: string): string[] {
  return [...html.matchAll(META_COPY)]
    .flatMap((match) => decode(match[1] ?? "").split(/(?<=[.!?])\s+/))
    .map((unit) => unit.replace(/\s+/g, " ").trim())
    .filter((unit) => unit.length > 0);
}

/*
 * The live body, copied byte for byte from
 * `curl -H "apikey: <anon>" https://api.commonswarm.com/auth/v1/settings` on 2026-09-04.
 * Trimmed to the keys these tests read; `google:false` is the state that day.
 */
const LIVE_SETTINGS = {
  external: {
    anonymous_users: false,
    apple: false,
    github: true,
    gitlab: false,
    google: false,
    email: true,
    phone: false,
  },
  disable_signup: false,
};

async function inviteHtml(): Promise<string> {
  try {
    return await readFile(INVITE_HTML, "utf8");
  } catch {
    assert.fail(
      `dist/invite/index.html is missing. Run \`npm run build\` in site/ before this suite; ` +
        `these controls compare the array against BUILT output, not the template.`,
    );
  }
}

function renderedProviderIds(html: string): string[] {
  return [...html.matchAll(/data-signin-provider="([^"]+)"/g)]
    .map((match) => match[1] as string)
    .sort();
}

/** File types that can carry markup or DOM code, and are therefore scanned. */
const SCANNED_EXTENSIONS = ["astro", "mjs", "ts"];
/** File types that cannot carry a button, listed so the coverage check below is complete. */
const UNSCANNABLE_EXTENSIONS = ["css"];

/**
 * Surfaces that write their own sign-in button instead of rendering ProviderButtons, and HOW
 * MANY they are allowed to write.
 *
 * This is known debt, written down so it cannot be mistaken for coverage. `/app` predates the
 * component and belongs to another lane, so it still hand-writes one `data-signin-github`
 * button. The count is the point: skipping the whole file would let a SECOND hand-written
 * control appear there and never trip the sweep. The control also asserts the file still
 * exists and still matches, so a rename or a cleanup cannot quietly retire the exception.
 */
const UNGENERATED_SIGNIN_SURFACES = new Map([["components/app/LiveDashboard.astro", 1]]);

async function sourceFiles(dir: URL): Promise<URL[]> {
  const found: URL[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const child = new URL(entry.name + (entry.isDirectory() ? "/" : ""), dir);
    if (entry.isDirectory()) found.push(...(await sourceFiles(child)));
    // Templates and runtime modules only. A control that scans the controls would match its
    // own regex, which is a failure with nothing behind it.
    else if (
      SCANNED_EXTENSIONS.some((ext) => entry.name.endsWith(`.${ext}`)) &&
      !/\.(test\.ts|observer\.(mjs|ts))$/.test(entry.name)
    )
      found.push(child);
  }
  return found;
}

async function allSourceExtensions(dir: URL): Promise<Set<string>> {
  const found = new Set<string>();
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      for (const ext of await allSourceExtensions(new URL(entry.name + "/", dir))) found.add(ext);
    } else {
      const dot = entry.name.lastIndexOf(".");
      if (dot > 0) found.add(entry.name.slice(dot + 1));
    }
  }
  return found;
}

test("CONTROL: every rendered sign-in button is a provider the constant names", async () => {
  const html = await inviteHtml();
  const rendered = renderedProviderIds(html);
  const known = AUTH_PROVIDERS.map((provider) => provider.id);
  for (const id of rendered) {
    assert.ok(
      known.includes(id as (typeof known)[number]),
      `The invite page renders a "${id}" button, which AUTH_PROVIDERS does not name. ` +
        `signInWithProvider would refuse that id, so the button is a door nobody can open.`,
    );
  }
  assert.ok(
    rendered.length > 0,
    `The invite page offers no OAuth provider. This suite builds with site/.env, so the ` +
      `deployment named by PUBLIC_SUPABASE_URL reported no enabled provider at build time.`,
  );
});

test("CONTROL: every button label is the label the constant carries, character for character", async () => {
  const html = await inviteHtml();
  for (const id of renderedProviderIds(html)) {
    const provider = authProvider(id);
    const button = new RegExp(
      `<button[^>]*data-signin-provider="${provider.id}"[^>]*>\\s*` +
        `${provider.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*</button>`,
    );
    assert.match(
      html,
      button,
      `The ${provider.id} button must read exactly "${provider.label}" — the label in ` +
        `auth-providers.ts. A hand-typed label is an enumeration with no control on it.`,
    );
  }
});

test("CONTROL: sign-in copy names the providers this build renders, or none", async () => {
  /*
   * The failure this catches, in order: an operator turns Google on in the Supabase dashboard,
   * some lane deploys the site for an unrelated reason, and the invite page grows a Google
   * button while the privacy policy still says "You sign in with GitHub". Nothing in the repo
   * would have noticed. This does, in both directions: a page that names a provider with no
   * button is caught by the same comparison.
   *
   * IT READS SIGN-IN CLAIMS, NOT EVERY MENTION. An earlier version compared provider names
   * against the whole page. It would have gone red on the footer's "GitHub" repo link the day
   * GitHub was disabled, and on `apple-touch-icon` if Apple were ever added — controls failing
   * for a reason they do not claim, which is the defect this suite exists to prevent.
   *
   * WHAT IT CANNOT SEE. A sentence that names no provider is invisible to it, so
   * privacy.astro's "Three, and only three, are in the path:" processor count and
   * acceptable-use.astro's "additional GitHub accounts" stay green; step 6 of
   * docs/design/2026-09-04-GOOGLE-SIGNIN.md names them by hand. Meta descriptions ARE read
   * (privacy's says "Sign-in comes from GitHub"), because that is what a search result shows. Copy built in JavaScript
   * rather than rendered into the page is invisible too — LiveDashboard's "Use GitHub, or try
   * email again in a little while." is the measured instance. And AUTH_PROVIDERS ships whole
   * in the bundle the invite page downloads, because authProvider() is the enforcement and it
   * runs in the browser; a provider with no button IS named in that JavaScript, by design.
   *
   * The generated buttons are removed first: each one names exactly one provider, which is
   * correct for a button and wrong for a sentence.
   */
  const invite = await inviteHtml();
  const rendered = renderedProviderIds(invite).map((id) => authProvider(id).name).sort();
  const offenders: string[] = [];
  let inspected = 0;
  let named = 0;
  let fromMeta = 0;
  let splitByTags = 0;
  for (const page of await builtPages()) {
    // Any element the component generates, not just <button>: if it ever renders an <a>, a
    // strip that only knew about buttons would flag the generated label as hand-written copy.
    const html = (await readFile(page, "utf8"))
      .replace(/<([a-z]+)[^>]*data-signin-provider=[\s\S]*?<\/\1>/g, " ")
      .replace(/<[a-z]+[^>]*data-signin-provider=[^>]*\/>/g, " ");
    for (const unit of metaCopyUnits(html)) {
      if (SIGNIN_WORDS.test(unit)) fromMeta += 1;
    }
    // Punctuation alone would leave a whole nav block as one "sentence", which is how the
    // footer's three separate links once read as one claim about signing up with GitHub.
    // More units than punctuation gives is the proof that UNIT_END is still cutting.
    const byPunctuation = copyOf(html).split(/(?<=[.!?])\s+/).filter((unit) => unit.trim()).length;
    // Body units only. Counting the meta units in here would hide a dead UNIT_END, because
    // the concatenated descriptions alone push the total above the punctuation count.
    const fromBody = copyUnits(html).length - metaCopyUnits(html).length;
    if (fromBody > byPunctuation) splitByTags += 1;
    for (const unit of copyUnits(html)) {
      if (!SIGNIN_WORDS.test(unit)) continue;
      inspected += 1;
      const namedHere = AUTH_PROVIDERS.filter((provider) =>
        new RegExp(`\\b${provider.name}\\b`, "i").test(unit),
      )
        .map((provider) => provider.name)
        .sort();
      if (namedHere.length === 0) continue;
      named += 1;
      const namedList = namedHere;
      if (namedList.join(",") !== rendered.join(",")) {
        const page_ = page.pathname.slice(page.pathname.indexOf("/dist/") + 5);
        offenders.push(`${page_}: names [${namedList.join(", ")}] in "${unit}"`);
      }
    }
  }
  /*
   * The pin on the sweep itself. Every assertion above is "no offenders", which a broken
   * regex satisfies by reading nothing at all: if SIGNIN_WORDS, UNIT_END, or the meta
   * extractor ever stopped matching, this control would go quietly green and defend nothing.
   * So it also has to prove it read real sign-in copy that names real providers.
   */
  assert.ok(
    inspected >= 10 && named >= 3 && fromMeta >= 1 && splitByTags >= 3,
    `The sweep read ${inspected} sign-in sentences, ${named} of which name a provider, and ` +
      `${fromMeta} of them out of a meta description, and ${splitByTags} pages were cut into ` +
      `more units by their tags than by punctuation alone. Those numbers are too low to ` +
      `believe it is reading the site: the built pages say "You sign in with GitHub" in the ` +
      `body, privacy's description says "Sign-in comes from GitHub" in an attribute, and every ` +
      `page has a nav that punctuation cannot cut. Check SIGNIN_WORDS, UNIT_END, META_COPY, ` +
      `and the button strip before trusting the empty offender list below.`,
  );

  assert.deepEqual(
    offenders,
    [],
    `This build renders [${rendered.join(", ")}], but these hand-written sentences name a ` +
      `different set. Every one of them has to be rewritten before the new provider is ` +
      `enabled, and the checklist in docs/design/2026-09-04-GOOGLE-SIGNIN.md is where that ` +
      `step lives:\n  ${offenders.join("\n  ")}`,
  );
});

test("CONTROL: the enforcement accepts every rendered id and refuses anything else", async () => {
  const html = await inviteHtml();
  for (const id of renderedProviderIds(html)) {
    assert.doesNotThrow(
      () => authProvider(id),
      `The page renders a ${id} button but signInWithProvider would refuse that id.`,
    );
  }
  assert.throws(() => authProvider("facebook"), UnknownAuthProvider);
  assert.throws(() => authProvider(""), UnknownAuthProvider);
  assert.throws(() => authProvider("GitHub"), UnknownAuthProvider);
});

test("CONTROL: signInWithOAuth is called once and never with a literal provider", async () => {
  // Counted across the whole tree, not just commonswarm.ts: a second call in another file is
  // exactly the second enforcement this is here to forbid, and reading one file would miss it.
  const everywhere: string[] = [];
  for (const file of await sourceFiles(SRC)) {
    const found = ((await readFile(file, "utf8")).match(/\.signInWithOAuth\(/g) ?? []).length;
    if (found > 0) everywhere.push(`${file.pathname} (${found})`);
  }
  assert.deepEqual(
    everywhere.map((entry) => entry.replace(/^.*\/src\//, "").replace(/ \(\d+\)$/, "")),
    ["lib/commonswarm.ts"],
    `signInWithOAuth is called in: ${everywhere.join(", ")}. There must be exactly one call ` +
      `site. A second one is a second enforcement, and two enforcements drift.`,
  );

  const source = await readFile(COMMONSWARM, "utf8");
  const calls = source.match(/\.signInWithOAuth\(/g) ?? [];
  assert.equal(calls.length, 1, "one call site, called once");
  assert.doesNotMatch(
    source,
    /signInWithOAuth\(\{[\s\S]{0,80}?provider:\s*["'`]/,
    "The provider passed to Supabase must come from authProvider(), not from a string " +
      "literal. A literal is the drift this module exists to prevent.",
  );
  assert.match(source, /const entry = authProvider\(provider\);/);
  assert.match(source, /provider: entry\.id,/);

  /*
   * signInWithProvider takes a plain string, because the invite page reads the id off a DOM
   * attribute. So a caller CAN write a literal — signInWithGitHub does, for /app, which has
   * not moved to ProviderButtons yet. It is typed `AuthProviderId` there, but `tsc -p
   * site/tsconfig.json` is red on unrelated imports and is not a gate, so the type alone
   * proves nothing at the gate. This does: every literal handed to that function anywhere
   * under site/src has to be an id AUTH_PROVIDERS names.
   */
  const known = new Set<string>(AUTH_PROVIDERS.map((provider) => provider.id));
  const wrong: string[] = [];
  for (const file of await sourceFiles(SRC)) {
    const text = await readFile(file, "utf8");
    // A literal handed straight to the function.
    for (const call of text.matchAll(/signInWithProvider\(\s*["'`]([^"'`]*)["'`]/g)) {
      if (!known.has(call[1] as string)) wrong.push(`${file.pathname}: "${call[1]}"`);
    }
    /*
     * A named value handed to the function, whatever its type annotation says. The annotation
     * is not enough on its own: dropping it is one keystroke, and site tsc is not a gate.
     * What is checked is the VALUE the name carries, and there are exactly three cases:
     *
     *   declared in this file from a string literal  -> the literal must be a known id
     *   declared in this file from anything else     -> allowed; that is the DOM read on the
     *                                                   invite page, guarded by authProvider()
     *   not declared in this file at all             -> REFUSED. An imported constant or a
     *                                                   parameter cannot be checked here, and
     *                                                   a silent skip is a gate with a hole.
     */
    // `function signInWithProvider(provider: string` is the definition, not a call site.
    for (const call of text.matchAll(
      /(?<!function\s)signInWithProvider\(\s*([A-Za-z_$][\w$]*)\s*(?![:\w$])/g,
    )) {
      const name = call[1] as string;
      const declared = new RegExp(
        `(?:const|let|var)\\s+${name}\\s*(?::[^=]+)?=\\s*(.+)`,
      ).exec(text);
      if (!declared) {
        wrong.push(
          `${file.pathname}: ${name} is passed to signInWithProvider but declared elsewhere, ` +
            `so its value cannot be checked here — declare it in this file`,
        );
        continue;
      }
      const literal = /^["'`]([^"'`]*)["'`]/.exec((declared[1] as string).trim());
      if (literal && !known.has(literal[1] as string)) {
        wrong.push(`${file.pathname}: ${name} = "${literal[1]}"`);
      }
    }
  }
  assert.deepEqual(
    wrong,
    [],
    `These call sites name a provider AUTH_PROVIDERS does not: ${wrong.join(", ")}. ` +
      `authProvider() would throw under a reader's finger; this catches it at the gate.`,
  );
});

test("CONTROL: the invite onramp never names a provider in a literal", async () => {
  const source = await readFile(ONRAMP, "utf8");
  for (const provider of AUTH_PROVIDERS) {
    assert.doesNotMatch(
      source,
      new RegExp(provider.name),
      `InviteOnramp.astro names "${provider.name}" directly. Provider names in that file ` +
        `must be derived from the rendered buttons through authProvider(), so the sentence ` +
        `and the buttons cannot disagree.`,
    );
  }
  assert.match(source, /renderedProviderNames\(\)/);
  assert.match(source, /listSentence\(renderedProviderNames\(\)\)/);
});

test("CONTROL: ProviderButtons decides from the deployment, and no flag can override it", async () => {
  const source = await readFile(BUTTONS, "utf8");
  assert.match(
    source,
    /await enabledProvidersForBuild\(\{\s*url: import\.meta\.env\.PUBLIC_SUPABASE_URL,\s*anonKey: import\.meta\.env\.PUBLIC_SUPABASE_ANON_KEY,\s*\}\)/,
    "The rendered set must come from enabledProvidersForBuild, which reads GoTrue's own " +
      "settings. Anything else is a list we chose rather than a list the deployment reported.",
  );
  assert.doesNotMatch(
    source,
    /PUBLIC_SWARM_AUTH_PROVIDERS|PUBLIC_[A-Z_]*PROVIDER/,
    "A build variable that selects providers is the retired design: it let a build publish " +
      "a button for a provider the dashboard still had off, and that button leads to raw JSON.",
  );
  for (const provider of AUTH_PROVIDERS) {
    assert.doesNotMatch(
      source,
      new RegExp(`["'\`]${provider.id}["'\`]`),
      `ProviderButtons.astro names "${provider.id}" in a literal. It must render whatever ` +
        `the deployment reports, never a provider it picked itself.`,
    );
  }
});

test("CONTROL: the buttons and the furniture above them render together or not at all", async () => {
  /*
   * Zero enabled providers is reachable in production: an operator turns every OAuth provider
   * off in the dashboard and the next build has no buttons. A leftover "or" divider above
   * nothing promises a choice the page does not offer, so the component owns both.
   */
  const component = await readFile(BUTTONS, "utf8");
  assert.match(
    component,
    /\{providers\.length > 0 && \(\s*<Fragment>\s*<slot name="before" \/>/,
    'The `before` slot must sit inside the `providers.length > 0` guard. Outside it, a host ' +
      "page's divider survives a build with no enabled providers.",
  );

  const host = await readFile(ONRAMP, "utf8");
  assert.match(
    host,
    /<div slot="before" class="invite-onramp__divider"/,
    "InviteOnramp must hand its divider to ProviderButtons through the slot.",
  );
  const dividerTags = host.match(/<[a-z]+[^>]*class="invite-onramp__divider"[^>]*>/g) ?? [];
  assert.equal(dividerTags.length, 1, "there is one divider above the buttons");
  for (const tag of dividerTags) {
    assert.match(
      tag,
      /slot="before"/,
      `A divider written outside the component is furniture the component cannot take ` +
        `away: ${tag}`,
    );
  }

  const buttonTags = component.match(/<button[^>]*data-signin-provider=/g) ?? [];
  assert.equal(
    buttonTags.length,
    1,
    "The button markup must be written once. Two copies is the drift this whole module " +
      "exists to remove, one level down.",
  );

  const html = await inviteHtml();
  const buttons = renderedProviderIds(html).length;
  const dividers = (html.match(/invite-onramp__divider/g) ?? []).length;
  assert.equal(
    buttons > 0,
    dividers > 0,
    `The built page has ${buttons} provider buttons and ${dividers} dividers. One without ` +
      `the other is the state this control exists to catch.`,
  );
});

test("CONTROL: the source sweep covers every file type under site/src", async () => {
  /*
   * The sweep below reads an extension allowlist, which is itself a typed list. This checks it
   * against what is actually on disk, so the day someone adds a .tsx or .svelte the sweep goes
   * red until a person decides whether it can hold a button. An allowlist with no coverage
   * check is a confident zero.
   */
  const present = await allSourceExtensions(SRC);
  const covered = new Set([...SCANNED_EXTENSIONS, ...UNSCANNABLE_EXTENSIONS]);
  const uncovered = [...present].filter((ext) => !covered.has(ext)).sort();
  assert.deepEqual(
    uncovered,
    [],
    `site/src holds .${uncovered.join(", .")} files that the sign-in-button sweep neither ` +
      `scans nor declares unscannable. Add each to SCANNED_EXTENSIONS or, if it cannot carry ` +
      `markup, to UNSCANNABLE_EXTENSIONS.`,
  );
});

test("CONTROL: only ProviderButtons renders a sign-in button, apart from named debt", async () => {
  /*
   * Three ways to put a sign-in control on a page, all matched:
   *
   *   <button data-signin-github>   any TAG, not just <button> — /app writes the attribute
   *                                 bare with no value, and an <a> would work as well
   *   setAttribute("data-signin…    built rather than written
   *   el.dataset.signinProvider =   the same thing through the dataset API
   *
   * Reading one is not writing one: querySelector("[data-signin-provider]") and
   * `button.dataset.signinProvider ?? ""` are how the invite page binds its handler, and
   * neither matches, because the first needs an opening tag and the second needs an `=`.
   */
  const ids = AUTH_PROVIDERS.map((provider) => provider.id).join("|");
  const marker = new RegExp(
    // any tag with a data-signin* attribute, however it is spelled
    `<[a-zA-Z][^>]*\\bdata-signin` +
      // any tag with a data-<provider> attribute: the invite page used `data-github` before
      // this lane, so that spelling is a real route and the ids come from the array
      `|<[a-zA-Z][^>]*\\bdata-(?:${ids})\\b` +
      // built rather than written
      `|setAttribute\\(\\s*["'\`]data-(?:signin|${ids})` +
      `|dataset(?:\\.signin[A-Za-z]*|\\s*\\[\\s*["'\`]signin[A-Za-z]*["'\`]\\s*\\])\\s*=[^=]`,
  );
  const all = new RegExp(marker.source, "g");
  const count = (text: string): number => (text.match(all) ?? []).length;

  const offenders: string[] = [];
  for (const file of await sourceFiles(SRC)) {
    if (file.href === BUTTONS.href) continue;
    const relative = file.pathname.slice(file.pathname.indexOf("/src/") + 5);
    const found = count(await readFile(file, "utf8"));
    const allowed = UNGENERATED_SIGNIN_SURFACES.get(relative) ?? 0;
    if (found > allowed) {
      offenders.push(
        allowed === 0 ? relative : `${relative} (${found} hand-written, ${allowed} allowed)`,
      );
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `These files write a sign-in button by hand: ${offenders.join(", ")}. Only ` +
      `ProviderButtons.astro may render one, or the surfaces can disagree about which doors ` +
      `are open.`,
  );

  for (const [known, allowed] of UNGENERATED_SIGNIN_SURFACES) {
    const source = await readFile(new URL(known, SRC), "utf8").catch(() => "");
    assert.ok(
      source.length > 0,
      `${known} is listed as a surface that hand-writes its own sign-in button, but the file ` +
        `is gone. Remove it from UNGENERATED_SIGNIN_SURFACES, or fix the path — a stale ` +
        `exception is an unscanned file nobody knows about.`,
    );
    assert.equal(
      count(source),
      allowed,
      `${known} is allowed ${allowed} hand-written sign-in control(s) and has ${count(source)}. ` +
        `Fewer means the debt is partly paid: lower the number, or delete the entry and let the ` +
        `sweep cover the file again.`,
    );
  }
});

test("providersFromSettings reads GoTrue's own answer and nothing else", () => {
  assert.deepEqual(
    providersFromSettings(LIVE_SETTINGS).map((provider) => provider.id),
    ["github"],
    "the live body on 2026-09-04 has google:false, so only GitHub may render",
  );
  const withGoogle = { external: { ...LIVE_SETTINGS.external, google: true } };
  assert.deepEqual(
    providersFromSettings(withGoogle).map((provider) => provider.id),
    ["github", "google"],
  );
  // Order follows AUTH_PROVIDERS, never the key order GoTrue happens to send.
  assert.deepEqual(
    providersFromSettings({ external: { google: true, github: true } }).map((p) => p.id),
    ["github", "google"],
  );
  assert.deepEqual(
    providersFromSettings({ external: { github: false, google: false } }).map((p) => p.id),
    [],
    "every door shut is an answer, and it is an empty list rather than a failure",
  );

  // A provider GoTrue enables that this code cannot render is NOT rendered. The set is the
  // intersection of the two, which is what the design doc says.
  assert.deepEqual(
    providersFromSettings({ external: { github: true, google: false, gitlab: true } }).map(
      (p) => p.id,
    ),
    ["github"],
  );

  // A flag must be a real boolean. The string "true", a 1, or a null is not GoTrue answering
  // this question, so it fails loudly rather than being read as "shut" — a wrong reading of a
  // body we do not understand is how a working door goes missing with no error anywhere.
  const other = (github: unknown) => ({ external: { github, google: false } });
  assert.deepEqual(providersFromSettings(other(true)).map((p) => p.id), ["github"]);
  assert.deepEqual(providersFromSettings(other(false)).map((p) => p.id), []);
  for (const bad of ["true", 1, null, undefined, {}, []]) {
    assert.throws(
      () => providersFromSettings(other(bad)),
      AuthSettingsUnreadable,
      `external.github = ${JSON.stringify(bad)} is not a boolean and must not be read as one`,
    );
  }

  // A body must answer about EVERY provider this code can render. GoTrue always does; a
  // truncated read, a proxy page that happens to be JSON, or a different API does not, and
  // that must fail rather than quietly ship an empty door list.
  assert.throws(() => providersFromSettings({ external: {} }), AuthSettingsUnreadable);
  assert.throws(() => providersFromSettings({ external: { email: true } }), AuthSettingsUnreadable);
  assert.throws(
    () => providersFromSettings({ external: { github: true } }),
    (error: unknown) =>
      error instanceof AuthSettingsUnreadable && /no boolean for google/.test(error.message),
    "a body that answers about GitHub but not Google is half an answer",
  );
  assert.throws(() => providersFromSettings({ ok: true }), AuthSettingsUnreadable);
  assert.throws(() => providersFromSettings(null), AuthSettingsUnreadable);
  assert.throws(() => providersFromSettings("{}"), AuthSettingsUnreadable);
  assert.throws(() => providersFromSettings({ external: [] }), AuthSettingsUnreadable);
  assert.throws(() => providersFromSettings([{ external: { github: true } }]), AuthSettingsUnreadable);
});

test("fetchEnabledProviders asks the right URL with the anon key", async () => {
  const seen: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(LIVE_SETTINGS), { status: 200 });
  }) as unknown as typeof fetch;
  const providers = await fetchEnabledProviders({
    url: "https://api.commonswarm.com",
    anonKey: "anon-key-value",
    fetchImpl,
  });
  assert.deepEqual(providers.map((provider) => provider.id), ["github"]);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.url, `https://api.commonswarm.com${AUTH_SETTINGS_PATH}`);
  const headers = seen[0]?.init.headers as Record<string, string>;
  assert.equal(headers.apikey, "anon-key-value");
  assert.equal(headers.Authorization, "Bearer anon-key-value");
  assert.ok(
    seen[0]?.init.signal instanceof AbortSignal,
    "the request must carry a deadline, or an unresponsive host hangs the build instead of " +
      "failing it",
  );
});

test("fetchEnabledProviders passes a deadline that actually fires", async () => {
  /*
   * WHAT THIS PROVES, EXACTLY: the signal this code hands to fetch aborts on its own, and the
   * rejection that follows is classified. The fake below is what a well-behaved fetch does —
   * it rejects with the signal's reason — so this does NOT prove Node's fetch honours a
   * signal. That is Node's contract, not ours.
   *
   * It is not decoration, because the regression it catches is ours: the sibling test hands
   * the classifier a hand-made TimeoutError, so swapping AbortSignal.timeout for a plain
   * `new AbortController().signal` leaves that one green while a silent host hangs every
   * build until someone kills it. Measured: that mutation turns THIS test red.
   *
   * The race is the control on the control: with no abort, it fails with a sentence instead
   * of hanging the suite the same way the build would.
   */
  const started = Date.now();
  const hangs = ((_url: string, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    })) as unknown as typeof fetch;

  const attempt = fetchEnabledProviders({
    url: "https://api.commonswarm.com",
    anonKey: "k",
    timeoutMs: 60,
    fetchImpl: hangs,
  });
  const guard = new Promise((resolve) => setTimeout(() => resolve("NO ABORT ARRIVED"), 4000));
  const outcome = await Promise.race([attempt.then(() => "RESOLVED", (error) => error), guard]);

  assert.ok(
    outcome instanceof AuthSettingsUnreadable,
    `A request to a host that never answers must be aborted by the deadline the code sets. ` +
      `Got: ${String(outcome)}`,
  );
  assert.match((outcome as Error).message, /did not answer in time/);
  assert.ok(
    Date.now() - started < 3000,
    "the abort must come from the 60 ms deadline, not from the guard",
  );
});

test("fetchEnabledProviders classifies a deadline by the error type, not by its prose", async () => {
  /*
   * Node 22 rejects an AbortSignal.timeout fetch with a DOMException whose `name` is
   * "TimeoutError". D-053: the classifier reads that name, never the message text, so a
   * provider changing its wording cannot change what CommonSwarm reports.
   */
  const timeout = Object.assign(new Error("aborted for some other reason entirely"), {
    name: "TimeoutError",
  });
  await assert.rejects(
    fetchEnabledProviders({
      url: "https://api.commonswarm.com",
      anonKey: "k",
      timeoutMs: 5,
      fetchImpl: (async () => {
        throw timeout;
      }) as unknown as typeof fetch,
    }),
    (error: unknown) =>
      error instanceof AuthSettingsUnreadable &&
      /did not answer in time/.test(error.message) &&
      error.cause === timeout,
  );
});

test("enabledProvidersForBuild: no backend is a state, half a backend is a typo", async () => {
  const fetchImpl = (async () =>
    new Response(JSON.stringify(LIVE_SETTINGS), { status: 200 })) as unknown as typeof fetch;

  assert.deepEqual(await enabledProvidersForBuild({ url: "", anonKey: "" }), []);
  assert.deepEqual(await enabledProvidersForBuild({ url: undefined, anonKey: undefined }), []);
  assert.deepEqual(await enabledProvidersForBuild({ url: "  ", anonKey: "\n" }), []);

  for (const half of [
    { url: "https://api.commonswarm.com", anonKey: "" },
    { url: "https://api.commonswarm.com", anonKey: "   " },
    { url: "", anonKey: "some-key" },
    { url: undefined, anonKey: "some-key" },
  ]) {
    await assert.rejects(
      enabledProvidersForBuild({ ...half, fetchImpl }),
      (error: unknown) =>
        error instanceof AuthSettingsUnreadable && /Set both in site\/.env, or neither/.test(error.message),
      `half-configured (${JSON.stringify(half)}) must fail the build, not publish an ` +
        `email-only page that looks finished`,
    );
  }

  assert.deepEqual(
    (
      await enabledProvidersForBuild({
        url: "https://api.commonswarm.com",
        anonKey: "k",
        fetchImpl,
      })
    ).map((provider) => provider.id),
    ["github"],
  );
});

test("fetchEnabledProviders refuses to guess when the deployment does not answer", async () => {
  const reply = (make: () => Response | Promise<Response>) =>
    (async () => make()) as unknown as typeof fetch;

  await assert.rejects(
    fetchEnabledProviders({
      url: "https://api.commonswarm.com",
      anonKey: "",
      fetchImpl: reply(() => new Response('{"message":"No API key found in request"}', { status: 401 })),
    }),
    (error: unknown) =>
      // The status is read off a field. The message is checked too, but as a copy control:
      // the number a caller acts on never comes out of a sentence.
      error instanceof AuthSettingsUnreadable &&
      error.status === 401 &&
      /HTTP 401/.test(error.message),
    "a 401 must stop the build, not render a guessed list",
  );

  await assert.rejects(
    fetchEnabledProviders({
      url: "https://api.commonswarm.com",
      anonKey: "k",
      fetchImpl: reply(() => new Response("<html>gateway</html>", { status: 200 })),
    }),
    AuthSettingsUnreadable,
    "a 200 that is not JSON must stop the build",
  );

  await assert.rejects(
    fetchEnabledProviders({
      url: "https://api.commonswarm.com",
      anonKey: "k",
      fetchImpl: reply(() => new Response(JSON.stringify({ ok: true }), { status: 200 })),
    }),
    AuthSettingsUnreadable,
    "a JSON body with no external map is not a settings body",
  );

  await assert.rejects(
    fetchEnabledProviders({
      url: "https://api.commonswarm.com",
      anonKey: "k",
      fetchImpl: (async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch,
    }),
    (error: unknown) =>
      error instanceof AuthSettingsUnreadable && error.cause instanceof TypeError,
    "a transport failure must stop the build and keep its cause",
  );
});

test("AuthSettingsUnreadable tells the reader what to do next", () => {
  const error = new AuthSettingsUnreadable("https://api.example.com/auth/v1/settings", "it answered HTTP 500");
  assert.match(error.message, /PUBLIC_SUPABASE_URL/);
  assert.match(error.message, /PUBLIC_SUPABASE_ANON_KEY/);
  assert.match(error.message, /curl/);
  assert.match(error.message, /rather than guess/);
});

test("providerChoices reads as a sentence for one, two, and three providers", () => {
  // listSentence joins arbitrary words. The inputs here are deliberately NOT provider names:
  // reading real ones in a joiner test looks like an enumeration of what the code enforces,
  // and it is nothing of the kind. The provider cases are the two providerChoices lines
  // below, whose input comes from providersFromSettings rather than from typing.
  assert.equal(listSentence([]), "");
  assert.equal(listSentence(["one"]), "one");
  assert.equal(listSentence(["one", "two"]), "one or two");
  assert.equal(listSentence(["one", "two", "three"]), "one, two, or three");
  assert.equal(providerChoices(providersFromSettings({ external: { github: true, google: true } })), "GitHub or Google");
  assert.equal(providerChoices(providersFromSettings(LIVE_SETTINGS)), "GitHub");
});

test("AUTH_PROVIDERS ids are unique, well formed, and a deliberate set", () => {
  /*
   * The last assertion is a SNAPSHOT TRIPWIRE, not proof about GoTrue. Nothing offline can
   * show that GoTrue accepts a string; that was measured against the live
   * /auth/v1/settings on 2026-09-04 and is written down in
   * docs/design/2026-09-04-GOOGLE-SIGNIN.md. What this line does is make adding a provider a
   * deliberate act: the author has to come here, which is where the rules for adding one are.
   */
  const ids = AUTH_PROVIDERS.map((provider) => provider.id);
  assert.equal(new Set(ids).size, ids.length, "duplicate provider id");
  for (const id of ids) assert.match(id, /^[a-z][a-z0-9_]*$/);
  for (const provider of AUTH_PROVIDERS) {
    assert.ok(provider.label.includes(provider.name), "the label must contain the name");
  }
  assert.deepEqual(
    ids,
    ["github", "google"],
    "Adding a provider is deliberate: update this line, and read the rules above it first.",
  );
});
