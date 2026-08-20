// Knowledge graph API routes. Clean-room original code. MIT license.

import { ENTITY_TYPES, type KgStore } from "./kg.ts";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function authorized(request: Request, token: string | null): boolean {
  if (token == null || token === "") return false;
  return (request.headers.get("authorization") ?? "") === `Bearer ${token}`;
}

export async function handleKg(
  request: Request,
  kg: KgStore,
  token: string | null,
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === "/api/kg/entities" && request.method === "GET") {
    const type = url.searchParams.get("type");
    const entities = await kg.listEntities(type);
    return json(200, { count: entities.length, entities });
  }

  if (path === "/api/kg/entity" && request.method === "POST") {
    if (!authorized(request, token)) return json(401, { error: "unauthorized" });
    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return json(400, { error: "invalid json" });
    }
    const type = String(body.type ?? "topic").trim();
    const name = String(body.name ?? "").trim();
    const description = String(body.description ?? "").trim();
    const category = String(body.category ?? type).trim();
    const tags = Array.isArray(body.tags)
      ? body.tags.map((t) => String(t).trim().toLowerCase()).filter(Boolean).slice(0, 12)
      : [];
    const linkedActor = body.linkedActor == null
      ? undefined
      : String(body.linkedActor).trim().toLowerCase();
    if (!name) return json(400, { error: "name required" });
    if (!ENTITY_TYPES.has(type)) {
      return json(400, { error: `type must be one of ${[...ENTITY_TYPES].join(", ")}` });
    }
    if (description.length > 2000) {
      return json(400, { error: "description too long (max 2000)" });
    }
    const entity = {
      id: crypto.randomUUID(),
      type,
      name,
      description,
      category,
      tags,
      linkedActor,
      created: new Date().toISOString(),
    };
    await kg.putEntity(entity);
    return json(201, { ok: true, entity });
  }

  if (path === "/api/kg/edge" && request.method === "POST") {
    if (!authorized(request, token)) return json(401, { error: "unauthorized" });
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
    if (await kg.getEntity(fromId) == null) {
      return json(404, { error: "from entity not found" });
    }
    if (await kg.getEntity(toId) == null) {
      return json(404, { error: "to entity not found" });
    }
    const edge = {
      id: crypto.randomUUID(),
      fromId,
      toId,
      relation,
      weight,
      note,
      created: new Date().toISOString(),
    };
    await kg.putEdge(edge);
    return json(201, { ok: true, edge });
  }

  if (path === "/api/kg/graph" && request.method === "GET") {
    return json(200, await kg.graph());
  }

  if (path.startsWith("/api/kg/entity/") && request.method === "GET") {
    const id = path.slice("/api/kg/entity/".length);
    const entity = await kg.getEntity(id);
    if (entity == null) return json(404, { error: "not found" });
    const edges = (await kg.listEdges()).filter(
      (e) => e.fromId === id || e.toId === id,
    );
    const connected = (await Promise.all(
      edges.map(async (e) => {
        const other = e.fromId === id ? e.toId : e.fromId;
        return { edge: e, entity: await kg.getEntity(other) };
      }),
    )).filter((x) => x.entity != null);
    return json(200, { entity, connections: connected });
  }

  return json(404, { error: "not found" });
}
