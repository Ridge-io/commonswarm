import { createHash } from "node:crypto";

export const CLIENT_PROTOCOL_VERSION = "0.1.0";

export interface CloudTarget {
  url: string;
  anonKey: string;
  profileId: string;
}

export function cloudTarget(url: string, anonKey: string): CloudTarget {
  if (!url.trim()) throw new Error("--url is required");
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("--url must use http or https");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("--url must not contain credentials, a query, or a fragment");
  }
  if (parsed.pathname !== "/" && parsed.pathname !== "") {
    throw new Error("--url must be the Supabase project base URL");
  }
  if (!anonKey.trim()) throw new Error("--anon-key is required");
  const normalized = parsed.origin;
  return {
    url: normalized,
    anonKey: anonKey.trim(),
    profileId: createHash("sha256").update(normalized).digest("hex").slice(0, 24),
  };
}

export function commandEndpoint(target: CloudTarget): string {
  return `${target.url}/functions/v1/command`;
}

export function authStorageKey(target: CloudTarget): string {
  return `coswarm-${target.profileId}-auth`;
}
