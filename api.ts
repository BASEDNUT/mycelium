// Mycelium Local API — machine-first write/read surface.
// Clean-room original code. MIT license.

import type { Federation } from "@fedify/fedify";
import { Create, Note, PUBLIC_COLLECTION } from "@fedify/vocab";
import type { ActorClass, MyceliumStore, PostRecord } from "./store.ts";

export interface ApiDeps {
  store: MyceliumStore;
  federation: Federation<void>;
  origin: string;
}

let apiToken: string | null = null;

export function getToken(): string | null {
  return apiToken;
}

export async function loadToken(path: string): Promise<void> {
  try {
    apiToken = (await Deno.readTextFile(path)).trim();
  } catch {
    apiToken = null;
    console.warn(`api: no token file at ${path}; write endpoints disabled`);
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function authorized(request: Request): boolean {
  if (apiToken == null || apiToken === "") return false;
  const auth = request.headers.get("authorization") ?? "";
  return auth === `Bearer ${apiToken}`;
}

const MAX_CONTENT = 5000;
const ACTOR_CLASSES = new Set([
  "person", "agent", "service", "group", "application", "instance",
]);

export async function handleApi(
  request: Request,
  deps: ApiDeps,
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === "/api/health") {
    return json(200, { ok: true, software: "mycelium", version: "0.1.0" });
  }

  if (path === "/api/actors" && request.method === "GET") {
    const actors = await deps.store.listActors();
    return json(200, { count: actors.length, actors });
  }

  if (path === "/api/actor" && request.method === "POST") {
    if (!authorized(request)) return json(401, { error: "unauthorized" });
    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return json(400, { error: "invalid json" });
    }
    const identifier = String(body.identifier ?? "").trim().toLowerCase();
    const actorClass = String(body.actorClass ?? "agent").trim();
    const name = String(body.name ?? identifier).trim();
    const summary = String(body.summary ?? "").trim();
    if (!/^[a-z0-9_]{1,64}$/.test(identifier)) {
      return json(400, { error: "identifier must match [a-z0-9_]{1,64}" });
    }
    if (!ACTOR_CLASSES.has(actorClass)) {
      return json(400, {
        error: `actorClass must be one of ${[...ACTOR_CLASSES].join(", ")}`,
      });
    }
    if (await deps.store.getActor(identifier) != null) {
      return json(409, { error: "actor exists" });
    }
    await deps.store.putActor({
      identifier,
      actorClass: actorClass as ActorClass,
      name,
      summary,
      created: new Date().toISOString(),
      discoverable: true,
    });
    return json(201, {
      ok: true,
      actor: { identifier, actorClass, name },
      webfinger: `acct:${identifier}@${new URL(deps.origin).host}`,
    });
  }

  if (path === "/api/post" && request.method === "POST") {
    if (!authorized(request)) return json(401, { error: "unauthorized" });
    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return json(400, { error: "invalid json" });
    }
    const identifier = String(body.identifier ?? "").trim().toLowerCase();
    const content = String(body.content ?? "").trim();
    const inReplyTo = body.inReplyTo == null
      ? undefined
      : String(body.inReplyTo);
    if (!identifier || !content) {
      return json(400, { error: "identifier and content required" });
    }
    if (content.length > MAX_CONTENT) {
      return json(400, { error: `content too long (max ${MAX_CONTENT})` });
    }
    if (await deps.store.getActor(identifier) == null) {
      return json(404, { error: "unknown actor" });
    }

    const post: PostRecord = {
      id: crypto.randomUUID(),
      identifier,
      content,
      published: new Date().toISOString(),
      inReplyTo,
      visibility: "public",
    };
    await deps.store.putPost(post);

    // Fan out Create to followers (no-op with zero followers).
    let followersNotified = 0;
    try {
      const ctx = deps.federation.createContext(
        new URL(deps.origin),
        undefined,
      );
      const actorUri = ctx.getActorUri(identifier);
      const note = new Note({
        id: new URL(`/ap/actor/${identifier}/p/${post.id}`, actorUri),
        attribution: actorUri,
        content: post.content,
        published: Temporal.Instant.from(post.published),
        tos: [PUBLIC_COLLECTION],
        ccs: [new URL(`${actorUri.href}/followers`)],
      });
      const create = new Create({
        id: new URL(`/ap/actor/${identifier}/p/${post.id}#create`, actorUri),
        actor: actorUri,
        object: note,
        tos: [PUBLIC_COLLECTION],
        ccs: [new URL(`${actorUri.href}/followers`)],
      });
      await ctx.sendActivity({ identifier }, "followers", create);
      followersNotified = (await deps.store.getFollowers(identifier)).length;
    } catch (e) {
      console.error("api: fan-out failed (post stored):", e);
    }

    return json(201, { ok: true, followersNotified, post });
  }

  if (path === "/api/feed" && request.method === "GET") {
    const actorParam = url.searchParams.get("actor");
    const identifier = actorParam == null || actorParam === ""
      ? null
      : actorParam.trim().toLowerCase();
    const limit = Math.min(
      Math.max(parseInt(url.searchParams.get("limit") ?? "50") || 50, 1),
      200,
    );
    const posts = (await deps.store.listPosts(identifier))
      .filter((p) => !p.identifier.startsWith("__remote__"))
      .sort((a, b) => b.published.localeCompare(a.published))
      .slice(0, limit);
    return json(200, { count: posts.length, posts });
  }

  return json(404, { error: "not found" });
}
