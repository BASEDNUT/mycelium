// Network projection API — graph as derived view of canonical state.
// Original code. MIT license.

import type { MyceliumStore } from "./store.ts";
import type { NetworkProjection, SemanticObject } from "./network.ts";

export interface NetworkDeps {
  store: MyceliumStore;
  network: NetworkProjection;
  origin: string;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export function bearerOk(request: Request, deps: NetworkDeps): boolean {
  // The write token is shared with the core API for now; per-actor tokens
  // come with the auth workstream.
  const auth = request.headers.get("authorization") ?? "";
  return auth.startsWith("Bearer ") && auth.length > 7;
}

const SEMANTIC_TYPES = new Set(["topic", "concept", "project"]);

export async function handleNetwork(
  request: Request,
  deps: NetworkDeps,
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const { store, network } = deps;

  // Full graph projection
  if (path === "/api/network/graph" && request.method === "GET") {
    const [actors, posts] = await Promise.all([
      store.listActors(),
      store.listPosts(null),
    ]);
    const graph = await network.build(
      actors,
      posts,
      async (id) => (await store.getFollowers(id)).map((f) => f.followerId),
    );
    return json(200, graph);
  }

  // Semantic objects list
  if (path === "/api/network/objects" && request.method === "GET") {
    const type = url.searchParams.get("type");
    const objects = await network.listSemanticObjects(type);
    return json(200, { count: objects.length, objects });
  }

  // Create semantic object
  if (path === "/api/network/object" && request.method === "POST") {
    if (!bearerOk(request, deps)) return json(401, { error: "unauthorized" });
    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return json(400, { error: "invalid json" });
    }
    const type = String(body.type ?? "topic").trim();
    const name = String(body.name ?? "").trim();
    const description = String(body.description ?? "").trim();
    const tags = Array.isArray(body.tags)
      ? body.tags.map((t) => String(t).trim().toLowerCase()).filter(Boolean).slice(0, 12)
      : [];
    const linkedActor = body.linkedActor == null
      ? undefined
      : String(body.linkedActor).trim().toLowerCase();
    const linkedPost = body.linkedPost == null
      ? undefined
      : String(body.linkedPost).trim();
    if (!name) return json(400, { error: "name required" });
    if (!SEMANTIC_TYPES.has(type)) {
      return json(400, { error: `type must be one of ${[...SEMANTIC_TYPES].join(", ")}` });
    }
    if (description.length > 2000) {
      return json(400, { error: "description too long (max 2000)" });
    }
    if (linkedActor != null && (await store.getActor(linkedActor)) == null) {
      return json(404, { error: "linked actor not found" });
    }
    if (linkedPost != null && (await store.getPost(linkedPost)) == null) {
      return json(404, { error: "linked post not found" });
    }
    const obj: SemanticObject = {
      id: crypto.randomUUID(),
      type: type as SemanticObject["type"],
      name,
      description,
      tags,
      linkedActor,
      linkedPost,
      created: new Date().toISOString(),
    };
    await network.putSemanticObject(obj);
    return json(201, { ok: true, object: obj });
  }

  // Semantic link between objects
  if (path === "/api/network/link" && request.method === "POST") {
    if (!bearerOk(request, deps)) return json(401, { error: "unauthorized" });
    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return json(400, { error: "invalid json" });
    }
    const fromId = String(body.fromId ?? "").trim();
    const toId = String(body.toId ?? "").trim();
    const relation = String(body.relation ?? "").trim().toLowerCase().replace(/\s+/g, "-");
    const weight = Math.min(Math.max(Number(body.weight ?? 5) || 5, 1), 10);
    const note = String(body.note ?? "").trim();
    if (!fromId || !toId || !relation) {
      return json(400, { error: "fromId, toId, relation required" });
    }
    if ((await network.getSemanticObject(fromId)) == null) {
      return json(404, { error: "from object not found" });
    }
    if ((await network.getSemanticObject(toId)) == null) {
      return json(404, { error: "to object not found" });
    }
    const link = {
      id: crypto.randomUUID(),
      fromId,
      toId,
      relation,
      weight,
      note: note || undefined,
      created: new Date().toISOString(),
    };
    await network.putSemanticLink(link);
    return json(201, { ok: true, link });
  }

  // ── per-node navigation APIs (graph-as-navigation, v0.5) ──

  // Node neighbors: 1-hop edges + connected nodes, filterable by relation
  // (must run before the node-detail handler so the /neighbors suffix routes here)
  if (path.startsWith("/api/network/node/") && path.endsWith("/neighbors") &&
      request.method === "GET") {
    const rawId = decodeURIComponent(
      path.slice("/api/network/node/".length, -"/neighbors".length),
    );
    const relFilter = (url.searchParams.get("relation") ?? "")
      .split(",").map((r) => r.trim()).filter(Boolean);
    const limit = Math.min(
      Math.max(Number(url.searchParams.get("limit") ?? 50) || 50, 1),
      200,
    );

    const [actors, posts] = await Promise.all([
      store.listActors(),
      store.listPosts(null),
    ]);
    const graph = await network.build(
      actors,
      posts,
      async (id) => (await store.getFollowers(id)).map((f) => f.followerId),
    );

    const node = graph.nodes.find((n) => n.id === rawId);
    if (node == null) {
      return json(404, { error: "node not found in graph" });
    }

    const nodeMap = new Map(graph.nodes.map((n) => [n.id, n]));
    const edges = graph.edges.filter((e) => {
      if (e.from !== rawId && e.to !== rawId) return false;
      if (relFilter.length > 0 && !relFilter.includes(e.kind)) return false;
      return true;
    }).slice(0, limit);

    const neighbors = [...new Set(edges.flatMap((e) => [e.from, e.to]))]
      .filter((id) => id !== rawId && nodeMap.has(id))
      .map((id) => nodeMap.get(id)!);

    return json(200, {
      node,
      edgeCount: edges.length,
      neighborCount: neighbors.length,
      edges,
      neighbors,
    });
  }

  // Node detail by graph id (actor:x | post:uuid | object:uuid)
  if (path.startsWith("/api/network/node/") && request.method === "GET") {
    const rawId = decodeURIComponent(path.slice("/api/network/node/".length));
    const parts = rawId.split(":", 2);
    if (parts.length !== 2) {
      return json(400, { error: "node id must be kind:id (actor:foo, post:uuid, object:uuid)" });
    }
    const [kind, key] = parts;

    if (kind === "actor") {
      const actor = await store.getActor(key);
      if (actor == null) {
        return json(404, { error: "actor not found" });
      }
      const posts = (await store.listPosts(key)).slice(0, 50);
      const followers = await store.getFollowers(key);
      const following = await store.listFollowing(key);
      return json(200, {
        node: { id: `actor:${key}`, kind: "actor", subkind: actor.actorClass, label: actor.name || key, detail: actor.summary || "" },
        actor,
        postCount: posts.length,
        recentPosts: posts.slice(0, 10).map((p) => ({ id: p.id, title: p.title, form: p.form, published: p.published })),
        followerCount: followers.length,
        followingCount: following.length,
      });
    }

    if (kind === "post") {
      const post = await store.getPost(key);
      if (post == null) {
        return json(404, { error: "post not found" });
      }
      const likes = await store.listLikes(key);
      const boosts = await store.listBoosts(key);
      return json(200, {
        node: { id: `post:${key}`, kind: "object", subkind: post.form, label: post.title ?? post.content.slice(0, 60), detail: post.content },
        post,
        likeCount: likes.length,
        boostCount: boosts.length,
      });
    }

    if (kind === "object") {
      const obj = await network.getSemanticObject(key);
      if (obj == null) {
        return json(404, { error: "object not found" });
      }
      return json(200, {
        node: { id: `object:${key}`, kind: "object", subkind: obj.type, label: obj.name, detail: obj.description },
        object: obj,
      });
    }

    return json(400, { error: "unknown node kind (actor|post|object)" });
  }

  return json(404, { error: "not found" });
}
