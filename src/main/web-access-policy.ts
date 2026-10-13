const LOOPBACK_HOSTNAMES = ["localhost", "127.0.0.1", "[::1]"];

function hostnameOf(host: string): string | null {
  if (!host || /[\s/?#@\\]/u.test(host)) return null;
  try {
    return new URL(`http://${host}`).hostname.replace(/\.$/u, "");
  } catch {
    return null;
  }
}

export function parseAllowedHosts(value: string | undefined): string[] {
  const configured = (value ?? "")
    .split(",")
    .map((entry) => hostnameOf(entry.trim()))
    .filter((hostname) => hostname !== null);
  return [...LOOPBACK_HOSTNAMES, ...configured];
}

export function isAllowedHost(
  host: string | undefined,
  allowedHosts: readonly string[],
): boolean {
  const hostname = hostnameOf(host ?? "");
  return hostname !== null && allowedHosts.includes(hostname);
}

export function isAllowedOrigin(
  origin: string | undefined,
  allowedHosts: readonly string[],
): boolean {
  // Browsers always send Origin on WebSocket upgrades and cross-origin POSTs,
  // so a missing Origin means a non-browser client such as an agent's MCP client.
  if (origin === undefined) return true;
  if (!/^https?:\/\//u.test(origin)) return false;
  return isAllowedHost(URL.parse(origin)?.host, allowedHosts);
}
