import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("legal draft band states review-only draft without inventing placeholders", async () => {
  const shell = await readFile(
    new URL("./LegalDoc.astro", import.meta.url),
    "utf8",
  );
  assert.match(shell, /<strong>Draft — not yet in force\.<\/strong>/);
  assert.match(
    shell,
    /This draft is published for review\.\s+It does not take effect until the draft banner is removed and a real effective\s+date is published\./,
  );
  assert.doesNotMatch(
    shell,
    /highlighted fields/i,
    "band must not claim undecided highlighted fields when pages ship none",
  );
  assert.doesNotMatch(
    shell,
    /operator has not made yet/i,
  );
  assert.doesNotMatch(
    shell,
    /decisions the operator/i,
  );

  for (
    const [path, label] of [
      ["../../pages/terms.astro", "Terms of Service"],
      ["../../pages/privacy.astro", "Privacy Policy"],
      ["../../pages/acceptable-use.astro", "Acceptable Use Policy"],
    ] as const
  ) {
    const page = await readFile(new URL(path, import.meta.url), "utf8");
    assert.match(
      page,
      /draft=\{true\}/,
      `${label} must remain explicitly draft until activated`,
    );
  }
});

test("legal date label is Proposed effective while draft and Effective when final", async () => {
  const shell = await readFile(
    new URL("./LegalDoc.astro", import.meta.url),
    "utf8",
  );
  assert.match(
    shell,
    /const effectiveDateLabel = draft \? "Proposed effective" : "Effective"/,
  );
  assert.match(shell, /\{effectiveDateLabel\}/);
  assert.doesNotMatch(
    shell,
    /<span>Effective <span class="mono lgl__date-val">\{effective\}<\/span><\/span>/,
    "hard-coded Effective label must not remain for draft pages",
  );
  assert.match(shell, /scanLegalDocPlaceholders\(/);
});
