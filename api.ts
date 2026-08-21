// Mycelium Local API — machine-first write/read surface.
// Framework: Mycelium (this implementation: Taproot node).
// Original code. MIT license.

import type { Federation } from "@fedify/fedify";
import { Actor, Announce, Follow, Like, Undo } from "@fedify/vocab";
import type {
  ActorClass,
  MyceliumStore,
  PostForm,
  PostRecord,
} from "./store.ts";
import { buildCreate, buildLocalMentionTags } from "./notes.ts";
import { VERSION } from "./version.ts";

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

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
    // Stored value is ALWAYS a full AP URI so federation never breaks.
    let replyUri: string | undefined;
    if (inReplyTo != null) {
      if (/^https?:\/\//.test(inReplyTo)) {
        replyUri = inReplyTo;
      } else {
        const parent = await deps.store.getPost(inReplyTo);
        if (parent == null) {
          return json(404, { error: "inReplyTo post not found" });
        }
        replyUri = parent.isRemote === true && /^https?:\/\//.test(parent.id)
          ? parent.id
          : `${deps.origin}/ap/actor/${parent.identifier}/p/${parent.id}`;
      }
    }

    const post: PostRecord = {
      id: crypto.randomUUID(),
      identifier,
      content,
      published: new Date().toISOString(),
      inReplyTo: replyUri,
      visibility: "public",
      form,
      title: title || undefined,
    };
    await deps.store.putPost(post);

    // Fan out Create to followers + mentioned local actors (notifications).
    let followersNotified = 0;
    const mentioned: string[] = [];
    try {
      const ctx = deps.federation.createContext(
        new URL(deps.origin),
        undefined,
      );
      const actors = await deps.store.listActors();
      const localActors = new Set(actors.map((a) => a.identifier));
      const mentionTags = buildLocalMentionTags(ctx, content, localActors);
      for (const t of mentionTags) {
        const href = t.href?.href ?? "";
        const name = (t.name ?? "").replace("@", "");
        if (localActors.has(name) && name !== identifier) mentioned.push(name);
      }
      const extraCcs = mentionTags.map((t) => t.href!) as URL[];
      const create = buildCreate(ctx, post, {
        mentionTags: mentionTags.length > 0 ? mentionTags : undefined,
        extraCcs: extraCcs.length > 0 ? extraCcs : undefined,
      });
      // Mention notifications for local actors.
      for (const name of mentioned) {
        await deps.store.putNotification({
          id: crypto.randomUUID(),
          type: "mention",
          identifier: name,
          fromActorId: identifier,
          postId: post.id,
          read: false,
          created: new Date().toISOString(),
        });
      }
      // Reply notification for local post targets.
      if (replyUri != null) {
        const rm = replyUri.match(
          new RegExp(`^${escapeRe(deps.origin)}/ap/actor/([^/]+)/p/[^/]+$`),
        );
        if (rm != null && rm[1] !== identifier && localActors.has(rm[1])) {
          await deps.store.putNotification({
            id: crypto.randomUUID(),
            type: "reply",
            identifier: rm[1],
            fromActorId: identifier,
            postId: post.id,
            read: false,
            created: new Date().toISOString(),
          });
        }
      }
      await ctx.sendActivity({ identifier }, "followers", create);
      followersNotified = (await deps.store.getFollowers(identifier)).length;
    } catch (e) {
      console.error("api: fan-out failed (post stored):", e);
    }

    return json(201, { ok: true, followersNotified, mentioned, post });
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

  // ── like / boost ──
  if (path === "/api/react" && request.method === "POST") {
    if (!authorized(request)) return json(401, { error: "unauthorized" });
    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return json(400, { error: "invalid json" });
    }
    const identifier = String(body.identifier ?? "").trim().toLowerCase();
    const postId = String(body.postId ?? "").trim();
    const kind = String(body.kind ?? "like").trim();
    const remove = body.remove === true;
    if (!identifier || !postId) {
      return json(400, { error: "identifier and postId required" });
    }
    if (kind !== "like" && kind !== "boost") {
      return json(400, { error: "kind must be like or boost" });
    }
    if (await deps.store.getActor(identifier) == null) {
      return json(404, { error: "unknown actor" });
    }
    const post = await deps.store.getPost(postId);
    if (post == null) {
      return json(404, { error: "unknown post" });
    }

    if (remove) {
      await deps.store.removeLike(kind, postId, identifier);
      return json(200, { ok: true, removed: true });
    }

    // Existing check — idempotent
    if (await deps.store.getLike(kind, postId, identifier) != null) {
      return json(200, { ok: true, existed: true });
    }

    await deps.store.putLike({
      id: crypto.randomUUID(),
      actorId: identifier,
      postId,
      kind,
      published: new Date().toISOString(),
    });

    // Fan out Like/Announce to followers + notify the post author when local.
    let delivered = false;
    try {
      const ctx = deps.federation.createContext(
        new URL(deps.origin),
        undefined,
      );
      const actorUri = ctx.getActorUri(identifier);
      const postUri = post.isRemote === true && /^https?:\/\//.test(post.id)
        ? new URL(post.id)
        : ctx.getActorUri(post.identifier);
      const objectUri = post.isRemote === true && /^https?:\/\//.test(post.id)
        ? new URL(post.id)
        : new URL(`/ap/actor/${post.identifier}/p/${post.id}`, postUri);
      const activity = kind === "like"
        ? new Like({
          id: new URL(`/ap/actor/${identifier}/${kind}/${crypto.randomUUID()}`, actorUri),
          actor: actorUri,
          object: objectUri,
        })
        : new Announce({
          id: new URL(`/ap/actor/${identifier}/${kind}/${crypto.randomUUID()}`, actorUri),
          actor: actorUri,
          object: objectUri,
        });
      await ctx.sendActivity({ identifier }, "followers", activity);
      delivered = true;
    } catch (e) {
      console.error("api: react fan-out failed:", e);
    }

    // Notify the author when the post is local.
    if (post.isRemote !== true && post.identifier !== identifier) {
      const localIds = new Set(
        (await deps.store.listActors()).map((a) => a.identifier),
      );
      if (localIds.has(post.identifier)) {
        await deps.store.putNotification({
          id: crypto.randomUUID(),
          type: kind === "like" ? "like" : "boost",
          identifier: post.identifier,
          fromActorId: identifier,
          postId,
          read: false,
          created: new Date().toISOString(),
        });
      }
    }

    return json(201, { ok: true, kind, postId, delivered });
  }

  // ── notifications ──
  if (path === "/api/notifications" && request.method === "GET") {
    const identifier = (url.searchParams.get("actor") ?? "").trim().toLowerCase();
    if (!identifier) return json(400, { error: "actor query param required" });
    const unreadOnly = url.searchParams.get("unread") === "true";
    const limit = Math.min(
      Math.max(parseInt(url.searchParams.get("limit") ?? "50") || 50, 1),
      200,
    );
    const notifications = (await deps.store.listNotifications(identifier, unreadOnly))
      .slice(0, limit);
    const unread = (await deps.store.listNotifications(identifier, true)).length;
    return json(200, { count: notifications.length, unread, notifications });
  }

  if (path === "/api/notifications/read" && request.method === "POST") {
    if (!authorized(request)) return json(401, { error: "unauthorized" });
    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return json(400, { error: "invalid json" });
    }
    const identifier = String(body.identifier ?? "").trim().toLowerCase();
    const id = body.id == null ? null : String(body.id);
    if (!identifier) return json(400, { error: "identifier required" });
    if (id == null) {
      await deps.store.markAllNotificationsRead(identifier);
      return json(200, { ok: true, all: true });
    }
    await deps.store.markNotificationRead(identifier, id);
    return json(200, { ok: true, id });
  }

  // ── outbound follow ──
  if (path === "/api/follow" && request.method === "POST") {
    if (!authorized(request)) return json(401, { error: "unauthorized" });
    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return json(400, { error: "invalid json" });
    }
    const identifier = String(body.identifier ?? "").trim().toLowerCase();
    const target = String(body.target ?? "").trim(); // actor URI or @name@host
    const remove = body.remove === true;
    if (!identifier || !target) {
      return json(400, { error: "identifier and target required" });
    }
    if (await deps.store.getActor(identifier) == null) {
      return json(404, { error: "unknown actor" });
    }

    // Normalize target to an actor URI.
    let targetUri: URL;
    if (/^https?:\/\//.test(target)) {
      targetUri = new URL(target);
    } else if (/^@?[a-z0-9_]{1,64}@([a-z0-9.-]+)$/i.test(target)) {
      const handle = target.replace(/^@/, "");
      const at = handle.indexOf("@");
      const name = handle.slice(0, at);
      const host = handle.slice(at + 1);
      // Mastodon-style actor URI via webfinger-less heuristic:
      // resolve through Fedify lookupObject with acct uri
      const ctx = deps.federation.createContext(new URL(deps.origin), undefined);
      const actor = await ctx.lookupObject(`acct:${name}@${host}`) as Actor | null;
      if (actor?.id == null) {
        return json(404, { error: `cannot resolve ${target}` });
      }
      targetUri = actor.id;
    } else {
      return json(400, { error: "target must be an actor URI or @name@host" });
    }

    if (remove) {
      const existing = await deps.store.getFollowing(identifier, targetUri.href);
      if (existing == null) return json(200, { ok: true, removed: false });
      try {
        const ctx = deps.federation.createContext(
          new URL(deps.origin),
          undefined,
        );
        const actor = await ctx.lookupObject(targetUri) as Actor | null;
        if (actor != null) {
          const undo = new Undo({
            actor: ctx.getActorUri(identifier),
            object: new Follow({
              id: new URL(existing.id),
              actor: ctx.getActorUri(identifier),
              object: targetUri,
            }),
          });
          await ctx.sendActivity({ identifier }, actor, undo);
        }
      } catch (e) {
        console.error("api: unfollow delivery failed:", e);
      }
      await deps.store.removeFollowing(identifier, existing.id);
      return json(200, { ok: true, removed: true });
    }

    // Idempotent
    const existing = await deps.store.getFollowing(identifier, targetUri.href);
    if (existing != null) {
      return json(200, { ok: true, existed: true, target: targetUri.href });
    }

    const followId = crypto.randomUUID();
    let inbox: string | null = null;
    try {
      const ctx = deps.federation.createContext(
        new URL(deps.origin),
        undefined,
      );
      const actor = await ctx.lookupObject(targetUri) as Actor | null;
      if (actor != null) {
        inbox = actor.inboxId?.href ?? null;
        const follow = new Follow({
          id: new URL(`/ap/actor/${identifier}/follow/${followId}`, ctx.getActorUri(identifier)),
          actor: ctx.getActorUri(identifier),
          object: targetUri,
        });
        await ctx.sendActivity({ identifier }, actor, follow);
      } else {
        return json(404, { error: `cannot resolve ${targetUri.href}` });
      }
    } catch (e) {
      console.error("api: follow delivery failed:", e);
      return json(502, { error: "follow delivery failed", detail: String(e) });
    }

    await deps.store.putFollowing({
      id: followId,
      identifier,
      targetId: targetUri.href,
      targetInbox: inbox,
      followed: new Date().toISOString(),
    });
    return json(201, { ok: true, target: targetUri.href });
  }

  // ── following list ──
  if (path === "/api/following" && request.method === "GET") {
    const identifier = (url.searchParams.get("actor") ?? "").trim().toLowerCase();
    if (!identifier) return json(400, { error: "actor query param required" });
    const following = await deps.store.listFollowing(identifier);
    return json(200, { count: following.length, following });
  }

  // ── post interactions (likes/boosts per post) ──
  if (path === "/api/post/interactions" && request.method === "GET") {
    const postId = (url.searchParams.get("postId") ?? "").trim();
    if (!postId) return json(400, { error: "postId query param required" });
    const [likes, boosts] = await Promise.all([
      deps.store.listLikes(postId),
      deps.store.listBoosts(postId),
    ]);
    return json(200, {
      postId,
      likes: likes.map((l) => l.actorId),
      boosts: boosts.map((b) => b.actorId),
      likeCount: likes.length,
      boostCount: boosts.length,
    });
  }

  return json(404, { error: "not found" });
}
