// Network projection API — graph as derived view of canonical state.
// Original code. MIT license.

import type { MyceliumStore, PostRecord } from "./store.ts";
import type { NetworkProjection, SemanticObject, SemanticLink } from "./network.ts";
import type { TokenAuth } from "./auth.ts";
import type { NodeRateLimits } from "./ratelimit.ts";

export interface NetworkDeps {
  store: MyceliumStore;
  network: NetworkProjection;
  origin: string;
  auth?: TokenAuth;
  rateLimits?: NodeRateLimits;
  adminToken?: string;
}

import { clientKey } from "./ratelimit.ts";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/** Real authentication for semantic-graph writes.
 * Admin token OR any valid per-actor token. An arbitrary string >7 chars
 * is NOT sufficient (audit CRITICAL fix: auth bypass). */
export async function bearerOk(
  request: Request,
  deps: NetworkDeps,
): Promise<boolean> {
  const h = request.headers.get("authorization") ?? "";
  if (!h.startsWith("Bearer ")) return false;
  const token = h.slice(7);
  if (deps.adminToken != null && token === deps.adminToken) return true;
  if (deps.auth == null) return false;
  const actor = await deps.auth.authenticate(token);
  return actor != null;
}

const SEMANTIC_TYPES = new Set(["topic", "concept", "project"]);

/** Read-path rate limit guard (audit MEDIUM: limiter existed but was never wired). */
function readLimited(request: Request, deps: NetworkDeps): boolean {
  return deps.rateLimits?.read.allow(clientKey(request)) === false;
}

/** Write-path rate limit for semantic writes (audit MEDIUM: write limiter
 *  covered post/react/follow but NOT network object/link — unthrottled spam). */
function writeLimited(request: Request, deps: NetworkDeps): boolean {
  return deps.rateLimits?.write.allow(clientKey(request)) === false;
}

/** Authenticated identity for provenance: "__admin__" or actor identifier.
 *  null = unauthenticated. (audit HIGH: semantic writes had no provenance.) */
export async function authenticatedActor(
  request: Request,
  deps: NetworkDeps,
): Promise<string | null> {
  const h = request.headers.get("authorization") ?? "";
  if (!h.startsWith("Bearer ")) return null;
  const token = h.slice(7);
  if (deps.adminToken != null && token === deps.adminToken) return "__admin__";
  if (deps.auth == null) return null;
  return await deps.auth.authenticate(token);
}

/** Public-surface post filter: remote posts render only when explicitly
 *  public/unlisted (audit CRITICAL: private remote content disclosure). */
function visiblePosts(posts: PostRecord[]): PostRecord[] {
  return posts.filter((p) =>
    p.isRemote !== true || p.visibility === "public" ||
    p.visibility === "unlisted"
  );
}

// Deletion policy (audit HIGH v0.9.0): creator or admin. Rows without
// provenance (legacy migrations, createdBy == null) are ADMIN-ONLY —
// missing provenance must not mean anyone-can-delete.
export function canDelete(
  caller: string,
  createdBy: string | null | undefined,
): boolean {
  if (caller === "__admin__") return true;
  if (createdBy == null) return false;
  return createdBy === caller;
}

export async function handleNetwork(
  request: Request,
  deps: NetworkDeps,
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const { store, network } = deps;

  // Full graph projection
  if (path === "/api/network/graph" && request.method === "GET") {
    if (readLimited(request, deps)) return json(429, { error: "rate limit exceeded" });
    const [actors, allPosts] = await Promise.all([
      store.listActors(),
      store.listPosts(null),
    ]);
    const graph = await network.build(
      actors,
      visiblePosts(allPosts),
      async (id) => (await store.getFollowers(id)).map((f) => f.followerId),
      async (id) => store.listFollowing(id),
    );
    return json(200, graph);
  }

  // Semantic objects list
  if (path === "/api/network/objects" && request.method === "GET") {
    if (readLimited(request, deps)) return json(429, { error: "rate limit exceeded" });
    const type = url.searchParams.get("type");
    const objects = await network.listSemanticObjects(type);
    return json(200, { count: objects.length, objects });
  }

  // Create semantic object
  if (path === "/api/network/object" && request.method === "POST") {
    const creator = await authenticatedActor(request, deps);
    if (creator == null) return json(401, { error: "unauthorized" });
    if (writeLimited(request, deps)) return json(429, { error: "rate limit exceeded" });
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
      createdBy: creator,
      created: new Date().toISOString(),
    };
    await network.putSemanticObject(obj);
    return json(201, { ok: true, object: obj });
  }

  // Semantic link between objects
  if (path === "/api/network/link" && request.method === "POST") {
    const creator = await authenticatedActor(request, deps);
    if (creator == null) return json(401, { error: "unauthorized" });
    if (writeLimited(request, deps)) return json(429, { error: "rate limit exceeded" });
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
      createdBy: creator,
      created: new Date().toISOString(),
    };
    await network.putSemanticLink(link);
    return json(201, { ok: true, link });
  }

  // Moderation: delete semantic object (admin or creator only)
  if (path.startsWith("/api/network/object/") && request.method === "DELETE") {
    const caller = await authenticatedActor(request, deps);
    if (caller == null) return json(401, { error: "unauthorized" });
    const id = decodeURIComponent(path.slice("/api/network/object/".length));
    const obj = await network.getSemanticObject(id);
    if (obj == null) return json(404, { error: "object not found" });
    if (!canDelete(caller, obj.createdBy)) {
      return json(403, { error: "only creator or admin may delete (legacy rows: admin only)" });
    }
    await network.deleteSemanticObject(id);
    return json(200, { ok: true, deleted: id });
  }

  // Moderation: delete semantic link (admin or creator only)
  if (path.startsWith("/api/network/link/") && request.method === "DELETE") {
    const caller = await authenticatedActor(request, deps);
    if (caller == null) return json(401, { error: "unauthorized" });
    const id = decodeURIComponent(path.slice("/api/network/link/".length));
    const link = await network.getSemanticLink(id);
    if (link == null) return json(404, { error: "link not found" });
    if (!canDelete(caller, link.createdBy)) {
      return json(403, { error: "only creator or admin may delete (legacy rows: admin only)" });
    }
    await network.deleteSemanticLink(id);
    return json(200, { ok: true, deleted: id });
  }

  // ── per-node navigation APIs (graph-as-navigation, v0.5) ──

  // Node neighbors: 1-hop edges + connected nodes, filterable by relation
  // (must run before the node-detail handler so the /neighbors suffix routes here)
  if (path.startsWith("/api/network/node/") && path.endsWith("/neighbors") &&
      request.method === "GET") {
    if (readLimited(request, deps)) return json(429, { error: "rate limit exceeded" });
    const rawId = decodeURIComponent(
      path.slice("/api/network/node/".length, -"/neighbors".length),
    );
    const relFilter = (url.searchParams.get("relation") ?? "")
      .split(",").map((r) => r.trim()).filter(Boolean);
    const limit = Math.min(
      Math.max(Number(url.searchParams.get("limit") ?? 50) || 50, 1),
      200,
    );

    const [actors, allPosts] = await Promise.all([
      store.listActors(),
      store.listPosts(null),
    ]);
    const graph = await network.build(
      actors,
      visiblePosts(allPosts),
      async (id) => (await store.getFollowers(id)).map((f) => f.followerId),
      async (id) => store.listFollowing(id),
    );

    const node = graph.nodes.find((n) => n.id === rawId);
    if (node == null) {
      return json(404, { error: "node not found in graph" });
    }

    const nodeMap = new Map(graph.nodes.map((n) => [n.id, n]));
    // Filter matches edge.kind OR the original relation label: semantic
    // links collapse to about/relates-to kinds but keep label=relation
    // (audit MEDIUM: ?relation=part-of never matched anything).
    const edges = graph.edges.filter((e) => {
      if (e.from !== rawId && e.to !== rawId) return false;
      if (relFilter.length > 0 && e.label == null &&
          !relFilter.includes(e.kind)) return false;
      if (relFilter.length > 0 && e.label != null &&
          !relFilter.includes(e.kind) && !relFilter.includes(e.label)) {
        return false;
      }
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
    if (readLimited(request, deps)) return json(429, { error: "rate limit exceeded" });
    const rawId = decodeURIComponent(path.slice("/api/network/node/".length));
    // Split on FIRST colon only: remote ids carry colons (actor:name@host,
    // post:https://...). split(":", 2) truncated them (audit HIGH fix).
    const ci = rawId.indexOf(":");
    if (ci < 1) {
      return json(400, { error: "node id must be kind:id (actor:foo, post:uuid, object:uuid)" });
    }
    const kind = rawId.slice(0, ci);
    const key = rawId.slice(ci + 1);

    if (kind === "actor") {
      const actor = await store.getActor(key);
      if (actor == null) {
        // Remote actor (name@host / URI): serve the graph projection node
        // instead of 404 (audit: remote actor navigation broke the GUI).
        const [as2, ap2] = await Promise.all([
          store.listActors(),
          store.listPosts(null),
        ]);
        const g2 = await network.build(
          as2,
          visiblePosts(ap2),
          async (id) => (await store.getFollowers(id)).map((f) => f.followerId),
          async (id) => store.listFollowing(id),
        );
        const rn = g2.nodes.find((n) => n.id === rawId);
        if (rn == null) return json(404, { error: "actor not found" });
        return json(200, {
          node: rn,
          actor: null,
          remote: true,
          detail: rn.detail ?? "",
        });
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
      let post = await store.getPost(key);
      if (post == null && /^https?:\/\//.test(key)) {
        // remote posts store their URI as the KV key — try suffix match
        const m = key.match(/\/p\/([^/]+)$/);
        if (m) post = await store.getPost(m[1]);
      }
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
