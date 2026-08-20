// Mycelium Network Projection — the graph as a projection of canonical state.
// Nodes and edges are DERIVED from actors, posts, follows, replies, and
// semantic objects (topic/concept/project). Not a separate competing store.
// Original code. MIT license.

import type { ActorRecord, PostRecord } from "./store.ts";

// ── Projection types ──

export type NodeKind =
  | "actor" // person | agent | service | group | application | instance
  | "object" // post | topic | concept | project
  | "edge-label"; // reserved

export interface GraphNode {
  id: string;
  kind: NodeKind;
  subkind: string; // actor class or object type
  label: string;
  detail?: string;
  linkedActor?: string; // for semantic objects linked to an actor
  linkedPost?: string; // for semantic objects linked to a post
  tags?: string[];
  created?: string;
}

export type EdgeKind =
  | "publishes" // actor -> post
  | "follows" // actor -> actor
  | "replies-to" // post -> post
  | "about" // object -> object (semantic relation)
  | "relates-to" // object -> object (generic semantic relation)
  | "linked-actor" // semantic object -> actor
  | "linked-post"; // semantic object -> post

export interface GraphEdge {
  from: string;
  to: string;
  kind: EdgeKind;
  weight: number; // 1..10 visual emphasis
  label?: string;
}

export interface NetworkGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  counts: {
    actors: number;
    objects: number;
    follows: number;
    replies: number;
    semantic: number;
    totalNodes: number;
    totalEdges: number;
  };
}

// ── Semantic objects (vocabulary Objects: topic, concept, project) ──
// These are NOT a separate ontology — they are Mycelium Objects from the
// semantic vocabulary, stored canonically and projected into the graph.

export interface SemanticObject {
  id: string;
  type: "topic" | "concept" | "project";
  name: string;
  description: string;
  tags: string[];
  linkedActor?: string;
  linkedPost?: string;
  created: string;
}

export interface SemanticLink {
  id: string;
  fromId: string;
  toId: string;
  relation: string; // semantic relation label (about, uses, part-of, ...)
  weight: number;
  note?: string;
  created: string;
}

const NS = ["_mycelium"];

export class NetworkProjection {
  constructor(private kv: Deno.Kv) {}

  // ── semantic object CRUD (canonical store) ──
  async putSemanticObject(o: SemanticObject): Promise<void> {
    await this.kv.set([...NS, "object", o.id], o);
  }

  async getSemanticObject(id: string): Promise<SemanticObject | null> {
    return (await this.kv.get<SemanticObject>([...NS, "object", id])).value;
  }

  async listSemanticObjects(
    type: string | null,
  ): Promise<SemanticObject[]> {
    const out: SemanticObject[] = [];
    for await (
      const e of this.kv.list<SemanticObject>({ prefix: [...NS, "object"] })
    ) {
      if (type == null || type === "" || e.value.type === type) {
        out.push(e.value);
      }
    }
    return out;
  }

  async deleteSemanticObject(id: string): Promise<void> {
    await this.kv.delete([...NS, "object", id]);
    // cascade semantic links
    for await (
      const e of this.kv.list<SemanticLink>({ prefix: [...NS, "semLink"] })
    ) {
      if (e.value.fromId === id || e.value.toId === id) {
        await this.kv.delete([...NS, "semLink", e.value.id]);
      }
    }
  }

  async putSemanticLink(l: SemanticLink): Promise<void> {
    await this.kv.set([...NS, "semLink", l.id], l);
  }

  async listSemanticLinks(): Promise<SemanticLink[]> {
    const out: SemanticLink[] = [];
    for await (
      const e of this.kv.list<SemanticLink>({ prefix: [...NS, "semLink"] })
    ) out.push(e.value);
    return out;
  }

  // ── the projection: derive the full graph from canonical state ──
  async build(
    actors: ActorRecord[],
    posts: PostRecord[],
    followersOf: (identifier: string) => Promise<string[]>,
  ): Promise<NetworkGraph> {
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];

    // Actor nodes
    const actorIds = new Set(actors.map((a) => a.identifier));
    for (const a of actors) {
      nodes.push({
        id: `actor:${a.identifier}`,
        kind: "actor",
        subkind: a.actorClass,
        label: a.name || a.identifier,
        detail: a.summary || undefined,
        created: a.created,
      });
    }

    // Post nodes + publishes edges
    for (const p of posts) {
      const author = p.identifier;
      const isRemote = p.isRemote === true;
      const nodeId = `post:${p.id}`;
      nodes.push({
        id: nodeId,
        kind: "object",
        subkind: p.form === "long" ? "topic" : "note",
        label: p.title ?? (p.content.length > 60 ? p.content.slice(0, 57) + "…" : p.content),
        detail: p.content,
        created: p.published,
      });
      if (!isRemote && actorIds.has(author)) {
        edges.push({
          from: `actor:${author}`,
          to: nodeId,
          kind: "publishes",
          weight: 5,
        });
      }
    }

    // Reply edges (post -> post)
    const postIds = new Set(posts.map((p) => p.id));
    for (const p of posts) {
      if (p.inReplyTo && postIds.has(p.inReplyTo)) {
        edges.push({
          from: `post:${p.id}`,
          to: `post:${p.inReplyTo}`,
          kind: "replies-to",
          weight: 3,
        });
      }
    }

    // Follow edges (local actor -> remote/local follower mapping)
    // followersOf returns follower URIs for a local actor's follower list;
    // we draw the edge as follower -> actor when both ends are local,
    // or as remote-follower -> actor with a derived remote node.
    let followCount = 0;
    for (const a of actors) {
      const followers = await followersOf(a.identifier);
      for (const fUri of followers) {
        followCount++;
        // Parse handle from remote URI if possible: .../users/xyz or /ap/actor/xyz
        const m = fUri.match(/\/(?:users|ap\/actor)\/([^/]+)$/);
        const remoteId = m ? m[1] : fUri;
        const remoteNodeId = `actor:${remoteId}`;
        if (!nodes.some((n) => n.id === remoteNodeId)) {
          nodes.push({
            id: remoteNodeId,
            kind: "actor",
            subkind: "remote",
            label: `@${remoteId}`,
            detail: fUri,
          });
        }
        edges.push({
          from: remoteNodeId,
          to: `actor:${a.identifier}`,
          kind: "follows",
          weight: 4,
        });
      }
    }

    // Semantic objects as nodes
    const semantic = await this.listSemanticObjects(null);
    for (const s of semantic) {
      nodes.push({
        id: `object:${s.id}`,
        kind: "object",
        subkind: s.type,
        label: s.name,
        detail: s.description || undefined,
        linkedActor: s.linkedActor,
        linkedPost: s.linkedPost,
        tags: s.tags,
        created: s.created,
      });
      if (s.linkedActor && actorIds.has(s.linkedActor)) {
        edges.push({
          from: `object:${s.id}`,
          to: `actor:${s.linkedActor}`,
          kind: "linked-actor",
          weight: 2,
        });
      }
      if (s.linkedPost && postIds.has(s.linkedPost)) {
        edges.push({
          from: `object:${s.id}`,
          to: `post:${s.linkedPost}`,
          kind: "linked-post",
          weight: 2,
        });
      }
    }

    // Semantic links as edges
    const semIds = new Set(semantic.map((s) => s.id));
    for (const l of await this.listSemanticLinks()) {
      if (semIds.has(l.fromId) && semIds.has(l.toId)) {
        edges.push({
          from: `object:${l.fromId}`,
          to: `object:${l.toId}`,
          kind: l.relation === "about" ? "about" : "relates-to",
          weight: l.weight,
          label: l.relation,
        });
      }
    }

    const counts = {
      actors: actors.length,
      objects: posts.length + semantic.length,
      follows: followCount,
      replies: edges.filter((e) => e.kind === "replies-to").length,
      semantic: semantic.length,
      totalNodes: nodes.length,
      totalEdges: edges.length,
    };
    return { nodes, edges, counts };
  }
}

// ── One-time migration: legacy kg entities -> semantic objects ──
// Old KG stored entities under _mycelium/kg/*. The projection replaces it.
// Migration copies (never deletes) legacy data once, then flags itself done.

interface LegacyEntity {
  id: string;
  type: string;
  name: string;
  description: string;
  category: string;
  tags: string[];
  linkedActor?: string;
  linkedPost?: string;
  created: string;
}

interface LegacyEdge {
  id: string;
  fromId: string;
  toId: string;
  relation: string;
  weight: number;
  note: string;
  created: string;
}

const LEGACY_TYPE_MAP: Record<string, SemanticObject["type"]> = {
  topic: "topic",
  concept: "concept",
  project: "project",
  // legacy-only types fold into concept, original type kept in tags
  agent: "concept",
  skill: "concept",
  resource: "concept",
  event: "topic",
  place: "topic",
};

export async function migrateKg(kv: Deno.Kv): Promise<void> {
  const flag = await kv.get<boolean>([...NS, "migrated", "kg-v1"]);
  if (flag.value === true) return;

  // Copy entities into semantic objects
  let objects = 0;
  for await (
    const e of kv.list<LegacyEntity>({ prefix: [...NS, "kg", "entity"] })
  ) {
    const mapped = LEGACY_TYPE_MAP[e.value.type];
    if (mapped == null) continue;
    const tags = e.value.tags ?? [];
    if (e.value.type !== mapped) tags.push(`legacy:${e.value.type}`);
    const obj: SemanticObject = {
      id: e.value.id,
      type: mapped,
      name: e.value.name,
      description: e.value.description ?? "",
      tags: [...new Set(tags.map((t) => t.toLowerCase()))].slice(0, 12),
      linkedActor: e.value.linkedActor,
      linkedPost: e.value.linkedPost,
      created: e.value.created,
    };
    await kv.set([...NS, "object", obj.id], obj);
    objects++;
  }

  // Copy edges whose endpoints survived as semantic objects
  const semIds = new Set(
    (await new NetworkProjection(kv).listSemanticObjects(null)).map((o) => o.id),
  );
  let links = 0;
  for await (
    const e of kv.list<LegacyEdge>({ prefix: [...NS, "kg", "edge"] })
  ) {
    if (!semIds.has(e.value.fromId) || !semIds.has(e.value.toId)) continue;
    const link: SemanticLink = {
      id: e.value.id,
      fromId: e.value.fromId,
      toId: e.value.toId,
      relation: e.value.relation,
      weight: e.value.weight,
      note: e.value.note || undefined,
      created: e.value.created,
    };
    await kv.set([...NS, "semLink", link.id], link);
    links++;
  }

  await kv.set([...NS, "migrated", "kg-v1"], true);
  console.log(
    `[mycelium] kg migration: ${objects} objects, ${links} links (legacy data preserved)`,
  );
}
