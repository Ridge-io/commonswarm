import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/*
 * Build scripts must run on site/package.json's full Node floor (>=22.12). Directly importing
 * src/lib/install.ts would require --experimental-strip-types until Node 22.18, so read the
 * two deliberately simple declarations instead. This is still one source of truth: a rename,
 * a non-literal host, or a more complex command makes the build helper fail rather than drift.
 */
const siteDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(join(siteDir, "src/lib/install.ts"), "utf8");
const host = source.match(/^export const INSTALL_HOST = "([^"]+)";$/m)?.[1];
const template = source.match(/^export const INSTALL_CMD = `([^`]+)`;$/m)?.[1];

if (!host || !template) {
  throw new Error("Could not derive INSTALL_CMD from src/lib/install.ts");
}

export const INSTALL_CMD = template.replaceAll("${INSTALL_HOST}", host);

if (INSTALL_CMD.includes("${")) {
  throw new Error("INSTALL_CMD contains an unresolved template expression");
}
