// Mycelium Local API — machine-first write/read surface.
// Framework: Mycelium (this implementation: Taproot node).
// Original code. MIT license.

import type { Federation } from "@fedify/fedify";
import type { ActorClass, MyceliumStore, PostForm, PostRecord } from "./store.ts";
import { buildCreate } from "./notes.ts";
import { VERSION } from "./version.ts";

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
const MAX_TITLE = 200;
const ACTOR_CLASSES = new Set([
  "person", "agent", "service", "group", "application", "instance",
]);
const POST_FORMS = new Set<PostForm>(["short", "long"]);

export async function handleApi(
  request: Request,
  deps: ApiDeps,
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === "/api/health") {
    return json(200, { ok: true, software: "mycelium", version: VERSION });
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
      : String(body.inReplyTo).trim();
    const form = String(body.form ?? "short").trim() as PostForm;
    const title = body.title == null
      ? undefined
      : String(body.title).trim();
    if (!identifier || !content) {
      return json(400, { error: "identifier and content required" });
    }
    if (content.length > MAX_CONTENT) {
      return json(400, { error: `content too long (max ${MAX_CONTENT})` });
    }
    if (!POST_FORMS.has(form)) {
      return json(400, { error: `form must be short or long` });
    }
    if (form === "long" && !title) {
      return json(400, { error: "title required for long-form posts" });
    }
    if (title != null && title.length > MAX_TITLE) {
      return json(400, { error: `title too long (max ${MAX_TITLE})` });
    }
    if (await deps.store.getActor(identifier) == null) {
      return json(404, { error: "unknown actor" });
    }
    // Reply target must exist: local post id or remote URI.
    if (inReplyTo != null) {
      const isUri = /^https?:\/\//.test(inReplyTo);
      if (!isUri && (await deps.store.getPost(inReplyTo)) == null) {
        return json(404, { error: "inReplyTo post not found" });
      }
    }

    const post: PostRecord = {
      id: crypto.randomUUID(),
      identifier,
      content,
      published: new Date().toISOString(),
      inReplyTo,
      visibility: "public",
      form,
      title: title || undefined,
    };
    await deps.store.putPost(post);

    // Fan out Create to followers (no-op with zero followers).
    let followersNotified = 0;
    try {
      const ctx = deps.federation.createContext(
        new URL(deps.origin),
        undefined,
      );
      const create = buildCreate(ctx, post);
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
    const formParam = url.searchParams.get("form");
    const form = formParam == null || formParam === ""
      ? null
      : (formParam as PostForm);
    if (form != null && !POST_FORMS.has(form)) {
      return json(400, { error: "form must be short or long" });
    }
    const limit = Math.min(
      Math.max(parseInt(url.searchParams.get("limit") ?? "50") || 50, 1),
      200,
    );
    const posts = (await deps.store.listPosts(identifier))
      .filter((p) => form == null || (p.form ?? "short") === form)
      .filter((p) => p.isRemote !== true || p.identifier === identifier)
      .sort((a, b) => b.published.localeCompare(a.published))
      .slice(0, limit);
    return json(200, { count: posts.length, posts });
  }

  return json(404, { error: "not found" });
}
