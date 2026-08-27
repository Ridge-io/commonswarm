import {
  AcpVersionBelowFloorError,
  AcpVersionParseError,
} from "./types.js";

const CORE_IDENTIFIER = "(?:0|[1-9]\\d*)";
const PRERELEASE_IDENTIFIER = "(?:0|[1-9]\\d*|[A-Za-z-][0-9A-Za-z-]*)";
const BUILD_IDENTIFIER = "[0-9A-Za-z-]+";
const SEMVER_SOURCE =
  `${CORE_IDENTIFIER}\\.${CORE_IDENTIFIER}\\.${CORE_IDENTIFIER}` +
  `(?:-${PRERELEASE_IDENTIFIER}(?:\\.${PRERELEASE_IDENTIFIER})*)?` +
  `(?:\\+${BUILD_IDENTIFIER}(?:\\.${BUILD_IDENTIFIER})*)?`;
const SEMVER_RE = new RegExp(`^${SEMVER_SOURCE}$`);

type ParsedSemVer = {
  core: [bigint, bigint, bigint];
  prerelease: string[] | null;
};

export type ProviderVersionNotice = {
  provider: string;
  runningVersion: string;
  lastMeasuredVersion: string;
};

/** Parse strict SemVer without losing ordering precision on large identifiers. */
function parseSemVer(value: string): ParsedSemVer | null {
  if (!SEMVER_RE.test(value)) return null;
  const withoutBuild = value.split("+", 1)[0]!;
  const dash = withoutBuild.indexOf("-");
  const coreText = dash === -1 ? withoutBuild : withoutBuild.slice(0, dash);
  const prereleaseText = dash === -1 ? null : withoutBuild.slice(dash + 1);
  const coreParts = coreText.split(".");
  if (coreParts.length !== 3) return null;
  return {
    core: [BigInt(coreParts[0]!), BigInt(coreParts[1]!), BigInt(coreParts[2]!)],
    prerelease: prereleaseText === null ? null : prereleaseText.split("."),
  };
}

/** Compare two strict SemVer values using SemVer precedence rules. */
export function compareSemVer(left: string, right: string): -1 | 0 | 1 {
  const a = parseSemVer(left);
  const b = parseSemVer(right);
  if (!a || !b) {
    throw new AcpVersionParseError(
      `cannot compare invalid semantic versions: ${JSON.stringify(left)} and ${JSON.stringify(right)}`,
    );
  }
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index]! < b.core[index]!) return -1;
    if (a.core[index]! > b.core[index]!) return 1;
  }
  if (a.prerelease === null && b.prerelease === null) return 0;
  if (a.prerelease === null) return 1;
  if (b.prerelease === null) return -1;
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = a.prerelease[index];
    const rightPart = b.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;
    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) {
      return BigInt(leftPart) < BigInt(rightPart) ? -1 : 1;
    }
    if (leftNumeric) return -1;
    if (rightNumeric) return 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

/** Extract a provider version while ignoring unrelated banner and warning lines. */
export function parseProviderVersionOutput(
  stdout: string,
  productPattern: RegExp,
  allowBare = true,
): string | null {
  const lines = stdout.split(/\r?\n/);
  for (const line of lines) {
    const pattern = new RegExp(productPattern.source, productPattern.flags.replace("g", ""));
    const product = pattern.exec(line);
    if (!product) continue;
    const after = line.slice(product.index + product[0].length);
    const afterMatch = new RegExp(
      `^\\s+(${SEMVER_SOURCE})(?=$|\\s|\\()`,
    ).exec(after);
    if (afterMatch?.[1]) return afterMatch[1];
    const before = line.slice(0, product.index);
    const beforeMatch = new RegExp(`(${SEMVER_SOURCE})\\s*\\($`).exec(before);
    if (beforeMatch?.[1]) return beforeMatch[1];
  }
  if (!allowBare) return null;
  for (const line of lines) {
    const trimmed = line.trim();
    const match = new RegExp(`^(${SEMVER_SOURCE})$`).exec(trimmed);
    if (match?.[1]) return match[1];
  }
  return null;
}

/** Refuse below-floor versions and report newer, not-yet-measured versions. */
export function assertProviderVersionFloor(options: {
  provider: string;
  version: string;
  minimumVersion: string;
  lastMeasuredVersion: string;
  onNewerVersion?: (notice: ProviderVersionNotice) => void;
}): void {
  if (compareSemVer(options.version, options.minimumVersion) < 0) {
    throw new AcpVersionBelowFloorError(
      options.provider,
      options.minimumVersion,
      options.version,
    );
  }
  if (compareSemVer(options.version, options.lastMeasuredVersion) > 0) {
    options.onNewerVersion?.({
      provider: options.provider,
      runningVersion: options.version,
      lastMeasuredVersion: options.lastMeasuredVersion,
    });
  }
}
