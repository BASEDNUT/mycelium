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
  SubrootArchetype,
  SubrootConfig,
  SubrootRecord,
  DmRecord,
  BookmarkRecord,
  ReportRecord,
  ReportReason,
} from "./store.ts";
import { REPORT_REASONS } from "./store.ts";
import { anonFilter } from "./mod_filter.ts";
import { hotScore, wilsonScore } from "./ranking.ts";
import { buildCreate, buildLocalMentionTags } from "./notes.ts";
import { TokenAuth } from "./auth.ts";
import type { NodeRateLimits } from "./ratelimit.ts";
import { clientKey } from "./ratelimit.ts";
import { assertFederatable, assertFederatableHost } from "./ssrf.ts";
import { extractPosts, OutboxCache, webfingerUrl } from "./outbox.ts";
import { VERSION } from "./version.ts";

// v0.20.0 — external outbox cache (60s TTL) for the deck view.
const outboxCache = new OutboxCache(60_000);

/** v0.20.0 — append-only audit trail writer. Fire-and-forget safe. */
async function audit(
  deps: ApiDeps,
  actor: string,
  action: string,
  target: string,
  reason?: string,
): Promise<void> {
  try {
    await deps.store.putAudit({
      id: crypto.randomUUID(),
      actor,
      action,
      target,
      reason,
      ts: new Date().toISOString(),
    });
  } catch {
    // audit must never break the primary operation
  }
}

// Deterministic Like/Announce activity ID so a later Undo can reference the
// exact same activity (audit v0.9.1: random UUIDs made Undo impossible).
export function likeActivityId(
  origin: string,
  identifier: string,
  kind: "like" | "boost",
  postId: string,
): URL {
  return new URL(
    `/ap/actor/${encodeURIComponent(identifier)}/${kind}/${encodeURIComponent(postId)}`,
    origin,
  );
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface ApiDeps {
  store: MyceliumStore;
  federation: Federation<void>;
  origin: string;
  auth: TokenAuth;
  rateLimits: NodeRateLimits;
  adminToken: string;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function bearer(request: Request): string | null {
  const auth = request.headers.get("authorization") ?? "";
  return auth.startsWith("Bearer ") ? auth.slice(7) : null;
}

/** v0.19.1 (external audit): write/federation limits bind to the bearer
 * token when present, so a leaked token cannot be hammered from many
 * IPs; anonymous requests fall back to the client IP key. */
function writeKey(request: Request): string {
  const t = bearer(request);
  return "tok:" + (t ?? clientKey(request));
}

/** Admin (operator) authorization — token management + bootstrap only. */
function isAdmin(request: Request, deps: ApiDeps): boolean {
  const t = bearer(request);
  return t != null && t === deps.adminToken;
}

/** Authenticate the request as a SPECIFIC actor via per-actor token. */
async function requireActor(
  request: Request,
  deps: ApiDeps,
  identifier: string,
): Promise<boolean> {
  const t = bearer(request);
  if (t == null) return false;
  if (t === deps.adminToken) return true; // operator may act as any local actor
  const actor = await deps.auth.authenticate(t);
  return actor === identifier;
}

function tooMany(): Response {
  return json(429, { error: "rate limit exceeded" });
}

/** Read-path rate limit guard (audit MEDIUM: limiter existed but was never wired). */
function readLimited(request: Request, deps: ApiDeps): boolean {
  return deps.rateLimits?.read.allow(clientKey(request)) === false;
}

const MAX_CONTENT = 5000;
const MAX_TITLE = 200;
const ACTOR_CLASSES = new Set([
  "person", "agent", "service", "group", "application", "instance",
]);
const POST_FORMS = new Set<PostForm>(["short", "long"]);

// ── subroots (v0.11.0) ──
const SUBROOT_ARCHETYPES = new Set<SubrootArchetype>([
  "feed",
  "board",
  "forum",
  "meta",
]);
const SUBROOT_SLUG = /^[a-z0-9-]{1,32}$/;
const MAX_SUBROOT_TITLE = 96;
const MAX_SUBROOT_DESC = 500;

/** Pure validation for subroot creation (mycelium-native, admin-gated). */
export function validateSubroot(input: {
  slug: string;
  archetype: string;
  title: string;
  description: string;
  icon?: string;
  url?: string;
  config: { votes: boolean; anonymous: boolean; retentionDays: number | null };
}): { valid: true; record: SubrootRecord } | { valid: false; error: string } {
  const { slug, archetype, title, description, config } = input;
  if (!SUBROOT_SLUG.test(slug)) {
    return { valid: false, error: "slug must match [a-z0-9-]{1,32}" };
  }
  if (!SUBROOT_ARCHETYPES.has(archetype as SubrootArchetype)) {
    return {
      valid: false,
      error: "archetype must be feed, board, forum, or meta",
    };
  }
  if (!title || title.length > MAX_SUBROOT_TITLE) {
    return { valid: false, error: `title required (max ${MAX_SUBROOT_TITLE})` };
  }
  if (description.length > MAX_SUBROOT_DESC) {
    return { valid: false, error: `description too long (max ${MAX_SUBROOT_DESC})` };
  }
  const ret = config.retentionDays;
  if (archetype === "board" && (ret == null || ret < 1 || ret > 365)) {
    return { valid: false, error: "board requires retentionDays 1-365" };
  }
  if (archetype !== "board" && ret != null) {
    return { valid: false, error: "retentionDays only allowed on board archetype" };
  }
  if (archetype === "meta" && config.anonymous === true) {
    return { valid: false, error: "meta subroots cannot be anonymous" };
  }
  const icon = (input.icon ?? "").trim().slice(0, 16);
  const url = (input.url ?? "").trim();
  if (url !== "" && !/^https?:\/\/\S{1,300}$/.test(url)) {
    return { valid: false, error: "url must be http(s) link" };
  }
  return {
    valid: true,
    record: {
      slug,
      archetype: archetype as SubrootArchetype,
      title,
      description,
      icon,
      url,
      config: {
        votes: config.votes === true,
        anonymous: config.anonymous === true,
        retentionDays: ret ?? null,
      },
      creator: "", // filled by caller (admin bootstrap or system seed)
      mods: [],
      created: new Date().toISOString(),
    },
  };
}

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
    if (readLimited(request, deps)) return tooMany();
    const actors = await deps.store.listActors();
    return json(200, { count: actors.length, actors });
  }

  if (path === "/api/actor" && request.method === "POST") {
    if (!isAdmin(request, deps)) return json(401, { error: "admin token required" });
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
    if (!deps.rateLimits.write.allow(writeKey(request))) return tooMany();
    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return json(400, { error: "invalid json" });
    }
    const identifier = String(body.identifier ?? "").trim().toLowerCase();
    const content = String(body.content ?? "").trim();
    // v0.13.0: anonymous board posting — no account needed inside boards
    // configured anonymous:true. Author forced to the system "anonymous" actor.
    const anonSlug = body.subroot == null ? null : String(body.subroot).trim().toLowerCase();
    let postingAs = identifier;
    if (body.anonymous === true && anonSlug != null && SUBROOT_SLUG.test(anonSlug)) {
      const sr = await deps.store.getSubroot(anonSlug);
      if (sr == null) return json(404, { error: "unknown subroot" });
      if (sr.archetype !== "board" || sr.config.anonymous !== true) {
        return json(403, { error: "anonymous posting only allowed on anonymous boards" });
      }
      postingAs = "anonymous";
      if (await deps.store.getActor("anonymous") == null) {
        return json(500, { error: "anonymous actor missing on node" });
      }
    } else if (!(await requireActor(request, deps, identifier))) {
      return json(401, { error: "unauthorized for actor: " + identifier });
    }
    const inReplyTo = body.inReplyTo == null
      ? undefined
      : String(body.inReplyTo).trim();
    const form = String(body.form ?? "short").trim() as PostForm;
    const title = body.title == null
      ? undefined
      : String(body.title).trim();
    if (!postingAs || !content) {
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
    // v0.16.0: optional image — https URL only, bounded length.
    const MAX_IMAGE_URL = 2048;
    let image: string | undefined;
    if (body.image != null) {
      image = String(body.image).trim();
      if (!/^https:\/\//.test(image) || image.length > MAX_IMAGE_URL) {
        return json(400, { error: `image must be an https URL (max ${MAX_IMAGE_URL})` });
      }
    }
    // v0.17.0: anonymous board rules — links and images rejected at post time.
    // NSFW / shilling / illegal / stolen-content rules are mod-enforced (docs/board-rules-v1.md).
    if (postingAs === "anonymous") {
      if (image != null) {
        return json(403, { error: "anonymous posts cannot attach images" });
      }
      if (/(https?:\/\/|www\.)\S+/i.test(content)) {
        return json(403, { error: "anonymous posts cannot contain links" });
      }
      // v0.19.0: content pre-filter — high-confidence shill/NSFW-solicitation/threat
      // patterns rejected at post time. Everything else stays mod-enforced.
      const verdict = anonFilter(content);
      if (!verdict.ok) {
        return json(403, { error: "rejected by anonymous content filter", reason: verdict.reason });
      }
    }
    if (await deps.store.getActor(postingAs) == null) {
      return json(404, { error: "unknown actor" });
    }
    // v0.14.0: subroot REQUIRED on every post. Replies inherit the parent's root.
    let subrootRaw = body.subroot == null
      ? undefined
      : String(body.subroot).trim().toLowerCase();
    if (inReplyTo != null && subrootRaw == null) {
      if (!/^https?:\//.test(inReplyTo)) {
        const parent0 = await deps.store.getPost(inReplyTo);
        if (parent0 != null && parent0.subroot != null) subrootRaw = parent0.subroot;
      }
    }
    if (subrootRaw == null) {
      return json(400, { error: "subroot required — every post must live in a root (/r/...)" });
    }
    if (!SUBROOT_SLUG.test(subrootRaw)) {
      return json(400, { error: "invalid subroot slug" });
    }
    const targetRoot = await deps.store.getSubroot(subrootRaw);
    if (targetRoot == null) {
      return json(404, { error: "unknown subroot" });
    }
    // v0.14.0: board archetype = short form only (subjects allowed); forum = long form only; feed = short only.
    // v0.15.0: board accepts both short and long form (normal forum posts).
    if (targetRoot.archetype === "forum" && form !== "long") {
      return json(400, { error: "forum roots accept long-form topics only" });
    }
    if (targetRoot.archetype === "feed" && form !== "short") {
      return json(400, { error: "feed root accepts short posts only" });
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
      identifier: postingAs,
      content,
      published: new Date().toISOString(),
      inReplyTo: replyUri,
      visibility: "public",
      form,
      title: title || undefined,
      subroot: subrootRaw,
      image,
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
        if (localActors.has(name) && name !== postingAs) mentioned.push(name);
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
          fromActorId: postingAs,
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
        if (rm != null && rm[1] !== postingAs && localActors.has(rm[1])) {
          await deps.store.putNotification({
            id: crypto.randomUUID(),
            type: "reply",
            identifier: rm[1],
            fromActorId: postingAs,
            postId: post.id,
            read: false,
            created: new Date().toISOString(),
          });
        }
      }
      await ctx.sendActivity({ identifier: postingAs }, "followers", create);
      followersNotified = (await deps.store.getFollowers(postingAs)).length;
    } catch (e) {
      console.error("api: fan-out failed (post stored):", e);
    }

    return json(201, { ok: true, followersNotified, mentioned, post });
  }

  // ── subroots (v0.11.0) ──
  // v0.14.0: delete a post. Author of the post, a moderator of the post's
  // subroot, or the admin token may remove it.
  if (path === "/api/post" && request.method === "DELETE") {
    if (!deps.rateLimits.write.allow(writeKey(request))) return tooMany();
    const id = (url.searchParams.get("id") ?? "").trim();
    if (!id) return json(400, { error: "id query param required" });
    const post = await deps.store.getPost(id);
    if (post == null) return json(404, { error: "post not found" });
    const t = bearer(request);
    if (t == null) return json(401, { error: "auth required" });
    let allowed = t === deps.adminToken || post.identifier === (await deps.auth.authenticate(t));
    if (!allowed && post.subroot != null) {
      const sr = await deps.store.getSubroot(post.subroot);
      const actor = await deps.auth.authenticate(t);
      allowed = sr != null && actor != null && (sr.mods ?? []).includes(actor);
    }
    if (!allowed) return json(403, { error: "only author, root moderator, or admin may delete" });
    const removed = await deps.store.deletePostCascade(id);
    return json(200, { ok: true, removed: removed + 1 });
  }


  if (path === "/api/subroots" && request.method === "GET") {
    if (readLimited(request, deps)) return tooMany();
    const subs = await deps.store.listSubroots();
    return json(200, { count: subs.length, subroots: subs });
  }

  if (path === "/api/subroot" && request.method === "POST") {
    if (!isAdmin(request, deps)) {
      return json(401, { error: "admin token required" });
    }
    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return json(400, { error: "invalid json" });
    }
    const cfg = (body.config ?? {}) as Record<string, unknown>;
    const result = validateSubroot({
      slug: String(body.slug ?? "").trim().toLowerCase(),
      archetype: String(body.archetype ?? "").trim(),
      title: String(body.title ?? "").trim(),
      description: String(body.description ?? "").trim(),
      icon: String(body.icon ?? "").trim(),
      url: String(body.url ?? "").trim(),
      config: {
        votes: cfg.votes === true,
        anonymous: cfg.anonymous === true,
        retentionDays: cfg.retentionDays == null
          ? null
          : Number(cfg.retentionDays),
      },
    });
    if (!result.valid) return json(400, { error: result.error });
    if (await deps.store.getSubroot(result.record.slug) != null) {
      return json(409, { error: "subroot exists" });
    }
    const creator = String(body.creator ?? "__instance__").trim().toLowerCase();
    await deps.store.putSubroot({ ...result.record, creator });
    return json(201, { ok: true, subroot: { ...result.record, creator } });
  }

  // v0.13.0: creator-managed subroot update (PATCH).
  if (path === "/api/subroot" && request.method === "PATCH") {
    if (!deps.rateLimits.write.allow(writeKey(request))) return tooMany();
    const slug = (url.searchParams.get("slug") ?? "").trim().toLowerCase();
    if (!SUBROOT_SLUG.test(slug)) return json(400, { error: "invalid subroot slug" });
    const existing = await deps.store.getSubroot(slug);
    if (existing == null) return json(404, { error: "unknown subroot" });
    // auth: admin token OR the creator's actor token
    const t = bearer(request);
    if (t == null) return json(401, { error: "auth required" });
    if (t !== deps.adminToken) {
      const actor = await deps.auth.authenticate(t);
      const isMod = actor != null && (existing.mods ?? []).includes(actor);
      if (actor == null || (actor !== existing.creator && !isMod)) {
        return json(403, { error: "only creator, moderator, or admin may manage this root" });
      }
    }
    let body: Record<string, unknown>;
    try { body = await request.json(); } catch { return json(400, { error: "invalid json" }); }
    const title = body.title == null ? existing.title : String(body.title).trim();
    const description = body.description == null
      ? existing.description
      : String(body.description).trim();
    const icon = body.icon == null ? existing.icon : String(body.icon).trim().slice(0, 16);
    const extUrl = body.url == null ? (existing.url ?? "") : String(body.url).trim();
    const cfgIn = (body.config ?? existing.config) as Record<string, unknown>;
    const config = {
      votes: cfgIn.votes === true,
      anonymous: cfgIn.anonymous === true,
      retentionDays: cfgIn.retentionDays == null ? null : Number(cfgIn.retentionDays),
    };
    if (existing.archetype === "board" && (config.retentionDays == null || config.retentionDays < 1 || config.retentionDays > 365)) {
      return json(400, { error: "board requires retentionDays 1-365" });
    }
    if (existing.archetype !== "board" && config.retentionDays != null) {
      return json(400, { error: "retentionDays only allowed on board archetype" });
    }
    if (!title || title.length > MAX_SUBROOT_TITLE) return json(400, { error: "title required (max 96)" });
    if (description.length > MAX_SUBROOT_DESC) return json(400, { error: "description too long" });
    if (extUrl !== "" && !/^https?:\/\/\S{1,300}$/.test(extUrl)) return json(400, { error: "url must be http(s) link" });
    let mods = existing.mods ?? [];
    if (Array.isArray(body.mods)) {
      if (t !== deps.adminToken) {
        const who = await deps.auth.authenticate(t);
        if (who !== existing.creator) {
          return json(403, { error: "only creator or admin may change moderators" });
        }
      }
      mods = [...new Set(body.mods.map((m: unknown) => String(m).trim().toLowerCase()).filter((m: string) => m.length > 0))].slice(0, 20);
      for (const m of mods) {
        if (await deps.store.getActor(m) == null) return json(404, { error: "unknown moderator actor: " + m });
      }
    }
    const updated = await deps.store.updateSubroot(slug, { title, description, icon, url: extUrl, config, mods });
    return json(200, { ok: true, subroot: updated });
  }

  // v0.13.0: admin-only subroot delete. Posts keep their subroot field;
  // they simply become unlisted (browse-safe) — caller should rebind first.
  if (path === "/api/subroot" && request.method === "DELETE") {
    if (!isAdmin(request, deps)) return json(401, { error: "admin token required" });
    const slug = (url.searchParams.get("slug") ?? "").trim().toLowerCase();
    if (!SUBROOT_SLUG.test(slug)) return json(400, { error: "invalid subroot slug" });
    const existing = await deps.store.getSubroot(slug);
    if (existing == null) return json(404, { error: "unknown subroot" });
    await deps.store.deleteSubroot(slug);
    return json(200, { ok: true, deleted: slug });
  }

  if (path === "/api/feed" && request.method === "GET") {
    if (readLimited(request, deps)) return tooMany();
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
    const subrootParam = url.searchParams.get("subroot");
    const subroot = subrootParam == null || subrootParam === ""
      ? null
      : subrootParam.trim().toLowerCase();
    const sortParam = url.searchParams.get("sort");
    const sort = sortParam == null || sortParam === "" ? "new" : sortParam;
    if (sort !== "new" && sort !== "top" && sort !== "hot") {
      return json(400, { error: "sort must be new, top, or hot" });
    }
    let posts = (await deps.store.listPosts(identifier, subroot))
      .filter((p) => form == null || (p.form ?? "short") === form)
      .filter((p) => p.isRemote !== true || p.identifier === identifier)
      // Remote posts surface publicly only when explicitly public/unlisted
      // (audit CRITICAL: private remote content disclosure via feed).
      .filter((p) =>
        p.isRemote !== true || p.visibility === "public" ||
        p.visibility === "unlisted"
      );
    if (sort === "new") {
      posts = posts.sort((a, b) => b.published.localeCompare(a.published));
    } else {
      const scored: { post: typeof posts[number]; score: number }[] = [];
      for (const p of posts) {
        const votes = await deps.store.listVotes(p.id);
        const up = votes.filter((v) => v.value === 1).length;
        const down = votes.filter((v) => v.value === -1).length;
        const ageH =
          (Date.now() - new Date(p.published).getTime()) / 3.6e6;
        const score = sort === "top" ? wilsonScore(up, down) : hotScore(up, down, ageH);
        scored.push({ post: p, score });
      }
      scored.sort((a, b) => b.score - a.score);
      posts = scored.map((x) => x.post);
    }
    posts = posts.slice(0, limit);
    return json(200, { count: posts.length, posts });
  }

  // ── like / boost ──
  if (path === "/api/react" && request.method === "POST") {
    if (!deps.rateLimits.write.allow(writeKey(request))) return tooMany();
    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return json(400, { error: "invalid json" });
    }
    const identifier = String(body.identifier ?? "").trim().toLowerCase();
    const postId = String(body.postId ?? "").trim();
    if (!(await requireActor(request, deps, identifier))) {
      return json(401, { error: "unauthorized for actor: " + identifier });
    }
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
      if (await deps.store.getLike(kind, postId, identifier) == null) {
        return json(200, { ok: true, removed: false });
      }
      let undone = false;
      try {
        const ctx = deps.federation.createContext(
          new URL(deps.origin),
          undefined,
        );
        const actorUri = ctx.getActorUri(identifier);
        const objectUri = post.isRemote === true && /^https?:\//.test(post.id)
          ? new URL(post.id)
          : new URL(`/ap/actor/${post.identifier}/p/${post.id}`, actorUri);
        const inner = kind === "like"
          ? new Like({
            id: likeActivityId(deps.origin, identifier, kind, postId),
            actor: actorUri,
            object: objectUri,
          })
          : new Announce({
            id: likeActivityId(deps.origin, identifier, kind, postId),
            actor: actorUri,
            object: objectUri,
          });
        const undo = new Undo({ actor: actorUri, object: inner });
        if (post.isRemote === true && /^https?:\//.test(post.identifier)) {
          // Remote post: Undo goes to the responsible remote author (W3C).
          const author = await ctx.lookupObject(post.identifier) as Actor | null;
          if (author != null) {
            await ctx.sendActivity({ identifier }, author, undo);
            undone = true;
          }
        } else {
          await ctx.sendActivity({ identifier }, "followers", undo);
          undone = true;
        }
      } catch (e) {
        console.error("api: undo delivery failed:", e);
      }
      await deps.store.removeLike(kind, postId, identifier);
      return json(200, { ok: true, removed: true, undone });
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
          id: likeActivityId(deps.origin, identifier, kind, postId),
          actor: actorUri,
          object: objectUri,
        })
        : new Announce({
          id: likeActivityId(deps.origin, identifier, kind, postId),
          actor: actorUri,
          object: objectUri,
        });
      if (post.isRemote === true && /^https?:\//.test(post.identifier)) {
        // Remote post: Like/Announce goes to the responsible remote author
        // (W3C guidance) instead of only our followers (audit v0.9.1).
        const author = await ctx.lookupObject(post.identifier) as Actor | null;
        if (author != null) {
          await ctx.sendActivity({ identifier }, author, activity);
          delivered = true;
        }
      } else {
        await ctx.sendActivity({ identifier }, "followers", activity);
        delivered = true;
      }
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
    if (readLimited(request, deps)) return tooMany();
    const identifier = (url.searchParams.get("actor") ?? "").trim().toLowerCase();
    if (!identifier) return json(400, { error: "actor query param required" });
    // Notifications are private per-actor data (audit MEDIUM fix: was auth-free).
    if (!(await requireActor(request, deps, identifier))) {
      return json(401, { error: "unauthorized for actor: " + identifier });
    }
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
    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return json(400, { error: "invalid json" });
    }
    const identifier = String(body.identifier ?? "").trim().toLowerCase();
    const id = body.id == null ? null : String(body.id);
    if (!(await requireActor(request, deps, identifier))) {
      return json(401, { error: "unauthorized for actor: " + identifier });
    }
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
    if (!deps.rateLimits.federation.allow(writeKey(request))) return tooMany();
    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return json(400, { error: "invalid json" });
    }
    const identifier = String(body.identifier ?? "").trim().toLowerCase();
    const target = String(body.target ?? "").trim(); // actor URI or @name@host
    const remove = body.remove === true;
    if (!(await requireActor(request, deps, identifier))) {
      return json(401, { error: "unauthorized for actor: " + identifier });
    }
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
      try {
        await assertFederatable(targetUri);
      } catch (e) {
        return json(400, { error: String(e instanceof Error ? e.message : e) });
      }
    } else if (/^@?[a-z0-9_]{1,64}@([a-z0-9.-]+)$/i.test(target)) {
      const handle = target.replace(/^@/, "");
      const at = handle.indexOf("@");
      const name = handle.slice(0, at);
      const host = handle.slice(at + 1);
      try {
        await assertFederatableHost(host);
      } catch (e) {
        return json(400, { error: String(e instanceof Error ? e.message : e) });
      }
      // Mastodon-style actor URI via webfinger-less heuristic:
      // resolve through Fedify lookupObject with acct uri
      const ctx = deps.federation.createContext(new URL(deps.origin), undefined);
      const actor = await ctx.lookupObject(`acct:${name}@${host}`) as Actor | null;
      if (actor?.id == null) {
        return json(404, { error: `cannot resolve ${target}` });
      }
      targetUri = actor.id;
      try {
        await assertFederatable(targetUri);
      } catch (e) {
        return json(400, { error: String(e instanceof Error ? e.message : e) });
      }
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
    if (readLimited(request, deps)) return tooMany();
    const identifier = (url.searchParams.get("actor") ?? "").trim().toLowerCase();
    if (!identifier) return json(400, { error: "actor query param required" });
    const following = await deps.store.listFollowing(identifier);
    return json(200, { count: following.length, following });
  }

  // ── post interactions (likes/boosts per post) ──
  if (path === "/api/post/interactions" && request.method === "GET") {
    if (readLimited(request, deps)) return tooMany();
    const postId = (url.searchParams.get("postId") ?? "").trim();
    if (!postId) return json(400, { error: "postId query param required" });
    const [likes, boosts, votes, me] = await Promise.all([
      deps.store.listLikes(postId),
      deps.store.listBoosts(postId),
      deps.store.listVotes(postId),
      (async () => {
        const a = url.searchParams.get("actor");
        return a ? await deps.store.getVote(postId, a.trim().toLowerCase()) : null;
      })(),
    ]);
    const up = votes.filter((v) => v.value === 1).length;
    const down = votes.filter((v) => v.value === -1).length;
    return json(200, {
      postId,
      likes: likes.map((l) => l.actorId),
      boosts: boosts.map((b) => b.actorId),
      likeCount: likes.length,
      boostCount: boosts.length,
      upvotes: up,
      downvotes: down,
      score: up - down,
      myVote: me == null ? 0 : me.value,
    });
  }

  // ── votes (v0.12.0) ──
  if (path === "/api/vote" && request.method === "POST") {
    if (!deps.rateLimits.write.allow(writeKey(request))) return tooMany();
    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return json(400, { error: "invalid json" });
    }
    const identifier = String(body.identifier ?? "").trim().toLowerCase();
    const postId = String(body.postId ?? "").trim();
    const value = body.value === 1 ? 1 : body.value === -1 ? -1 : 0;
    const remove = body.remove === true;
    if (!identifier || !postId) {
      return json(400, { error: "identifier and postId required" });
    }
    if (value === 0 && !remove) {
      return json(400, { error: "value must be 1 or -1" });
    }
    if (!(await requireActor(request, deps, identifier))) {
      return json(401, { error: "unauthorized for actor: " + identifier });
    }
    const post = await deps.store.getPost(postId);
    if (post == null) return json(404, { error: "unknown post" });
    if (post.subroot != null) {
      const sr = await deps.store.getSubroot(post.subroot);
      if (sr != null && !sr.config.votes) {
        return json(403, { error: "votes disabled in this subroot" });
      }
    }
    const existing = await deps.store.getVote(postId, identifier);
    if (remove) {
      if (existing == null) return json(200, { removed: false });
      await deps.store.deleteVote(postId, identifier);
      return json(200, { removed: true });
    }
    if (existing != null && existing.value === value) {
      await deps.store.deleteVote(postId, identifier);
      return json(200, { removed: true });
    }
    if (value !== 1 && value !== -1) {
      return json(400, { error: "value must be 1 or -1" });
    }
    await deps.store.putVote({
      postId,
      actorId: identifier,
      value,
      voted: new Date().toISOString(),
    });
    return json(201, { voted: value });
  }

  // ── DMs (v0.15.0) ──
  if (path === "/api/dm" && request.method === "POST") {
    if (!deps.rateLimits.write.allow(writeKey(request))) return tooMany();
    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return json(400, { error: "invalid json" });
    }
    const identifier = String(body.identifier ?? "").trim().toLowerCase();
    const to = String(body.to ?? "").trim().toLowerCase();
    const content = String(body.content ?? "").trim();
    if (!identifier || !to) {
      return json(400, { error: "identifier and to required" });
    }
    if (!content) return json(400, { error: "content required" });
    if (content.length > 2000) {
      return json(400, { error: "content too long (max 2000)" });
    }
    if (!(await requireActor(request, deps, identifier))) {
      return json(401, { error: "unauthorized for actor: " + identifier });
    }
    if (identifier === to) {
      return json(400, { error: "cannot DM yourself" });
    }
    if ((await deps.store.getActor(to)) == null) {
      return json(404, { error: "unknown recipient" });
    }
    const dm: DmRecord = {
      id: crypto.randomUUID(),
      from: identifier,
      to,
      content,
      sent: new Date().toISOString(),
    };
    await deps.store.putDm(dm);
    return json(201, { ok: true, dm });
  }

  if (path === "/api/dm" && request.method === "GET") {
    if (readLimited(request, deps)) return tooMany();
    const actorParam = (url.searchParams.get("actor") ?? "").trim().toLowerCase();
    if (!actorParam) return json(400, { error: "actor required" });
    if (!(await requireActor(request, deps, actorParam))) {
      return json(401, { error: "unauthorized for actor: " + actorParam });
    }
    const withParam = (url.searchParams.get("with") ?? "").trim().toLowerCase();
    let dms = await deps.store.listDms(actorParam);
    if (withParam) {
      dms = dms.filter(
        (dm) => dm.from === withParam || dm.to === withParam,
      );
    }
    return json(200, { count: dms.length, dms });
  }

  // ── bookmarks (v0.15.0) ──
  if (path === "/api/bookmark" && request.method === "POST") {
    if (!deps.rateLimits.write.allow(writeKey(request))) return tooMany();
    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return json(400, { error: "invalid json" });
    }
    const identifier = String(body.identifier ?? "").trim().toLowerCase();
    const postId = String(body.postId ?? "").trim();
    if (!identifier || !postId) {
      return json(400, { error: "identifier and postId required" });
    }
    if (!(await requireActor(request, deps, identifier))) {
      return json(401, { error: "unauthorized for actor: " + identifier });
    }
    if ((await deps.store.getPost(postId)) == null) {
      return json(404, { error: "unknown post" });
    }
    await deps.store.putBookmark(identifier, postId);
    return json(201, { ok: true, bookmarked: postId });
  }

  if (path === "/api/bookmarks" && request.method === "GET") {
    if (readLimited(request, deps)) return tooMany();
    const actorParam = (url.searchParams.get("actor") ?? "").trim().toLowerCase();
    if (!actorParam) return json(400, { error: "actor required" });
    if (!(await requireActor(request, deps, actorParam))) {
      return json(401, { error: "unauthorized for actor: " + actorParam });
    }
    const bookmarks = await deps.store.listBookmarks(actorParam);
    return json(200, { count: bookmarks.length, bookmarks });
  }

  if (path === "/api/bookmark" && request.method === "DELETE") {
    if (!deps.rateLimits.write.allow(writeKey(request))) return tooMany();
    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return json(400, { error: "invalid json" });
    }
    const identifier = String(body.identifier ?? "").trim().toLowerCase();
    const postId = String(body.postId ?? "").trim();
    if (!identifier || !postId) {
      return json(400, { error: "identifier and postId required" });
    }
    if (!(await requireActor(request, deps, identifier))) {
      return json(401, { error: "unauthorized for actor: " + identifier });
    }
    await deps.store.deleteBookmark(identifier, postId);
    return json(200, { ok: true, removed: postId });
  }

  // ── reports + moderation (v0.15.0) ──
  if (path === "/api/report" && request.method === "POST") {
    if (!deps.rateLimits.write.allow(writeKey(request))) return tooMany();
    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return json(400, { error: "invalid json" });
    }
    const identifier = String(body.identifier ?? "").trim().toLowerCase();
    const postId = String(body.postId ?? "").trim();
    const reason = String(body.reason ?? "").trim().toLowerCase();
    const note = String(body.note ?? "").trim().slice(0, 500);
    if (!identifier || !postId) {
      return json(400, { error: "identifier and postId required" });
    }
    if (!(REPORT_REASONS as readonly string[]).includes(reason)) {
      return json(400, { error: "reason must be one of " + REPORT_REASONS.join(", ") });
    }
    if (!(await requireActor(request, deps, identifier))) {
      return json(401, { error: "unauthorized for actor: " + identifier });
    }
    if ((await deps.store.getPost(postId)) == null) {
      return json(404, { error: "unknown post" });
    }
    const report: ReportRecord = {
      id: crypto.randomUUID(),
      postId,
      reporter: identifier,
      reason: reason as ReportReason,
      note,
      status: "open",
      action: "",
      created: new Date().toISOString(),
    };
    await deps.store.putReport(report);
    await audit(deps, identifier, "report", postId, reason);
    return json(201, { ok: true, report });
  }

  if (path === "/api/moderation/queue" && request.method === "GET") {
    if (!isAdmin(request, deps)) return json(403, { error: "admin token required" });
    const statusParam = url.searchParams.get("status");
    const status =
      statusParam === "open" || statusParam === "resolved" ? statusParam : undefined;
    const reports = await deps.store.listReports(status);
    return json(200, { count: reports.length, reports });
  }

  if (path === "/api/moderation/resolve" && request.method === "POST") {
    if (!isAdmin(request, deps)) return json(403, { error: "admin token required" });
    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return json(400, { error: "invalid json" });
    }
    const id = String(body.id ?? "").trim();
    const action = String(body.action ?? "").trim();
    if (!id) return json(400, { error: "id required" });
    if (action !== "dismiss" && action !== "delete_post") {
      return json(400, { error: "action must be dismiss or delete_post" });
    }
    const report = await deps.store.getReport(id);
    if (report == null) return json(404, { error: "unknown report" });
    if (report.status === "resolved") {
      return json(409, { error: "report already resolved" });
    }
    if (action === "delete_post") {
      await deps.store.deletePost(report.postId);
    }
    report.status = "resolved";
    report.action = action;
    report.resolvedAt = new Date().toISOString();
    await deps.store.putReport(report);
    await deps.store.putModAction({
      id: crypto.randomUUID(),
      modActor: "admin",
      reportId: id,
      action: action as "dismiss" | "delete_post",
      note: "",
      ts: new Date().toISOString(),
    });
    await audit(deps, "admin", action, report.postId, report.reason);
    return json(200, { ok: true, resolved: id, action });
  }

  // ── v0.20.0 audit log (admin only, append-only view) ──
  if (path === "/api/moderation/audit" && request.method === "GET") {
    if (!isAdmin(request, deps)) return json(403, { error: "admin token required" });
    const limitParam = Number(url.searchParams.get("limit") ?? "200");
    const limit = Number.isFinite(limitParam) && limitParam > 0 && limitParam <= 500
      ? Math.floor(limitParam)
      : 200;
    const auditEntries = await deps.store.listAudit(limit);
    return json(200, { count: auditEntries.length, audit: auditEntries });
  }

  // ── v0.20.0 external outbox reader (deck view) ──
  // Reads a remote ActivityPub outbox. SSRF-guarded, 60s cached.
  if (path === "/api/outbox" && request.method === "GET") {
    if (readLimited(request, deps)) return tooMany();
    const target = (url.searchParams.get("url") ?? "").trim();
    const handle = (url.searchParams.get("handle") ?? "").trim();
    if (!target && !handle) {
      return json(400, { error: "url or handle required" });
    }
    let outboxUrl = target;
    try {
      if (!outboxUrl) {
        // Resolve handle via webfinger.
        const wfUrl = webfingerUrl(handle);
        const wfHost = new URL(wfUrl).host;
        await assertFederatableHost(wfHost);
        const wfRes = await fetch(wfUrl, {
          headers: { accept: "application/jrd+json, application/json" },
        });
        if (!wfRes.ok) return json(502, { error: "webfinger lookup failed" });
        const wf = await wfRes.json();
        const links = Array.isArray(wf.links) ? wf.links : [];
        const selfLink = links.find(
          (l: Record<string, unknown>) =>
            l.rel === "self" && typeof l.href === "string",
        );
        if (selfLink == null) {
          return json(404, { error: "no ActivityPub actor found for handle" });
        }
        const actorUrl = String(selfLink.href);
        const actorHost = new URL(actorUrl).host;
        await assertFederatableHost(actorHost);
        const actorRes = await fetch(actorUrl, {
          headers: { accept: 'application/activity+json, application/ld+json' },
        });
        if (!actorRes.ok) return json(502, { error: "actor fetch failed" });
        const actorDoc = await actorRes.json();
        const ob = actorDoc.outbox;
        if (typeof ob !== "string") {
          return json(404, { error: "actor has no outbox" });
        }
        outboxUrl = ob;
      }
      const outboxParsed = new URL(outboxUrl);
      await assertFederatable(outboxParsed);
    } catch (e) {
      // SSRF violations are policy blocks (403); malformed input is a 400.
      // ssrf.ts throws all guards with a leading "blocked" message.
      if (e instanceof Error && e.message.startsWith("blocked")) {
        return json(403, { error: e.message });
      }
      return json(400, { error: "invalid or blocked outbox url" });
    }
    const cached = outboxCache.get(outboxUrl);
    if (cached != null) {
      const posts = extractPosts(cached);
      return json(200, { source: outboxUrl, cached: true, count: posts.length, posts });
    }
    let doc: unknown;
    try {
      const res = await fetch(outboxUrl, {
        headers: { accept: 'application/activity+json, application/ld+json, application/json' },
      });
      if (!res.ok) return json(502, { error: "outbox fetch failed", status: res.status });
      doc = await res.json();
    } catch {
      return json(502, { error: "outbox fetch failed" });
    }
    outboxCache.set(outboxUrl, doc);
    const posts = extractPosts(doc);
    return json(200, { source: outboxUrl, cached: false, count: posts.length, posts });
  }

  // ── token management (admin only) ──
  if (path === "/api/token/issue" && request.method === "POST") {
    if (!isAdmin(request, deps)) return json(401, { error: "admin token required" });
    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return json(400, { error: "invalid json" });
    }
    const identifier = String(body.identifier ?? "").trim().toLowerCase();
    if (!/^[a-z0-9_]{1,64}$/.test(identifier)) {
      return json(400, { error: "identifier must match [a-z0-9_]{1,64}" });
    }
    if (await deps.store.getActor(identifier) == null) {
      return json(404, { error: "unknown actor" });
    }
    // v0.20.0 - optional ttlHours: short-lived tokens (admin TTL UX).
    let ttlMs: number | undefined;
    const rawTtl = body.ttlHours;
    if (rawTtl != null) {
      const h = Number(rawTtl);
      if (!Number.isFinite(h) || h <= 0 || h > 24 * 365) {
        return json(400, { error: "ttlHours must be 0 < h <= 8760" });
      }
      ttlMs = h * 3_600_000;
    }
    const token = await deps.auth.issue(identifier, undefined, ttlMs);
    await audit(deps, "admin", "token_issue", identifier);
    const expires = ttlMs == null
      ? undefined
      : new Date(Date.now() + ttlMs).toISOString();
    return json(201, { ok: true, identifier, token, expires });
  }

  if (path === "/api/token/revoke" && request.method === "POST") {
    if (!isAdmin(request, deps)) return json(401, { error: "admin token required" });
    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return json(400, { error: "invalid json" });
    }
    const identifier = String(body.identifier ?? "").trim().toLowerCase();
    const token = body.token == null ? null : String(body.token);
    if (!identifier) return json(400, { error: "identifier required" });
    const revoked = await deps.auth.revoke(identifier, token ?? undefined);
    return json(200, { ok: true, revoked });
  }

  if (path === "/api/token/list" && request.method === "GET") {
    if (!isAdmin(request, deps)) return json(401, { error: "admin token required" });
    const identifier = (url.searchParams.get("actor") ?? "").trim().toLowerCase();
    const tokens = await deps.auth.list(identifier || undefined);
    return json(200, { count: tokens.length, tokens });
  }

  // ── who am i (per-actor token introspection) ──
  if (path === "/api/whoami" && request.method === "GET") {
    const t = bearer(request);
    if (t == null) return json(401, { error: "bearer token required" });
    if (t === deps.adminToken) {
      return json(200, { actor: null, role: "admin" });
    }
    const actor = await deps.auth.authenticate(t);
    if (actor == null) return json(401, { error: "invalid token" });
    return json(200, { actor, role: "actor" });
  }

  return json(404, { error: "not found" });
}
