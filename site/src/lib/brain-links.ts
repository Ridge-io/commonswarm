/*
 * A brain topic named inside a signal body becomes a control that opens that topic,
 * Markdown-rendered, in the Brain panel.
 *
 * DETECTION MUST NOT GUESS. Two rules decide every span, and a span that clears neither stays the
 * plain text the author wrote:
 *
 *   1. VALIDATE against the caller's list. A span linkifies only when it equals a topic in the
 *      list the caller passes -- the same brainTopics() list the Brain panel lists and can open
 *      (brain-view.ts). A name outside it is never a control, so there is no "unknown topic"
 *      link state to design.
 *
 *      That list is a SNAPSHOT taken when the caller rendered, so it is not the same claim as
 *      "this control still works". A topic deleted after the render keeps its control until the
 *      caller re-reads. brainLinkClickOutcome below is where that is caught: the click is
 *      decided against a FRESH read, so a control can never open a topic that is gone.
 *
 *   2. GATE THE WORD-LIKE NAMES. A topic carrying one of the characters in
 *      BRAIN_SLUG_SEPARATORS has a shape ordinary prose does not produce, so it links wherever
 *      it is written. Read that constant for the set; this sentence does not repeat it, because
 *      a repeated list is a claim with no control on it. A topic that is one bare word
 *      -- "roadmap", "releases" -- cannot be told apart from the same word used normally, so it
 *      links ONLY when an inline code span is EXACTLY that name, because that is the only way a
 *      writer can say "this is a name" about a word. Without this gate, one topic named "roadmap"
 *      would turn every use of that word in every message into a link.
 *
 *      The span must EQUAL the name, not merely contain it. canonicalBrainTopic permits a topic
 *      called "brain", or "the"; a review arm found that a span-contains rule would then put a
 *      control inside `cswarm brain put` and inside every other command an agent quotes.
 *
 *      An earlier version also accepted a nearby "brain" as a cue. A review arm killed it: the
 *      word boundary in \bbrain\b falls inside "brain-how-to", the topic agents cite most, so
 *      "Read brain-how-to for the releases ritual" minted a link on "releases" the writer never
 *      marked. A proximity cue on an English word IS a guess, and one wrong live link costs more
 *      than every plain mention it would have caught. Backticks are the mark; they cannot misfire.
 *
 * The decision is pure and lives apart from the DOM so its matrix can be tested directly. The DOM
 * pass runs AFTER setSanitizedMessageMarkdown, over the sanitized tree's TEXT NODES only. It
 * builds elements with createElement and textContent and never touches innerHTML, so it adds no
 * HTML string surface to the renderer it follows.
 */

/** The class the feed styles these controls with. */
export const BRAIN_LINK_CLASS = "dashboard__brain-link";

/** The data attribute a control carries, distinct from brain-view's own list buttons. */
export const BRAIN_LINK_ATTRIBUTE = "brainLink";

/**
 * Separators that make a topic name a slug rather than a word. Exported because the gate below
 * and every sentence that describes the gate must read the same set.
 */
export const BRAIN_SLUG_SEPARATORS = Object.freeze(["-", "_", "."] as const);

/* Built from the exported set, not typed a second time, so the gate and every sentence that
 * describes it cannot drift. Code-point escapes because a plain "\_" is not legal under /u. */
const SLUG_SEPARATOR_RE = new RegExp(
  `[${BRAIN_SLUG_SEPARATORS.map(
    (character) => `\\u{${character.codePointAt(0)!.toString(16)}}`,
  ).join("")}]`,
  "u",
);

/*
 * One run of the characters a slug, a path, a URL, an address, or a command argument is built
 * from. Keeping the machine punctuation INSIDE the run is what stops
 * https://example.com/api?topic=roadmap from offering "roadmap": the whole URL -- query string,
 * fragment and sub-delimiters included -- is a single run, and no topic equals it.
 *
 * Three review arms widened this set, each with a measured case: "?" and "=" (a button landed
 * inside a copy-pasteable curl command), "\\" (a Windows path split), and then ";" and "," --
 * both valid URL sub-delimiters, so https://example.com/a;shared-host and .../page,shared-host
 * each split and offered the slug from the middle of a URL.
 *
 * NOT in the set, deliberately: "'", "(" and ")". They appear in prose far more often than in
 * URLs -- "shared-host's rule", "(see shared-host)" -- and adding them would lose those links to
 * buy back a rarer case. A URL containing one next to a topic name can still split; that is the
 * stated bound.
 */
const RUN_RE = /[A-Za-z0-9._~\-/\\@:?#=&%+;,]+/gu;

/*
 * Punctuation a sentence writes against a slug and that the slug does not own. canonicalBrainTopic
 * permits a topic to END in "." or "-", so the run is tried whole first and this trim is only the
 * fallback. It must hold every character RUN_RE swallows that a sentence can also put after a
 * name -- ";" and "," were added to both together, or "see shared-host, then stop" would have
 * stopped linking. "!" is absent on purpose: it is outside RUN_RE, so it already ends a run.
 */
const TRAILING_PUNCTUATION_RE = /[.:~?#;,]+$/u;

/** Elements whose text is verbatim source, or is already a control. */
const OPAQUE_ELEMENTS = Object.freeze(["PRE", "A", "BUTTON"] as const);

const OPAQUE = new Set<string>(OPAQUE_ELEMENTS);

export interface BrainLinkSegment {
  text: string;
  /** The canonical topic this span opens, or null for text that stays as written. */
  topic: string | null;
}

export interface BrainLinkScanOptions {
  /**
   * The exact text of the inline code span this text sits inside, when it sits inside one.
   * A one-word topic links only when this equals the topic. Undefined outside a code span.
   */
  codeSpan?: string;
}

/** True when a topic name is a slug rather than something a sentence could produce by accident. */
export function isSlugShapedTopic(topic: string): boolean {
  return SLUG_SEPARATOR_RE.test(topic);
}

function resolveRun(
  run: string,
  known: ReadonlyMap<string, string>,
): { topic: string; length: number } | null {
  /* Compare whole runs, never a slice taken at a name's length. Lower-casing can change a
   * string's LENGTH, and slicing by the name would then slide every later index -- the defect
   * mention-address.ts records. Matching run-for-run cannot have it. */
  const exact = known.get(run.toLowerCase());
  if (exact !== undefined) return { topic: exact, length: run.length };
  const trimmed = run.replace(TRAILING_PUNCTUATION_RE, "");
  if (trimmed.length === 0 || trimmed.length === run.length) return null;
  const fallback = known.get(trimmed.toLowerCase());
  return fallback === undefined ? null : { topic: fallback, length: trimmed.length };
}

function isLinkable(topic: string, codeSpan: string | undefined): boolean {
  if (isSlugShapedTopic(topic)) return true;
  /* Equality, not containment: the whole span has to be the name, so `cswarm brain put` cannot
   * offer a topic called "brain". The span is trimmed the SAME way the run is, because a writer
   * ends a sentence inside the backticks -- `roadmap.` -- and a review arm found that resolveRun
   * trimmed the run while this comparison did not, so the intended link was missed. */
  if (codeSpan === undefined) return false;
  const span = codeSpan.trim().toLowerCase();
  return span === topic || span.replace(TRAILING_PUNCTUATION_RE, "") === topic;
}

/**
 * Splits one run of text into the spans that open a topic and the spans that stay as written.
 * A text with no linkable mention comes back as a single plain segment.
 */
export function brainLinkSegments(
  text: string,
  topics: readonly string[],
  options: BrainLinkScanOptions = {},
): BrainLinkSegment[] {
  const known = new Map<string, string>();
  for (const topic of topics) {
    if (topic.length > 0) known.set(topic.toLowerCase(), topic);
  }
  if (known.size === 0) return [{ text, topic: null }];

  const segments: BrainLinkSegment[] = [];
  let cursor = 0;
  for (const match of text.matchAll(RUN_RE)) {
    const start = match.index ?? 0;
    const resolved = resolveRun(match[0], known);
    if (resolved === null) continue;
    if (!isLinkable(resolved.topic, options.codeSpan)) continue;
    if (start > cursor) segments.push({ text: text.slice(cursor, start), topic: null });
    const end = start + resolved.length;
    segments.push({ text: text.slice(start, end), topic: resolved.topic });
    cursor = end;
  }
  if (segments.length === 0) return [{ text, topic: null }];
  if (cursor < text.length) segments.push({ text: text.slice(cursor), topic: null });
  return segments;
}

/**
 * What a click resolves to once the topic list has been re-read. A control is rendered from a
 * SNAPSHOT, so between render and click the topic can be gone; this is where that is decided,
 * apart from the DOM, so both outcomes and the words the reader sees can be tested.
 */
export type BrainLinkOutcome =
  | { kind: "open"; topic: string }
  | { kind: "missing"; topic: string; message: string }
  /** The click belongs to a workspace the reader has left. Render nothing, say nothing. */
  | { kind: "abandoned"; topic: string };

/**
 * Decides a click against the CURRENT topic list, not the one the control was rendered from.
 *
 * `listIsFresh` says whether the re-read behind `topicsNow` actually succeeded. A list that did
 * not refresh authorizes NOTHING: the click resolves to `missing` even when the stale list still
 * holds the name, because "this topic exists" is exactly the claim that read failed to establish.
 */
/** Said when the topic list could not be re-read, so nothing about it can be asserted. */
function staleListMessage(topic: string): string {
  return (
    `${topic} could not be opened: the topic list could not be refreshed just now, so ` +
    "CommonSwarm cannot tell whether it is still here. Check your connection, then open it again."
  );
}

export function brainLinkClickOutcome(
  topic: string,
  topicsNow: readonly string[],
  listIsFresh: boolean,
  contextIsCurrent: boolean,
): BrainLinkOutcome {
  /* CHECKED FIRST, and not about the topic at all. A review arm found the click continuing across
   * a workspace switch: the forced read then ran against the NEW workspace and APPLIED, so
   * listIsFresh was true and topicsNow held the new workspace's names. A slug present in both
   * opened in a workspace the reader never clicked in; one absent from the new workspace yanked
   * them to Brain with a notice naming the old workspace's slug. A workspace owes the reader
   * nothing about a click made somewhere else. The caller renders nothing and says nothing. */
  if (!contextIsCurrent) return { kind: "abandoned", topic };
  /* DEFENCE IN DEPTH, and the second half of the same rule. A list that could not be refreshed
   * cannot support the claim "this topic exists", so it does not get to authorize an open --
   * whatever it still contains. Without this the serialization in createBrainTopicReader is the
   * only thing standing between a click and the download failure, and one defect there (there
   * has already been one) puts the failure straight back. Refusing costs the reader nothing they
   * would not lose anyway: the read failed, so the download would almost certainly fail too. */
  if (!listIsFresh) return { kind: "missing", topic, message: staleListMessage(topic) };
  if (topicsNow.includes(topic)) return { kind: "open", topic };
  /* Say what happened and where the reader now is. "Nothing happened" and a failure raised from
   * inside the download are both worse: a review arm found the download error was what a reader
   * actually got when a topic was deleted after the feed rendered. */
  return {
    kind: "missing",
    topic,
    message:
      `${topic} is not in this workspace any more. It may have been deleted. ` +
      "The list here is current.",
  };
}

export interface BrainTopicReader {
  /**
   * Re-reads the topic list. `force` is a click: it never returns without a read that STARTED
   * after the call. Returns whether the list is fresh -- that is, whether the last completed
   * read succeeded.
   */
  refresh(force: boolean): Promise<boolean>;
}

export interface BrainTopicReaderOptions {
  /**
   * Performs one read. Resolves TRUE only when it actually replaced the list for the context the
   * caller is in now; FALSE when it bailed (the workspace moved under it, or there was nothing to
   * read). Rejection also means not fresh.
   *
   * The boolean is load-bearing. A review arm found the first version resolving `void` and the
   * reader marking the list fresh on ANY resolution -- so a read that returned early because the
   * workspace had changed still said "fresh", and a click was then authorized against the
   * previous workspace's names.
   */
  read: () => Promise<boolean>;
  /** How long a successful read stays good for the unforced (cadence) path. */
  staleAfterMs: number;
  now?: () => number;
}

/**
 * Serializes topic-list reads so a click can never decide against a stale snapshot.
 *
 * THE DEFECT THIS REPLACES, found by the Gemini review arm: the first version guarded with a
 * plain in-flight boolean and returned early when it was set. A click landing while the cadence
 * tick was in flight therefore returned SYNCHRONOUSLY, without awaiting anything, and the click
 * was decided against the old snapshot -- so a deleted topic still reached the download and
 * failed there, which is exactly what the click re-read existed to prevent.
 *
 * Joining the running read is not enough either. A read that STARTED before the click can carry
 * a result that predates whatever the reader just clicked. So a forced refresh waits the running
 * read out and then takes its own.
 */
export function createBrainTopicReader(
  options: BrainTopicReaderOptions,
): BrainTopicReader {
  const now = options.now ?? (() => Date.now());
  let inFlight: Promise<void> | null = null;
  let checkedAt = Number.NEGATIVE_INFINITY;
  let fresh = false;

  const start = (): Promise<void> => {
    if (inFlight) return inFlight;
    const run = options
      .read()
      .then(
        (applied) => {
          /* Only a read that APPLIED makes the list fresh. Resolving is not enough. */
          fresh = applied;
          if (applied) checkedAt = now();
        },
        () => {
          /* A failed read keeps the last good snapshot and says the list is not fresh. */
          fresh = false;
        },
      )
      .finally(() => {
        inFlight = null;
      });
    inFlight = run;
    return run;
  };

  return {
    async refresh(force) {
      if (!force) {
        /* A read already covers this tick, and an unforced tick has nothing to add. */
        if (inFlight) return fresh;
        if (now() - checkedAt < options.staleAfterMs) return fresh;
        await start();
        return fresh;
      }
      if (inFlight) await inFlight;
      await start();
      return fresh;
    },
  };
}

export interface BrainLinkOptions {
  /** Topics the Brain panel can open right now. An empty list linkifies nothing. */
  topics: readonly string[];
  /** Opens the topic, Markdown-rendered. */
  open: (topic: string) => void;
  className?: string;
}

/**
 * Replaces every validated topic mention in an already-sanitized tree with a control that opens
 * it. Returns how many controls were built, so a caller can assert on the count.
 */
export function linkifyBrainTopics(
  root: HTMLElement,
  options: BrainLinkOptions,
): number {
  const topics = [...options.topics];
  const ownerDocument = root.ownerDocument;
  if (topics.length === 0 || !ownerDocument) return 0;
  const className = options.className ?? BRAIN_LINK_CLASS;
  let created = 0;

  const control = (segment: BrainLinkSegment, topic: string): HTMLButtonElement => {
    const button = ownerDocument.createElement("button");
    button.type = "button";
    button.className = className;
    button.dataset[BRAIN_LINK_ATTRIBUTE] = topic;
    /* The text stays as the author wrote it, so the sentence still reads as a sentence. The
     * title says what the control does; an aria-label here would replace the visible name and
     * break "click <the words on screen>" for voice control. */
    button.textContent = segment.text;
    button.title = `Open the brain topic ${topic}`;
    button.addEventListener("click", (event) => {
      event.preventDefault();
      options.open(topic);
    });
    return button;
  };

  const visit = (node: Node, codeSpan: string | undefined): void => {
    /* Snapshot first: the loop replaces children of this very node. */
    for (const child of [...node.childNodes]) {
      if (child.nodeType === 3) {
        const text = child.nodeValue ?? "";
        if (text.trim() === "") continue;
        const segments = brainLinkSegments(text, topics, { codeSpan });
        if (segments.length === 1 && segments[0]?.topic === null) continue;
        const fragment = ownerDocument.createDocumentFragment();
        for (const segment of segments) {
          if (segment.topic === null) {
            fragment.append(ownerDocument.createTextNode(segment.text));
            continue;
          }
          fragment.append(control(segment, segment.topic));
          created += 1;
        }
        node.replaceChild(fragment, child);
        continue;
      }
      if (child.nodeType !== 1) continue;
      const element = child as Element;
      if (OPAQUE.has(element.tagName)) continue;
      /* Read the CODE element's WHOLE text, so the equality rule holds however the renderer
       * split the span into nodes. A nested span replaces the outer one. */
      visit(
        element,
        element.tagName === "CODE" ? (element.textContent ?? "") : codeSpan,
      );
    }
  };

  visit(root, undefined);
  return created;
}
