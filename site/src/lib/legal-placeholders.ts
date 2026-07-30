/**
 * Shared scan for unresolved [[PLACEHOLDER]] markers on final legal documents.
 * Pure so unit tests can prove every user-visible field class is covered.
 */

export const LEGAL_PLACEHOLDER_RE = /\[\[([^\]]+)\]\]/g;

export type LegalBlock =
  | string
  | { sub: string }
  | { ul: string[] }
  | { ol: string[] }
  | { note: string };

export interface LegalSection {
  id: string;
  title: string;
  blocks: LegalBlock[];
}

export interface LegalDocFields {
  title: string;
  lede: string;
  effective: string;
  updated: string;
  sections: LegalSection[];
}

/** Collect unique placeholder names from plain strings, in first-seen order. */
export function collectPlaceholderNames(texts: Iterable<string>): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  for (const text of texts) {
    for (const match of text.matchAll(LEGAL_PLACEHOLDER_RE)) {
      const name = match[1]!;
      if (seen.has(name)) continue;
      seen.add(name);
      found.push(name);
    }
  }
  return found;
}

/** Flatten every user-visible string field on a legal document shell. */
export function legalDocVisibleStrings(doc: LegalDocFields): string[] {
  const out: string[] = [
    doc.title,
    doc.lede,
    doc.effective,
    doc.updated,
  ];
  for (const section of doc.sections) {
    out.push(section.id, section.title);
    for (const block of section.blocks) {
      if (typeof block === "string") {
        out.push(block);
      } else if ("sub" in block) {
        out.push(block.sub);
      } else if ("note" in block) {
        out.push(block.note);
      } else if ("ul" in block) {
        out.push(...block.ul);
      } else {
        out.push(...block.ol);
      }
    }
  }
  return out;
}

/** Unique unresolved placeholder names across all visible legal fields. */
export function scanLegalDocPlaceholders(doc: LegalDocFields): string[] {
  return collectPlaceholderNames(legalDocVisibleStrings(doc));
}
