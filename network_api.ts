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

  return json(404, { error: "not found" });
}
