// Mycelium SSRF guard — block federation lookups against internal networks.
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
  { net: 0x0A000000, mask: 0xff000000 }, // 10.0.0.0/8
  { net: 0xAC100000, mask: 0xfff00000 }, // 172.16.0.0/12
  { net: 0xC0A80000, mask: 0xffff0000 }, // 192.168.0.0/16
  { net: 0xA9FE0000, mask: 0xffff0000 }, // 169.254.0.0/16
  { net: 0x64400000, mask: 0xffc00000 }, // 100.64.0.0/10 CGNAT (audit fix)
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

function isPrivateV4(ip: string): boolean {
  const n = ip4ToInt(ip);
  if (n == null) return false;
  if (n === 0) return true;
  for (const range of PRIVATE_V4) {
    if ((n & range.mask) === (range.net & range.mask)) return true;
  }
  return false;
}

function isPrivateV6(ip: string): boolean {
  const h = ip.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "::" || h === "::1") return true;
  // IPv4-mapped IPv6: ::ffff:a.b.c.d → check the v4 part (audit fix)
  const mapped = h.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateV4(mapped[1]);
  if (h.startsWith("fc") || h.startsWith("fd")) return true; // unique-local
  if (h.startsWith("fe80")) return true; // link-local
  return false;
}

export function isPrivateIp(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "");
  if (BLOCKED_HOSTS.has(h.toLowerCase())) return true;
  if (h.includes(":")) return isPrivateV6(h);
  if (h.includes(".")) return isPrivateV4(h);
  return false;
}

/** Resolve hostname via DNS and verify EVERY resolved address is public.
 * Defeats DNS-rebinding: hostname looks public but resolves internally.
 * (audit MEDIUM fix: string check alone does not survive DNS.) */
async function resolvesToPrivate(host: string): Promise<boolean> {
  const h = host.replace(/^\[|\]$/g, "");
  // Literal IPs were already checked synchronously.
  if (isPrivateIp(h)) return true;
  if (/^[0-9.]+$/.test(h) || h.includes(":")) return false;
  let records: string[] = [];
  try {
    const a = await Deno.resolveDns(h, "A");
    records = records.concat(a);
  } catch { /* NXDOMAIN or no A — AAAA may still exist */ }
  try {
    const aaaa = await Deno.resolveDns(h, "AAAA");
    records = records.concat(aaaa);
  } catch { /* ignore */ }
  // No records: let the fetch itself fail later; nothing private observed.
  return records.some((r) => isPrivateIp(r));
}

async function checkTarget(url: URL): Promise<void> {
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`blocked protocol: ${url.protocol}`);
  }
  const host = url.hostname;
  if (isPrivateIp(host)) {
    throw new Error(`blocked internal host: ${host}`);
  }
  if (await resolvesToPrivate(host)) {
    throw new Error(`blocked host (DNS resolves to internal address): ${host}`);
  }
}

/** Validate a target URL/host for outbound federation. Throws on violation. */
export async function assertFederatable(url: URL): Promise<void> {
  await checkTarget(url);
}

/** Validate an @name@host handle host portion. Throws on violation. */
export async function assertFederatableHost(host: string): Promise<void> {
  if (isPrivateIp(host)) {
    throw new Error(`blocked internal host: ${host}`);
  }
  if (await resolvesToPrivate(host)) {
    throw new Error(`blocked host (DNS resolves to internal address): ${host}`);
  }
}
