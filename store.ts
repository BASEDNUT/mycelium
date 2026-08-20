// Mycelium Store — KV persistence. Namespace: _mycelium/
// Clean-room original code. Keys stored as JWK per Fedify manual pattern.

export type ActorClass =
  | "person"
  | "agent"
  | "service"
  | "group"
  | "application"
  | "instance";

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
  identifier: string;
  content: string;
  published: string;
  inReplyTo?: string;
  visibility: "public" | "unlisted" | "followers" | "direct";
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
}
