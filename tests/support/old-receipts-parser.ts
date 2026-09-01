import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * The receipts parser that npm 0.1.42 and 0.1.43 shipped (git object bcaa5296…,
 * tree 619ff1f^), loaded from git at test time. There is no version negotiation
 * on the receipts wire and the server migrates independently of the installed
 * base, so every wire change is checked against THIS parser, not our current one.
 * Throws — never skips — if git cannot produce the object: a skip would be the
 * false green this exists to prevent.
 */
export const OLD_PARSER_TREE = "619ff1f^";
export const OLD_PARSER_BLOB = "bcaa529644e960fb51f99294f3a42de1114890ca";

export interface OldReceiptsParser {
  parseDeliveryReceiptResult: (body: unknown) => { receipts: unknown[] };
  dispose: () => void;
}

export async function loadOldReceiptsParser(): Promise<OldReceiptsParser> {
  const blob = execFileSync("git", ["rev-parse", `${OLD_PARSER_TREE}:src/cloud/delivery-receipts.ts`], {
    encoding: "utf8",
  }).trim();
  assert.equal(blob, OLD_PARSER_BLOB, "the frozen old-parser object must be the npm 0.1.42/0.1.43 blob");
  const dir = mkdtempSync(join(tmpdir(), "cswarm-old-parser-"));
  const archive = execFileSync("git", ["archive", OLD_PARSER_TREE, "src"], { maxBuffer: 64 * 1024 * 1024 });
  execFileSync("tar", ["-x", "-C", dir], { input: archive });
  const mod = await import(pathToFileURL(join(dir, "src/cloud/delivery-receipts.ts")).href) as {
    parseDeliveryReceiptResult: OldReceiptsParser["parseDeliveryReceiptResult"];
  };
  assert.equal(typeof mod.parseDeliveryReceiptResult, "function", "the old module must export the parser");
  return {
    parseDeliveryReceiptResult: mod.parseDeliveryReceiptResult,
    dispose: () => rmSync(dir, { recursive: true, force: true }),
  };
}
