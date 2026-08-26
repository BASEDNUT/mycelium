// Mycelium outbox — read external ActivityPub outboxes for the deck view.
// Pure helpers + TTL cache; network fetch lives in api.ts.
// Framework: Mycelium (this implementation: Taproot node).
// Original code. MIT license.

export interface RemoteNote {
  id: string;
  actor: string;
  content: string;
  published: string;
}

/** Build the webfinger endpoint URL for user@host. */
export function webfingerUrl(handle: string): string {
  const at = handle.lastIndexOf("@");
  const user = handle.slice(0, at);
  const host = handle.slice(at + 1);
  return "https://" + host + "/.well-known/webfinger?resource=" +
    encodeURIComponent("acct:" + user + "@" + host);
}

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
};

/** Strip HTML tags and decode common entities. */
export function stripHtml(html: string): string {
  let text = html.replace(/<[^>]*>/g, " ");
  text = text.replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (m) => ENTITIES[m] ?? m);
  return text.replace(/\s+/g, " ").trim();
}

/** Normalize an ActivityStreams object to a RemoteNote; null when not a Note. */
export function normalizeNote(obj: unknown): RemoteNote | null {
  if (typeof obj !== "object" || obj == null) return null;
  const o = obj as Record<string, unknown>;
  if (o.type !== "Note") return null;
  const id = typeof o.id === "string" ? o.id : null;
  const actor = typeof o.attributedTo === "string" ? o.attributedTo : null;
  const content = typeof o.content === "string" ? stripHtml(o.content) : null;
  if (id == null || actor == null || content == null || content.length === 0) return null;
  const published = typeof o.published === "string" ? o.published : "";
  return { id, actor, content, published };
}

/** Pull notes from an outbox / outbox-page document. */
export function extractPosts(doc: unknown): RemoteNote[] {
  if (typeof doc !== "object" || doc == null) return [];
  const o = doc as Record<string, unknown>;
  if (!Array.isArray(o.orderedItems)) return [];
  const out: RemoteNote[] = [];
  for (const item of o.orderedItems) {
    // Create activities wrap the note in .object.
    let candidate = item;
    if (
      typeof item === "object" && item != null &&
      (item as Record<string, unknown>).type === "Create"
    ) {
      const inner = (item as Record<string, unknown>).object;
      if (typeof inner === "object" && inner != null) candidate = inner;
    }
    const note = normalizeNote(candidate);
    if (note != null) out.push(note);
  }
  return out;
}

/** Simple TTL cache for fetched outbox documents. */
export class OutboxCache {
  #map = new Map<string, { at: number; doc: unknown }>();
  constructor(private ttlMs: number) {}
  get(key: string): unknown {
    const hit = this.#map.get(key);
    if (hit == null) return null;
    if (Date.now() - hit.at > this.ttlMs) {
      this.#map.delete(key);
      return null;
    }
    return hit.doc;
  }
  set(key: string, doc: unknown): void {
    this.#map.set(key, { at: Date.now(), doc });
  }
}
