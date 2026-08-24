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

// ── subroots (v0.11.0, docs/subroots-identity-v1.md) ──
// Container primitive where posts live. Reddit got this right with subreddits.
export type SubrootArchetype = "feed" | "board" | "forum" | "meta";

export interface SubrootConfig {
  votes: boolean; // up/down votes enabled
  anonymous: boolean; // anonymous posting allowed (boards)
  retentionDays: number | null; // rolling deletion window (boards)
}

export interface SubrootRecord {
  slug: string; // [a-z0-9-]{1,32}
  archetype: SubrootArchetype;
  title: string;
  description: string;
  icon: string; // emoji or short glyph (v0.13.0)
  url: string; // external link, optional (v0.13.0)
  config: SubrootConfig;
  creator: string; // actor identifier (system seeds use "__instance__")
  created: string;
}

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
  subroot?: string; // optional subroot binding (v0.11.0); legacy posts have none
}

export interface VoteRecord {
  postId: string;
  actorId: string;
  value: 1 | -1; // up / down
  voted: string;
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

  async listPosts(
    identifier: string | null,
    subroot?: string | null,
  ): Promise<PostRecord[]> {
    const out: PostRecord[] = [];
    for await (const e of this.kv.list<PostRecord>({ prefix: [...NS, "post"] })) {
      if (identifier != null && e.value.identifier !== identifier) continue;
      if (subroot != null && e.value.subroot !== subroot) continue;
      out.push(e.value);
    }
    return out;
  }

  async deletePost(id: string): Promise<void> {
    await this.kv.delete([...NS, "post", id]);
  }

  // ── subroots (v0.11.0) ──
  async putSubroot(rec: SubrootRecord): Promise<void> {
    await this.kv.set([...NS, "subroot", rec.slug], rec);
  }

  async getSubroot(slug: string): Promise<SubrootRecord | null> {
    return (await this.kv.get<SubrootRecord>([...NS, "subroot", slug])).value;
  }

  async listSubroots(): Promise<SubrootRecord[]> {
    const out: SubrootRecord[] = [];
    for await (
      const e of this.kv.list<SubrootRecord>({ prefix: [...NS, "subroot"] })
    ) out.push(e.value);
    return out;
  }

  /**
   * v0.13.0: creator-managed update. Only title/description/icon/url/config
   * are editable; slug, archetype, creator, created are immutable here.
   */
  async updateSubroot(
    slug: string,
    patch: Partial<Pick<SubrootRecord, "title" | "description" | "icon" | "url" | "config">>,
  ): Promise<SubrootRecord | null> {
    const cur = await this.getSubroot(slug);
    if (cur == null) return null;
    const next: SubrootRecord = {
      ...cur,
      ...(patch.title != null ? { title: patch.title } : {}),
      ...(patch.description != null ? { description: patch.description } : {}),
      ...(patch.icon != null ? { icon: patch.icon } : {}),
      ...(patch.url != null ? { url: patch.url } : {}),
      ...(patch.config != null ? { config: patch.config } : {}),
    };
    await this.putSubroot(next);
    return next;
  }

  async deleteSubroot(slug: string): Promise<void> {
    await this.kv.delete([...NS, "subroot", slug]);
  }

  // ── votes (v0.12.0, docs/subroots-identity-v1.md) ──
  async putVote(rec: VoteRecord): Promise<void> {
    await this.kv.set([...NS, "vote", rec.postId, rec.actorId], rec);
  }

  async getVote(postId: string, actorId: string): Promise<VoteRecord | null> {
    return (await this.kv.get<VoteRecord>([...NS, "vote", postId, actorId]))
      .value;
  }

  async listVotes(postId: string): Promise<VoteRecord[]> {
    const out: VoteRecord[] = [];
    for await (
      const e of this.kv.list<VoteRecord>({ prefix: [...NS, "vote", postId] })
    ) out.push(e.value);
    return out;
  }

  async deleteVote(postId: string, actorId: string): Promise<void> {
    await this.kv.delete([...NS, "vote", postId, actorId]);
  }

  /** Delete a post and its attached votes (retention sweeper helper). */
  async deletePostCascade(id: string): Promise<number> {
    let n = 0;
    for await (
      const e of this.kv.list<VoteRecord>({ prefix: [...NS, "vote", id] })
    ) {
      await this.kv.delete(e.key);
      n++;
    }
    await this.deletePost(id);
    return n;
  }

  /**
   * Board retention sweeper: delete posts in subroots whose archetype is
   * "board" and whose age exceeds the subroot retention window.
   * Returns number of posts deleted.
   */
  async sweepExpiredPosts(now = new Date()): Promise<number> {
    const boards = new Map<string, number>();
    for (const s of await this.listSubroots()) {
      if (s.archetype === "board" && s.config.retentionDays != null) {
        boards.set(s.slug, s.config.retentionDays);
      }
    }
    if (boards.size === 0) return 0;
    let deleted = 0;
    for (const p of await this.listPosts(null)) {
      if (p.subroot == null) continue;
      const days = boards.get(p.subroot);
      if (days == null) continue;
      const ageMs = now.getTime() - new Date(p.published).getTime();
      if (ageMs > days * 86_400_000) {
        await this.deletePostCascade(p.id);
        deleted++;
      }
    }
    return deleted;
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
