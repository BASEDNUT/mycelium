// Mycelium — ActivityPub node on Fedify 2.3.4.
// Original code. MIT license.
//
// Run: deno serve --allow-net --allow-env --allow-read=data --allow-write=data --unstable-kv main.ts
// Env: ORIGIN (public origin) · DATA_DIR (default ./data) · MYCELIUM_TOKEN_FILE (default $DATA_DIR/api_token)
//      NODE_TITLE (landing wordmark) · NODE_CREDIT (landing credit) · NODE_ICON (favicon emoji, default 🍄) — deployment branding

import {
  createFederation,
  getDocumentLoader,
  importJwk,
  type PageItems,
} from "@fedify/fedify";
import {
  Accept,
  Announce,
  Create,
  Follow,
  Like,
  Note,
  Undo,
} from "@fedify/vocab";
// Accept handles remote acceptances of our outbound Follow activities.
import { DenoKvMessageQueue, DenoKvStore } from "@fedify/denokv";
import { bootstrapActors, buildActorDoc, ensureKeyPairs } from "./actors.ts";
import { handleApi } from "./api.ts";
import { TokenAuth } from "./auth.ts";
import { KeyEnvelope } from "./crypto.ts";
import { NodeRateLimits } from "./ratelimit.ts";
import { MyceliumStore, type PostRecord } from "./store.ts";
import { buildNote, buildCreate, classifyVisibility } from "./notes.ts";
import { NetworkProjection, migrateKg } from "./network.ts";
import { handleNetwork } from "./network_api.ts";
import { skillMd } from "./skill_md.ts";
import { llmsTxt } from "./llms_txt.ts";
import { assertFederatable } from "./ssrf.ts";
import { landingHtml } from "./landing.ts";
import { VERSION } from "./version.ts";

const DATA_DIR = Deno.env.get("DATA_DIR") ?? "./data";
// ORIGIN is required (audit HIGH v0.9.0): the framework must never assume
// a deployment's identity by default.
const origin = Deno.env.get("ORIGIN");
if (origin == null) {
  throw new Error("ORIGIN env is required (e.g. https://your-node.example)");
}
const host = new URL(origin).host;
const kv = await Deno.openKv(`${DATA_DIR}/mycelium.db`);
const store = new MyceliumStore(kv);
const network = new NetworkProjection(kv);
await migrateKg(kv); // one-time: legacy kg entities -> semantic objects
await bootstrapActors(store, host);

// ── Security: key envelope (AES-256-GCM at rest) + per-actor tokens ──
const envelope = new KeyEnvelope();
await envelope.loadOrGenerate(`${DATA_DIR}/master.key`, () => store.hasEncryptedKeys());
store.setKeyEnvelope(envelope);
const migratedKeys = await store.migrateKeysToEncrypted();
if (migratedKeys > 0) {
  console.log(`crypto: migrated ${migratedKeys} plaintext key(s) to encrypted`);
}
const auth = new TokenAuth(kv);
const rateLimits = new NodeRateLimits();

// Operator admin token — bootstrap + token management only (issue/revoke).
// Loaded from data/admin_token; regenerated when absent.
const ADMIN_TOKEN_FILE = `${DATA_DIR}/admin_token`;
let adminToken: string;
try {
  adminToken = (await Deno.readTextFile(ADMIN_TOKEN_FILE)).trim();
  if (!adminToken) throw new Error("empty");
} catch {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  let bin = "";
  for (const b of raw) bin += String.fromCharCode(b);
  adminToken = btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  await Deno.writeTextFile(ADMIN_TOKEN_FILE, adminToken + "\n");
  try { await Deno.chmod(ADMIN_TOKEN_FILE, 0o600); } catch { /* best effort */ }
  console.warn("auth: generated new admin token at " + ADMIN_TOKEN_FILE);
}

// SSRF-hardened document loader: ALL federation-side dereferences (remote
// actor/object fetches triggered by inbox handlers) pass the same private-
// host guard as user-initiated federation (audit HIGH: asymmetric SSRF —
// inbox paths fetched attacker-supplied URIs unchecked).
const federation = createFederation<void>({
  kv: new DenoKvStore(kv),
  queue: new DenoKvMessageQueue(kv),
  origin,
  // fedify 2.3.4 forbids documentLoaderFactory alongside top-level
  // userAgent/allowPrivateAddress — the factory must own both.
  documentLoaderFactory: (opts) => {
    const loader = getDocumentLoader({
      userAgent: opts?.userAgent ?? `Mycelium/${VERSION}`,
      allowPrivateAddress: false,
    });
    return async (url: string) => {
      await assertFederatable(new URL(url));
      return loader(url);
    };
  },
});

// ── Actor + keys ──
federation
  .setActorDispatcher("/ap/actor/{identifier}", async (ctx, identifier) => {
    const record = await store.getActor(identifier);
    if (record == null) return null;
    const keyPairs = await ctx.getActorKeyPairs(identifier);
    return buildActorDoc(record, ctx, keyPairs);
  })
  .setKeyPairsDispatcher(async (_ctx, identifier) => {
    const keys = await ensureKeyPairs(store, identifier);
    if (keys == null) return [];
    return [
      {
        privateKey: await importJwk(keys.rsa.privateKey, "private"),
        publicKey: await importJwk(keys.rsa.publicKey, "public"),
      },
      {
        privateKey: await importJwk(keys.ed25519.privateKey, "private"),
        publicKey: await importJwk(keys.ed25519.publicKey, "public"),
      },
    ];
  });

// ── Followers ──
federation
  .setFollowersDispatcher(
    "/ap/actor/{identifier}/followers",
    async (_ctx, identifier, cursor) => {
      if (await store.getActor(identifier) == null) return null;
      const all = await store.getFollowers(identifier);
      const size = 50;
      const offset = cursor == null ? 0 : parseInt(cursor);
      const slice = all.slice(offset, offset + size);
      const nextCursor = offset + size < all.length
        ? String(offset + size)
        : null;
      return {
        items: slice.map((f) =>
          f.inbox == null
            ? { id: new URL(f.followerId) }
            : { id: new URL(f.followerId), inboxId: new URL(f.inbox) }
        ),
        nextCursor,
      } as PageItems<{ id: URL; inboxId: URL }>;
    },
  )
  .setCounter(async (_ctx, identifier) =>
    (await store.getFollowers(identifier)).length
  );

// ── Following (audit v0.9.1: actor docs recommended both collections) ──
federation
  .setFollowingDispatcher(
    "/ap/actor/{identifier}/following",
    async (_ctx, identifier, cursor) => {
      if (await store.getActor(identifier) == null) return null;
      const all = await store.listFollowing(identifier);
      const size = 50;
      const offset = cursor == null ? 0 : parseInt(cursor);
      const slice = all.slice(offset, offset + size);
      const nextCursor = offset + size < all.length
        ? String(offset + size)
        : null;
      return {
        items: slice.map((f) => new URL(f.targetId)),
        nextCursor,
      } as PageItems<URL>;
    },
  )
  .setCounter(async (_ctx, identifier) =>
    (await store.listFollowing(identifier)).length
  );

// ── Outbox ──
federation
  .setOutboxDispatcher(
    "/ap/actor/{identifier}/outbox",
    async (ctx, identifier, cursor) => {
      if (await store.getActor(identifier) == null) return null;
      const all = (await store.listPosts(identifier))
        .filter((p) => p.isRemote !== true)
        .sort((a, b) => b.published.localeCompare(a.published));
      const size = 20;
      const offset = cursor == null ? 0 : parseInt(cursor);
      const slice = all.slice(offset, offset + size);
      const items = await Promise.all(slice.map((p) => buildCreate(ctx, p)));
      const nextCursor = offset + size < all.length
        ? String(offset + size)
        : null;
      return { items, nextCursor } as PageItems<Create>;
    },
  )
  .setCounter(async (_ctx, identifier) =>
    (await store.listPosts(identifier)).filter((p) => p.isRemote !== true).length
  );

// ── Note object dispatcher ──
federation.setObjectDispatcher(
  Note,
  "/ap/actor/{identifier}/p/{id}",
  async (ctx, values) => {
    const post = await store.getPost(values.id);
    if (post == null || post.identifier !== values.identifier) return null;
    return buildNote(ctx, post);
  },
);

// ── Inbox ──
// ctx.recipient is null when an activity arrives at the shared inbox;
// handlers below derive the target actor from the activity itself instead
// of discarding shared-inbox deliveries.
federation
  .setInboxListeners("/ap/actor/{identifier}/inbox", "/ap/inbox")
  .on(Follow, async (ctx, follow) => {
    const parsed = ctx.parseUri(follow.objectId);
    if (parsed?.type !== "actor") return;
    const identifier = ctx.recipient ?? parsed.identifier;
    const recipient = await follow.getActor(ctx);
    if (recipient == null) return;
    await store.addFollower(identifier, {
      id: follow.id?.href ?? crypto.randomUUID(),
      followerId: recipient.id?.href ?? "",
      inbox: recipient.inboxId?.href ?? null,
      followed: new Date().toISOString(),
    });
    await ctx.sendActivity(
      { identifier },
      recipient,
      new Accept({ actor: follow.objectId, object: follow }),
    );
    await store.putNotification({
      id: crypto.randomUUID(),
      type: "follow",
      identifier,
      fromActorId: recipient.id?.href ?? "unknown",
      read: false,
      created: new Date().toISOString(),
    });
  })
  .on(Undo, async (ctx, undo) => {
    const inner = await undo.getObject();
    // Undo(Like) / Undo(Announce) — remove the like/boost record.
    if (inner instanceof Like || inner instanceof Announce) {
      const objectId = inner.objectId?.href;
      const actorUri = inner.actorId?.href;
      if (objectId == null || actorUri == null) return;
      const kind = inner instanceof Like ? "like" : "boost";
      // Target may be a local post URI: /ap/actor/{id}/p/{postId}
      const m = objectId.match(/\/ap\/actor\/[^/]+\/p\/([^/]+)$/);
      if (m == null) return;
      await store.removeLike(kind, m[1], actorUri);
      return;
    }
    if (!(inner instanceof Follow)) return;
    const parsed = ctx.parseUri(inner.objectId);
    if (parsed?.type !== "actor") return;
    const identifier = ctx.recipient ?? parsed.identifier;
    const followId = inner.id?.href;
    if (followId != null) {
      await store.removeFollower(identifier, followId);
    }
    const followerUri = inner.actorId?.href;
    if (followerUri != null) {
      for (const f of await store.getFollowers(identifier)) {
        if (f.followerId === followerUri) {
          await store.removeFollower(identifier, f.id);
        }
      }
    }
  })
  .on(Accept, async (_ctx, accept) => {
    // Remote server accepted our outbound Follow. No state change needed:
    // the FollowingRecord exists from follow time.
    const inner = await accept.getObject();
    console.log(
      "inbox: outbound follow accepted by",
      accept.actorId?.href ?? "unknown",
      inner instanceof Follow ? "(Follow)" : "",
    );
  })
  .on(Create, async (_ctx, create) => {
    const object = await create.getObject();
    if (!(object instanceof Note)) return;
    const author = create.actorId?.href ?? "unknown";
    const jsonLd = await object.toJsonLd();
    // Privacy: only content explicitly addressed to as:Public is public;
    // everything else is stored followers/direct and never rendered on
    // public surfaces (audit CRITICAL: unconditional visibility:"public"
    // disclosed private remote content via landing page + feed).
    const visibility = classifyVisibility(jsonLd as Record<string, unknown>);
    // Bounds: remote content is capped like local posts (audit: unbounded
    // remote KV writes).
    const MAX_REMOTE_CONTENT = 20000;
    const MAX_REMOTE_TITLE = 500;
    // Store idempotently: remote retries overwrite the same key.
    const post: PostRecord = {
      id: object.id?.href ?? crypto.randomUUID(),
      identifier: author,
      content: (object.content?.toString() ?? "").slice(0, MAX_REMOTE_CONTENT),
      published: object.published?.toString() ?? new Date().toISOString(),
      inReplyTo: object.replyTargetId?.href,
      visibility,
      form: "short",
      title: object.name?.toString()?.slice(0, MAX_REMOTE_TITLE),
      isRemote: true,
    };
    await store.putPost(post);

    // Notifications: replies and mentions for local actors.
    try {
      const actors = await store.listActors();
      const byUri = new Map(
        actors.map((a) => [
          ctx_getActorUri(origin, a.identifier).href,
          a.identifier,
        ]),
      );
      // Reply notification: post replies to a local actor's post.
      if (post.inReplyTo != null) {
        const rm = post.inReplyTo.match(/\/ap\/actor\/([^/]+)\/p\/[^/]+$/);
        if (rm != null && byUri.has(ctx_getActorUri(origin, rm[1]).href)) {
          const target = rm[1];
          if (target !== post.identifier) {
            await store.putNotification({
              id: crypto.randomUUID(),
              type: "reply",
              identifier: target,
              fromActorId: author,
              postId: post.id,
              read: false,
              created: new Date().toISOString(),
            });
          }
        }
      }
      // Mention notifications: read tag[] hrefs from the wire format.
      // (jsonLd hoisted above for visibility classification)
      const rawTag = (jsonLd as Record<string, unknown>).tag;
      const tags = Array.isArray(rawTag)
        ? rawTag as Record<string, unknown>[]
        : rawTag != null
        ? [rawTag as Record<string, unknown>]
        : [];
      for (const t of tags) {
        const href = typeof t.href === "string" ? t.href : null;
        if (href != null && byUri.has(href)) {
          const target = byUri.get(href)!;
          if (target !== post.identifier) {
            await store.putNotification({
              id: crypto.randomUUID(),
              type: "mention",
              identifier: target,
              fromActorId: author,
              postId: post.id,
              read: false,
              created: new Date().toISOString(),
            });
          }
        }
      }
    } catch (e) {
      console.error("inbox: notification pass failed:", e);
    }
  })
  .on(Like, async (ctx, like) => {
    const objectId = like.objectId?.href;
    const actorUri = like.actorId?.href;
    if (objectId == null || actorUri == null) return;
    const m = objectId.match(/\/ap\/actor\/([^/]+)\/p\/([^/]+)$/);
    if (m == null) return;
    const [, identifier, postId] = m;
    // Audit v0.9.1: verify the referenced post exists and belongs to this
    // local actor before recording a remote interaction (W3C guidance).
    const target = await store.getPost(postId);
    if (target == null || target.isRemote === true ||
      target.identifier !== identifier) {
      return;
    }
    await store.putLike({
      id: like.id?.href ?? crypto.randomUUID(),
      actorId: actorUri,
      postId,
      kind: "like",
      published: new Date().toISOString(),
    });
    await store.putNotification({
      id: crypto.randomUUID(),
      type: "like",
      identifier,
      fromActorId: actorUri,
      postId,
      read: false,
      created: new Date().toISOString(),
    });
  })
  .on(Announce, async (ctx, announce) => {
    const objectId = announce.objectId?.href;
    const actorUri = announce.actorId?.href;
    if (objectId == null || actorUri == null) return;
    const m = objectId.match(/\/ap\/actor\/([^/]+)\/p\/([^/]+)$/);
    if (m == null) return;
    const [, identifier, postId] = m;
    // Audit v0.9.1: same existence + ownership check as Like.
    const target = await store.getPost(postId);
    if (target == null || target.isRemote === true ||
      target.identifier !== identifier) {
      return;
    }
    await store.putLike({
      id: announce.id?.href ?? crypto.randomUUID(),
      actorId: actorUri,
      postId,
      kind: "boost",
      published: new Date().toISOString(),
    });
    await store.putNotification({
      id: crypto.randomUUID(),
      type: "boost",
      identifier,
      fromActorId: actorUri,
      postId,
      read: false,
      created: new Date().toISOString(),
    });
  });

// Local actor URI without a federation context (plain string build).
function ctx_getActorUri(originStr: string, identifier: string): URL {
  return new URL(`/ap/actor/${identifier}`, originStr);
}

// ── NodeInfo ──
let actorCountCache = 0;
let postCountCache = 0;
async function refreshCounts(): Promise<void> {
  actorCountCache = (await store.listActors()).length;
  postCountCache = (await store.listPosts(null))
    .filter((p) => p.isRemote !== true).length;
}
refreshCounts();
setInterval(() => refreshCounts(), 60_000);

// v0.12.0: board retention sweeper — hourly rolling deletion (docs/subroots-identity-v1.md)
setInterval(() => {
  store.sweepExpiredPosts().then((n) => {
    if (n > 0) console.log(`[sweeper] deleted ${n} expired board posts`);
  }).catch((e) => console.error("[sweeper] error:", e));
}, 3_600_000);

federation.setNodeInfoDispatcher("/nodeinfo/2.1", () => ({
  software: { name: "mycelium", version: VERSION },
  protocols: ["activitypub"],
  usage: {
    users: { total: actorCountCache },
    localPosts: postCountCache,
    localComments: 0,
  },
}));



export default {
  fetch: async (request: Request): Promise<Response> => {
    const url = new URL(request.url);

    if (url.pathname === "/skill.md") {
      return new Response(skillMd(origin, VERSION), {
        headers: { "content-type": "text/markdown; charset=utf-8" },
      });
    }

    // v0.19.0: llms.txt convention endpoints for AI agents.
    if (url.pathname === "/llms.txt" || url.pathname === "/agents.md") {
      return new Response(llmsTxt(origin, VERSION), {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    if (url.pathname.startsWith("/api/network/")) {
      return await handleNetwork(request, { store, network, origin, auth, rateLimits, adminToken });
    }

    // Legacy KG endpoints are superseded by the network projection API.
    if (url.pathname.startsWith("/api/kg/")) {
      return new Response(
        JSON.stringify({
          error: "gone",
          detail: "knowledge graph endpoints moved to /api/network/*",
        }),
        {
          status: 410,
          headers: { "content-type": "application/json; charset=utf-8" },
        },
      );
    }

    if (url.pathname.startsWith("/api/")) {
      return await handleApi(request, {
        store,
        federation,
        origin,
        auth,
        rateLimits,
        adminToken,
      });
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      const [actors, allPosts] = await Promise.all([
        store.listActors(),
        store.listPosts(null),
      ]);
      // Only public/unlisted remote posts render on the public landing page
      // (audit CRITICAL: private remote content disclosure).
      const posts = allPosts.filter((p) =>
        p.isRemote !== true || p.visibility === "public" ||
        p.visibility === "unlisted"
      );
      const graph = await network.build(
        actors,
        posts,
        async (id) =>
          (await store.getFollowers(id)).map((f) => f.followerId),
        async (id) => store.listFollowing(id),
      );
      const sorted = posts.slice().sort((a, b) => b.published.localeCompare(a.published));
      // Author class per post so the GUI avatar reflects the actor, not a
      // hardcoded agent glyph (audit fix).
      const classByActor = new Map(actors.map((a) => [a.identifier, a.actorClass]));
      const enriched = sorted.map((p) => ({
        ...p,
        actorClass: p.isRemote === true ? "remote" : classByActor.get(p.identifier),
      }));
      // Per-response CSP nonce: inline script is nonce-gated; injected
      // script without the nonce cannot execute (audit: no CSP).
      const cspNonce = crypto.randomUUID().replace(/-/g, "");
      return new Response(
        landingHtml(
          origin,
          actors,
          enriched,
          graph,
          cspNonce,
          Deno.env.get("NODE_TITLE"),
          Deno.env.get("NODE_CREDIT"),
          Deno.env.get("NODE_ICON"),
        ),
        {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store, must-revalidate",
          "x-content-type-options": "nosniff",
          "x-frame-options": "DENY",
          "referrer-policy": "no-referrer",
          "content-security-policy":
            "default-src 'self'; script-src 'self' 'nonce-" + cspNonce +
            "'; style-src 'self' 'nonce-" + cspNonce + "'; img-src 'self' data:; " +
            "connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; " +
            "form-action 'self'",
        },
      });
    }

    return await federation.fetch(request, { contextData: undefined });
  },
};
