import assert from "node:assert/strict";
import { test } from "node:test";
import {
  collectPlaceholderNames,
  scanLegalDocPlaceholders,
  type LegalDocFields,
} from "../../lib/legal-placeholders.js";

const cleanDoc: LegalDocFields = {
  title: "Terms of Service",
  lede: "A clean lede with no markers.",
  effective: "27 July 2026",
  updated: "29 July 2026",
  sections: [
    {
      id: "scope",
      title: "Scope",
      blocks: [
        "Plain paragraph.",
        { sub: "A subheading" },
        { note: "A note." },
        { ul: ["one", "two"] },
        { ol: ["first", "second"] },
      ],
    },
  ],
};

test("clean legal document reports no placeholders", () => {
  assert.deepEqual(scanLegalDocPlaceholders(cleanDoc), []);
});

test("placeholders are reported from every field class and deduplicated", () => {
  const dirty: LegalDocFields = {
    title: "Title [[TITLE_MARK]]",
    lede: "Lede [[LEDE_MARK]] and again [[LEDE_MARK]]",
    effective: "[[EFFECTIVE_MARK]]",
    updated: "[[UPDATED_MARK]]",
    sections: [
      {
        id: "sec-[[ID_MARK]]",
        title: "Section [[SECTION_TITLE_MARK]]",
        blocks: [
          "Body [[BODY_MARK]]",
          { sub: "Sub [[SUB_MARK]]" },
          { note: "Note [[NOTE_MARK]]" },
          { ul: ["ul [[UL_MARK]]", "plain"] },
          { ol: ["ol [[OL_MARK]]"] },
        ],
      },
    ],
  };
  assert.deepEqual(scanLegalDocPlaceholders(dirty), [
    "TITLE_MARK",
    "LEDE_MARK",
    "EFFECTIVE_MARK",
    "UPDATED_MARK",
    "ID_MARK",
    "SECTION_TITLE_MARK",
    "BODY_MARK",
    "SUB_MARK",
    "NOTE_MARK",
    "UL_MARK",
    "OL_MARK",
  ]);
});

test("collectPlaceholderNames preserves first-seen order across strings", () => {
  assert.deepEqual(
    collectPlaceholderNames(["[[A]] then [[B]]", "again [[A]] and [[C]]"]),
    ["A", "B", "C"],
  );
});
