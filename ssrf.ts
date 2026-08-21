// Mycelium SSRF guard — block federation lookups against internal networks.
// Fixes audit MEDIUM: /api/follow is an authenticated SSRF primitive.
// Framework: Mycelium (this implementation: Taproot node).
// Original code. MIT license.

const BLOCKED_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "::1",
  "[::1]",
  "169.254.169.254", // cloud metadata
  "metadata.google.internal",
]);

const PRIVATE_V4 = [
  { net: 10, mask: 0xff000000, bits: 8 },
  { net: 0x0A000000, mask: 0xff000000 }, // 10.0.0.0/8
  { net: 0xAC100000, mask: 0xfff00000 }, // 172.16.0.0/12
  { net: 0xC0A80000, mask: 0xffff0000 }, // 192.168.0.0/16
  { net: 0xA9FE0000, mask: 0xffff0000 }, // 169.254.0.0/16
];

function ip4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const v = parseInt(p, 10);
    if (isNaN(v) || v < 0 || v > 255) return null;
    n = (n << 8) | v;
  }
  return n >>> 0;
}

export function isPrivateIp(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "");
  if (BLOCKED_HOSTS.has(h.toLowerCase())) return true;
  const n = ip4ToInt(h);
  if (n != null) {
    for (const range of PRIVATE_V4) {
      if ((n & range.mask) === (range.net & range.mask)) return true;
    }
    if (n === 0) return true;
  }
  // IPv6 loopback/unique-local/link-local textual forms.
  const lower = h.toLowerCase();
  if (
    lower === "::" || lower.startsWith("fc") || lower.startsWith("fd") ||
    lower.startsWith("fe80")
  ) return true;
  return false;
}

/** Validate a target URL/host for outbound federation. Throws on violation. */
export function assertFederatable(url: URL): void {
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`blocked protocol: ${url.protocol}`);
  }
  if (isPrivateIp(url.hostname)) {
    throw new Error(`blocked internal host: ${url.hostname}`);
  }
}

/** Validate an @name@host handle host portion. */
export function assertFederatableHost(host: string): void {
  if (isPrivateIp(host)) {
    throw new Error(`blocked internal host: ${host}`);
  }
}
