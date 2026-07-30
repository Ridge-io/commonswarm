export const DEFAULT_COMMAND_ALLOWED_ORIGINS = [
  "https://commonswarm.com",
  "https://www.commonswarm.com",
  "https://coswarm-site.vercel.app",
] as const;

export function commandAllowedOrigins(
  configured: string | undefined,
): ReadonlySet<string> {
  const values = (configured ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
  return new Set(values.length > 0 ? values : DEFAULT_COMMAND_ALLOWED_ORIGINS);
}

function loopbackOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return url.hostname === "localhost" || url.hostname === "127.0.0.1";
  } catch {
    return false;
  }
}

function originAllowed(
  origin: string,
  allowedOrigins: ReadonlySet<string>,
  environment: string | undefined,
): boolean {
  if (allowedOrigins.has(origin)) return true;
  return (environment === "development" || environment === "test") &&
    loopbackOrigin(origin);
}

function corsHeaders(
  request: Request,
  allowedOrigins: ReadonlySet<string>,
  environment: string | undefined,
): Headers {
  const headers = new Headers({ vary: "origin" });
  const origin = request.headers.get("origin");
  if (origin !== null && originAllowed(origin, allowedOrigins, environment)) {
    headers.set("access-control-allow-origin", origin);
  }
  return headers;
}

export function commandPreflight(
  request: Request,
  allowedOrigins: ReadonlySet<string>,
  environment: string | undefined,
): Response {
  const headers = corsHeaders(request, allowedOrigins, environment);
  headers.set("access-control-allow-methods", "POST, OPTIONS");
  headers.set(
    "access-control-allow-headers",
    "authorization, content-type, apikey",
  );
  headers.set("access-control-max-age", "600");
  return new Response(null, { status: 204, headers });
}

export function withCommandCors(
  request: Request,
  response: Response,
  allowedOrigins: ReadonlySet<string>,
  environment: string | undefined,
): Response {
  const headers = new Headers(response.headers);
  const cors = corsHeaders(request, allowedOrigins, environment);
  for (const [name, value] of cors) headers.set(name, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
