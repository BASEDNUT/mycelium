// Mycelium Store — KV persistence. Namespace: _mycelium/
// Original code. MIT license. Keys stored as JWK per Fedify manual pattern.

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

export class MyceliumStore {
  constructor(private kv: Deno.Kv) {}

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

  // ── keys (JWK) ──
  async getKeys(identifier: string): Promise<StoredKeyPair | null> {
    return (await this.kv.get<StoredKeyPair>([...NS, "key", identifier])).value;
  }

  async putKeys(identifier: string, keys: StoredKeyPair): Promise<void> {
    await this.kv.set([...NS, "key", identifier], keys);
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
