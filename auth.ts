// Mycelium Auth — per-actor API tokens with hashed storage.
// Fixes audit HIGH: single global bearer token gated every actor.
// Framework: Mycelium (this implementation: Taproot node).
// Original code. MIT license.

export interface StoredToken {
  actor: string;
  salt: Uint8Array;
  hash: Uint8Array;
  label?: string;
  created: string;
  expires?: string;
}

export interface PublicTokenInfo {
  id: string;
  actor: string;
  label: string | undefined;
  created: string;
  expires: string | undefined;
}

const TOKEN_NS = ["_mycelium", "authtoken"];
const SALT_BYTES = 16;
const TOKEN_BYTES = 32;
const PBKDF2_ITERATIONS = 100_000;

function base64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function hashToken(token: string, salt: Uint8Array): Promise<Uint8Array> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(token),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: salt as unknown as BufferSource,
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    keyMaterial,
    256,
  );
  return new Uint8Array(bits);
}

export class TokenAuth {
  constructor(private kv: Deno.Kv) {}

  async authenticate(bearer: string): Promise<string | null> {
    const token = bearer.startsWith("Bearer ") ? bearer.slice(7) : bearer;
    if (!token || token.length < 8) return null;
    const id = token.slice(0, 8);
    const res = await this.kv.get<StoredToken>([...TOKEN_NS, id]);
    if (res.value == null) return null;
    const rec = res.value;
    if (rec.expires != null && new Date(rec.expires).getTime() < Date.now()) {
      await this.kv.delete([...TOKEN_NS, id]);
      return null;
    }
    const hash = await hashToken(token, rec.salt);
    if (!timingSafeEqual(hash, rec.hash)) return null;
    return rec.actor;
  }

  async issue(
    actor: string,
    label?: string,
    ttlMs?: number,
  ): Promise<string> {
    const raw = crypto.getRandomValues(new Uint8Array(TOKEN_BYTES));
    const token = base64Url(raw);
    const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
    const hash = await hashToken(token, salt);
    const id = token.slice(0, 8);
    const rec: StoredToken = {
      actor,
      salt,
      hash,
      label,
      created: new Date().toISOString(),
      expires: ttlMs == null
        ? undefined
        : new Date(Date.now() + ttlMs).toISOString(),
    };
    await this.kv.set([...TOKEN_NS, id], rec);
    return token;
  }

  async revoke(actor: string, token?: string): Promise<number> {
    let removed = 0;
    const list = this.kv.list<StoredToken>({ prefix: [...TOKEN_NS] });
    for await (const entry of list) {
      const rec = entry.value;
      const id = String(entry.key[entry.key.length - 1]);
      if (token != null && id !== token.slice(0, 8)) continue;
      if (rec.actor !== actor) continue;
      await this.kv.delete(entry.key);
      removed++;
    }
    return removed;
  }

  async list(actor?: string): Promise<PublicTokenInfo[]> {
    const out: PublicTokenInfo[] = [];
    const list = this.kv.list<StoredToken>({ prefix: [...TOKEN_NS] });
    for await (const entry of list) {
      const rec = entry.value;
      if (actor != null && rec.actor !== actor) continue;
      out.push({
        id: String(entry.key[entry.key.length - 1]),
        actor: rec.actor,
        label: rec.label,
        created: rec.created,
        expires: rec.expires,
      });
    }
    return out;
  }
}
