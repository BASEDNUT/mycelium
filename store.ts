// Mycelium Store — KV persistence. Namespace: _mycelium/
// Original code. MIT license. Keys stored as JWK per Fedify manual pattern.
// Private keys encrypted at rest (AES-256-GCM) since v0.6.0; legacy plaintext
// records migrate transparently on first read.

import { KeyEnvelope, sealJson, openJson, type EncryptedBlob } from "./crypto.ts";

export type ActorClass =
  | "person"
  | "agent"
  | "service"
  | "group"
  | "application"
  | "instance";

export type PostForm = "short" | "long";

export interface ActorRecord {
  identifier: string;
  actorClass: ActorClass;
  name: string;
  summary: string;
  created: string;
  discoverable: boolean;
}

export interface StoredKeyPair {
  rsa: { privateKey: JsonWebKey; publicKey: JsonWebKey };
  ed25519: { privateKey: JsonWebKey; publicKey: JsonWebKey };
}

export interface PostRecord {
  id: string;
  identifier: string; // author identifier (local) or remote author URI
  content: string;
  published: string;
  inReplyTo?: string;
  visibility: "public" | "unlisted" | "followers" | "direct";
  form: PostForm; // short = feed, long = forum
  title?: string; // long-form title
  isRemote?: boolean; // true when ingested via federation
}

export interface FollowerRecord {
  id: string;
  followerId: string;
  inbox: string | null;
  followed: string;
}

const NS = ["_mycelium"];

function isEncrypted(v: unknown): v is EncryptedBlob {
  return typeof v === "object" && v !== null && (v as { enc?: unknown }).enc === true;
}

export class MyceliumStore {
  private envelope: KeyEnvelope | null = null;

  constructor(private kv: Deno.Kv) {}

  /** Attach a key envelope for at-rest private key encryption. */
  setKeyEnvelope(envelope: KeyEnvelope): void {
    this.envelope = envelope;
  }

  // ── actors ──
  async getActor(identifier: string): Promise<ActorRecord | null> {
    return (await this.kv.get<ActorRecord>([...NS, "actor", identifier])).value;
  }

  async putActor(record: ActorRecord): Promise<void> {
    await this.kv.set([...NS, "actor", record.identifier], record);
  }

  async listActors(): Promise<ActorRecord[]> {
    const out: ActorRecord[] = [];
    for await (
      const e of this.kv.list<ActorRecord>({ prefix: [...NS, "actor"] })
    ) out.push(e.value);
    return out;
  }

  // ── keys (JWK, encrypted at rest) ──
  async getKeys(identifier: string): Promise<StoredKeyPair | null> {
    const raw = (await this.kv.get<StoredKeyPair | EncryptedBlob>([...NS, "key", identifier])).value;
    if (raw == null) return null;
    if (!isEncrypted(raw)) return raw; // legacy plaintext — migrate on write path
    if (this.envelope == null) {
      throw new Error("store: encrypted key present but no envelope loaded");
    }
    return await openJson<StoredKeyPair>(this.envelope, raw);
  }

  async putKeys(identifier: string, keys: StoredKeyPair): Promise<void> {
    if (this.envelope == null) {
      await this.kv.set([...NS, "key", identifier], keys); // tests / no-envelope mode
      return;
    }
    const blob = await sealJson(this.envelope, keys);
    await this.kv.set([...NS, "key", identifier], blob);
  }

  /** One-time migration: encrypt any legacy plaintext keys. */
  async migrateKeysToEncrypted(): Promise<number> {
    if (this.envelope == null) return 0;
    let migrated = 0;
    for await (
      const e of this.kv.list<StoredKeyPair | EncryptedBlob>({
        prefix: [...NS, "key"],
      })
    ) {
      if (isEncrypted(e.value)) continue;
      const identifier = String(e.key[e.key.length - 1]);
      await this.putKeys(identifier, e.value);
      migrated++;
    }
    return migrated;
  }

  /** True if any stored actor key is already encrypted (needs master key). */
  async hasEncryptedKeys(): Promise<boolean> {
    for await (const e of this.kv.list<unknown>({ prefix: [...NS, "key"] })) {
      if (isEncrypted(e.value)) return true;
    }
    return false;
  }

  // ── followers ──
  async getFollowers(identifier: string): Promise<FollowerRecord[]> {
    const out: FollowerRecord[] = [];
    for await (
      const e of this.kv.list<FollowerRecord>({
        prefix: [...NS, "follower", identifier],
      })
    ) out.push(e.value);
    return out;
  }

  async addFollower(identifier: string, rec: FollowerRecord): Promise<void> {
    await this.kv.set([...NS, "follower", identifier, rec.id], rec);
  }

  async removeFollower(identifier: string, followId: string): Promise<void> {
    await this.kv.delete([...NS, "follower", identifier, followId]);
  }

  // ── posts ──
  async putPost(post: PostRecord): Promise<void> {
    await this.kv.set([...NS, "post", post.id], post);
  }

  async getPost(id: string): Promise<PostRecord | null> {
    return (await this.kv.get<PostRecord>([...NS, "post", id])).value;
  }

  async listPosts(identifier: string | null): Promise<PostRecord[]> {
    const out: PostRecord[] = [];
    for await (const e of this.kv.list<PostRecord>({ prefix: [...NS, "post"] })) {
      if (identifier == null || e.value.identifier === identifier) {
        out.push(e.value);
      }
    }
    return out;
  }

  async deletePost(id: string): Promise<void> {
    await this.kv.delete([...NS, "post", id]);
  }

  // ── likes / boosts ──
  async putLike(rec: LikeRecord): Promise<void> {
    await this.kv.set([...NS, "like", rec.kind, rec.postId, rec.actorId], rec);
  }

  async removeLike(kind: "like" | "boost", postId: string, actorId: string): Promise<void> {
    await this.kv.delete([...NS, "like", kind, postId, actorId]);
  }

  async getLike(kind: "like" | "boost", postId: string, actorId: string): Promise<LikeRecord | null> {
    return (await this.kv.get<LikeRecord>([...NS, "like", kind, postId, actorId])).value;
  }

  async listLikes(postId: string): Promise<LikeRecord[]> {
    const out: LikeRecord[] = [];
    for await (
      const e of this.kv.list<LikeRecord>({ prefix: [...NS, "like", "like", postId] })
    ) out.push(e.value);
    return out;
  }

  async listBoosts(postId: string): Promise<LikeRecord[]> {
    const out: LikeRecord[] = [];
    for await (
      const e of this.kv.list<LikeRecord>({ prefix: [...NS, "like", "boost", postId] })
    ) out.push(e.value);
    return out;
  }

  // ── notifications ──
  async putNotification(rec: NotificationRecord): Promise<void> {
    await this.kv.set([...NS, "notify", rec.identifier, rec.id], rec);
  }

  async listNotifications(identifier: string, unreadOnly = false): Promise<NotificationRecord[]> {
    const out: NotificationRecord[] = [];
    for await (
      const e of this.kv.list<NotificationRecord>({
        prefix: [...NS, "notify", identifier],
      })
    ) {
      if (!unreadOnly || !e.value.read) out.push(e.value);
    }
    return out.sort((a, b) => b.created.localeCompare(a.created));
  }

  async markNotificationRead(identifier: string, id: string): Promise<void> {
    const rec = (await this.kv.get<NotificationRecord>([...NS, "notify", identifier, id])).value;
    if (rec != null) {
      rec.read = true;
      await this.kv.set([...NS, "notify", identifier, id], rec);
    }
  }

  async markAllNotificationsRead(identifier: string): Promise<void> {
    for await (
      const e of this.kv.list<NotificationRecord>({
        prefix: [...NS, "notify", identifier],
      })
    ) {
      if (!e.value.read) {
        e.value.read = true;
        await this.kv.set([...NS, "notify", identifier, e.value.id], e.value);
      }
    }
  }

  // ── outbound following ──
  async putFollowing(rec: FollowingRecord): Promise<void> {
    await this.kv.set([...NS, "following", rec.identifier, rec.id], rec);
  }

  async getFollowing(identifier: string, targetId: string): Promise<FollowingRecord | null> {
    for await (
      const e of this.kv.list<FollowingRecord>({
        prefix: [...NS, "following", identifier],
      })
    ) {
      if (e.value.targetId === targetId) return e.value;
    }
    return null;
  }

  async removeFollowing(identifier: string, followId: string): Promise<void> {
    await this.kv.delete([...NS, "following", identifier, followId]);
  }

  async listFollowing(identifier: string): Promise<FollowingRecord[]> {
    const out: FollowingRecord[] = [];
    for await (
      const e of this.kv.list<FollowingRecord>({
        prefix: [...NS, "following", identifier],
      })
    ) out.push(e.value);
    return out;
  }
}

// ── likes / boosts ──
export interface LikeRecord {
  id: string; // activity id (local uuid or remote URI)
  actorId: string; // liker: local identifier or remote actor URI
  postId: string; // target post id
  kind: "like" | "boost";
  published: string;
}

// ── notifications ──
export type NotificationType =
  | "mention" // someone mentioned this actor in a post
  | "reply" // someone replied to this actor's post
  | "follow" // someone followed this actor
  | "like" // someone liked this actor's post
  | "boost"; // someone boosted this actor's post

export interface NotificationRecord {
  id: string;
  type: NotificationType;
  identifier: string; // the notified LOCAL actor
  fromActorId: string; // local identifier or remote actor URI
  postId?: string; // related post (mention/reply/like/boost)
  read: boolean;
  created: string;
}

// ── outbound follows (local actor follows remote/local) ──
export interface FollowingRecord {
  id: string; // follow activity id
  identifier: string; // local follower
  targetId: string; // target actor URI (remote) or identifier (local)
  targetInbox: string | null; // remote inbox when known
  followed: string;
}
