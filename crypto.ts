// Mycelium Crypto — AES-GCM encryption for actor private keys at rest.
// Fixes audit HIGH: private keys stored plaintext in Deno KV.
// Framework: Mycelium (this implementation: Taproot node).
// Original code. MIT license.

const IV_BYTES = 12;

export interface EncryptedBlob {
  enc: true;
  alg: "AES-256-GCM";
  iv: Uint8Array;
  ct: Uint8Array;
}

export class KeyEnvelope {
  private key: CryptoKey | null = null;

  /**
   * Load master key from a 64-char hex string, or generate + persist one.
   * Fail-closed (audit HIGH v0.9.0): if the key is missing/invalid while
   * encrypted actor keys already exist, silent regeneration would make
   * every stored key permanently undecryptable — refuse instead.
   */
  async loadOrGenerate(
    path: string,
    encryptedKeysExist: () => Promise<boolean>,
  ): Promise<void> {
    let hex: string | null = null;
    try {
      hex = (await Deno.readTextFile(path)).trim();
    } catch {
      hex = null;
    }
    if (hex == null || !/^[0-9a-f]{64}$/i.test(hex)) {
      if (await encryptedKeysExist()) {
        throw new Error(
          `crypto: master key at ${path} missing/invalid while encrypted actor keys exist — ` +
            `refusing to regenerate (all actor identities would be lost). Restore the key ` +
            `file or deliberately reset the datastore.`,
        );
      }
      const raw = crypto.getRandomValues(new Uint8Array(32));
      hex = Array.from(raw, (b) => b.toString(16).padStart(2, "0")).join("");
      await Deno.writeTextFile(path, hex + "\n");
      // Best-effort permission tightening (Deno may not support chmod everywhere).
      try {
        await Deno.chmod(path, 0o600);
      } catch {
        // ignore — container filesystems vary
      }
      console.warn(`crypto: generated new master key at ${path}`);
    }
    const bytes = new Uint8Array(32);
    for (let i = 0; i < 32; i++) {
      bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    this.key = await crypto.subtle.importKey(
      "raw",
      bytes as unknown as BufferSource,
      { name: "AES-GCM" },
      false,
      ["encrypt", "decrypt"],
    );
  }

  get available(): boolean {
    return this.key != null;
  }

  async encrypt(data: Uint8Array): Promise<EncryptedBlob> {
    if (this.key == null) throw new Error("KeyEnvelope: master key not loaded");
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const ct = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: iv as unknown as BufferSource },
      this.key,
      data as unknown as BufferSource,
    );
    return { enc: true, alg: "AES-256-GCM", iv, ct: new Uint8Array(ct) };
  }

  async decrypt(blob: EncryptedBlob): Promise<Uint8Array> {
    if (this.key == null) throw new Error("KeyEnvelope: master key not loaded");
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: blob.iv as unknown as BufferSource },
      this.key,
      blob.ct as unknown as BufferSource,
    );
    return new Uint8Array(pt);
  }
}

/** Encrypt a JSON-serializable value into an EncryptedBlob. */
export async function sealJson(
  envelope: KeyEnvelope,
  value: unknown,
): Promise<EncryptedBlob> {
  return await envelope.encrypt(
    new TextEncoder().encode(JSON.stringify(value)),
  );
}

/** Decrypt an EncryptedBlob back to a parsed JSON value. */
export async function openJson<T>(
  envelope: KeyEnvelope,
  blob: EncryptedBlob,
): Promise<T> {
  const pt = await envelope.decrypt(blob);
  return JSON.parse(new TextDecoder().decode(pt)) as T;
}
