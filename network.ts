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
  createdBy?: string; // provenance: authenticated actor (or __admin__)
  created: string;
}

export interface SemanticLink {
  id: string;
  fromId: string;
  toId: string;
  relation: string; // semantic relation label (about, uses, part-of, ...)
  weight: number;
  note?: string;
  createdBy?: string; // provenance: authenticated actor (or __admin__)
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

  async getSemanticLink(id: string): Promise<SemanticLink | null> {
    return (await this.kv.get<SemanticLink>([...NS, "semLink", id])).value;
  }

  async deleteSemanticLink(id: string): Promise<void> {
    await this.kv.delete([...NS, "semLink", id]);
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
    followingOf?: (identifier: string) => Promise<{
      identifier: string;
      targetId: string;
    }[]>,
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
      } else if (isRemote) {
        // Remote post authors become actor nodes so the graph is a complete
        // projection of stored state (audit HIGH: remote authors missing).
        const m = author.match(/^https?:\/\/([^/]+)\/(?:users|ap\/actor)\/([^/]+)$/);
        const remoteAuthorId = m ? `actor:${m[2]}@${m[1]}` : `actor:${author}`;
        const remoteLabel = m ? `@${m[2]}@${m[1]}` : author.slice(0, 24);
        if (!nodes.some((n) => n.id === remoteAuthorId)) {
          nodes.push({
            id: remoteAuthorId,
            kind: "actor",
            subkind: "remote",
            label: remoteLabel,
            detail: author,
          });
        }
        edges.push({
          from: remoteAuthorId,
          to: nodeId,
          kind: "publishes",
          weight: 4,
        });
      }
    }

    // Reply edges (post -> post).
    // inReplyTo is ALWAYS a full AP URI (v0.4+ normalization); raw ids are
    // legacy. Resolve URIs back to local post records so reply edges survive
    // (audit HIGH fix: postIds.has(p.inReplyTo) never matched URIs).
    const postIds = new Set(posts.map((p) => p.id));
    const postsByUri = new Map<string, PostRecord>();
    for (const p of posts) {
      // local posts: <origin>/ap/actor/<id>/p/<uuid>; remote posts: id IS the URI
      const uriMatch = p.id.match(/\/p\/([^/]+)$/);
      if (uriMatch) postsByUri.set(uriMatch[1], p);
      if (p.isRemote === true && /^https?:\/\//.test(p.id)) {
        postsByUri.set(p.id, p);
      }
    }
    const resolveReplyTarget = (ref: string): string | null => {
      if (postIds.has(ref)) return ref;
      const rec = postsByUri.get(ref);
      if (rec != null) return rec.id;
      // local URI form: .../p/<uuid>
      const m = ref.match(/\/p\/([^/]+)$/);
      if (m && postIds.has(m[1])) return m[1];
      return null;
    };
    for (const p of posts) {
      if (!p.inReplyTo) continue;
      const targetId = resolveReplyTarget(p.inReplyTo);
      if (targetId != null) {
        edges.push({
          from: `post:${p.id}`,
          to: `post:${targetId}`,
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
        // Remote follower: canonical identity is name@host (audit HIGH fix:
        // bare names from different servers could collide, and could collide
        // with local actor identifiers).
        let remoteNodeId: string;
        let label: string;
        const m = fUri.match(/^https?:\/\/([^/]+)\/(?:users|ap\/actor)\/([^/]+)$/);
        if (m) {
          remoteNodeId = `actor:${m[2]}@${m[1]}`;
          label = `@${m[2]}@${m[1]}`;
        } else {
          remoteNodeId = `actor:${fUri}`;
          label = fUri.slice(0, 24);
        }
        if (!nodes.some((n) => n.id === remoteNodeId)) {
          nodes.push({
            id: remoteNodeId,
            kind: "actor",
            subkind: "remote",
            label,
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

    // Outbound follows (local actor -> remote target) — audit HIGH: the
    // projection consumed incoming followers but never stored FollowingRecords.
    if (followingOf != null) {
      for (const a of actors) {
        for (const f of await followingOf(a.identifier)) {
          const m = f.targetId.match(
            /^https?:\/\/([^/]+)\/(?:users|ap\/actor)\/([^/]+)$/,
          );
          let targetNodeId: string;
          let label: string;
          if (m) {
            targetNodeId = `actor:${m[2]}@${m[1]}`;
            label = `@${m[2]}@${m[1]}`;
          } else if (actorIds.has(f.targetId)) {
            targetNodeId = `actor:${f.targetId}`;
            label = f.targetId;
          } else {
            targetNodeId = `actor:${f.targetId}`;
            label = f.targetId.slice(0, 24);
          }
          if (!nodes.some((n) => n.id === targetNodeId)) {
            nodes.push({
              id: targetNodeId,
              kind: "actor",
              subkind: "remote",
              label,
              detail: f.targetId,
            });
          }
          edges.push({
            from: `actor:${a.identifier}`,
            to: targetNodeId,
            kind: "follows",
            weight: 3,
          });
        }
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
