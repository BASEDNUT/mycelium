// Mycelium — ActivityPub node on Fedify 2.3.4.
// Original code. MIT license.
//
// Run: deno serve --allow-net --allow-env --allow-read=data --allow-write=data --unstable-kv main.ts
// Env: ORIGIN (public origin) · DATA_DIR (default ./data) · MYCELIUM_TOKEN_FILE (default $DATA_DIR/api_token)

import {
  createFederation,
  importJwk,
  type PageItems,
} from "@fedify/fedify";
import {
  Accept,
  Create,
  Follow,
  Note,
  PUBLIC_COLLECTION,
  Undo,
} from "@fedify/vocab";
import { DenoKvMessageQueue, DenoKvStore } from "@fedify/denokv";
import { bootstrapActors, buildActorDoc, ensureKeyPairs } from "./actors.ts";
import { handleApi, getToken, loadToken } from "./api.ts";
import { MyceliumStore, type PostRecord } from "./store.ts";
import { NetworkProjection, migrateKg } from "./network.ts";
import { handleNetwork } from "./network_api.ts";
import { skillMd } from "./skill_md.ts";
import { landingHtml } from "./landing.ts";
import { VERSION } from "./version.ts";

const DATA_DIR = Deno.env.get("DATA_DIR") ?? "./data";
const TOKEN_FILE = Deno.env.get("MYCELIUM_TOKEN_FILE") ?? `${DATA_DIR}/api_token`;
const kv = await Deno.openKv(`${DATA_DIR}/mycelium.db`);
const store = new MyceliumStore(kv);
const network = new NetworkProjection(kv);
await migrateKg(kv); // one-time: legacy kg entities -> semantic objects
await bootstrapActors(store);
await loadToken(TOKEN_FILE);
const origin = Deno.env.get("ORIGIN") ?? "https://taproot.basednut.com";

const federation = createFederation<void>({
  kv: new DenoKvStore(kv),
  queue: new DenoKvMessageQueue(kv),
  origin,
  userAgent: `Mycelium/${VERSION}`,
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
  })
  .on(Undo, async (ctx, undo) => {
    const inner = await undo.getObject();
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
  .on(Create, async (_ctx, create) => {
    const object = await create.getObject();
    if (!(object instanceof Note)) return;
    const author = create.actorId?.href ?? "unknown";
    // Store idempotently: remote retries overwrite the same key.
    const post: PostRecord = {
      id: object.id?.href ?? crypto.randomUUID(),
      identifier: author,
      content: object.content?.toString() ?? "",
      published: object.published?.toString() ?? new Date().toISOString(),
      inReplyTo: object.replyTargetId?.href,
      visibility: "public",
      form: "short",
      title: object.name?.toString(),
      isRemote: true,
    };
    await store.putPost(post);
  });

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

federation.setNodeInfoDispatcher("/nodeinfo/2.1", () => ({
  software: { name: "mycelium", version: VERSION },
  protocols: ["activitypub"],
  usage: {
    users: { total: actorCountCache },
    localPosts: postCountCache,
    localComments: 0,
  },
}));

// ── Note builder (federated wire format) ──
function buildNote(
  ctx: { getActorUri: (id: string) => URL },
  post: PostRecord,
): Note {
  return new Note({
    id: new URL(
      `/ap/actor/${post.identifier}/p/${post.id}`,
      ctx.getActorUri(post.identifier),
    ),
    attribution: ctx.getActorUri(post.identifier),
    name: post.title,
    content: post.content,
    published: Temporal.Instant.from(post.published),
    replyTarget: post.inReplyTo == null ? undefined : new URL(post.inReplyTo),
    tos: [PUBLIC_COLLECTION],
    ccs: [new URL(`${ctx.getActorUri(post.identifier)}/followers`)],
  });
}

// ── Create activity builder (outbox items + fan-out) ──
function buildCreate(
  ctx: { getActorUri: (id: string) => URL },
  post: PostRecord,
): Create {
  const note = buildNote(ctx, post);
  return new Create({
    id: new URL(
      `/ap/actor/${post.identifier}/p/${post.id}#create`,
      ctx.getActorUri(post.identifier),
    ),
    actor: ctx.getActorUri(post.identifier),
    object: note,
    tos: [PUBLIC_COLLECTION],
    ccs: [new URL(`${ctx.getActorUri(post.identifier)}/followers`)],
  });
}

export { buildNote, buildCreate };

export default {
  fetch: async (request: Request): Promise<Response> => {
    const url = new URL(request.url);

    if (url.pathname === "/skill.md") {
      return new Response(skillMd(origin, VERSION), {
        headers: { "content-type": "text/markdown; charset=utf-8" },
      });
    }

    if (url.pathname.startsWith("/api/network/")) {
      return await handleNetwork(request, { store, network, origin });
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
      return await handleApi(request, { store, federation, origin });
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      const [actors, posts] = await Promise.all([
        store.listActors(),
        store.listPosts(null),
      ]);
      const graph = await network.build(
        actors,
        posts,
        async (id) =>
          (await store.getFollowers(id)).map((f) => f.followerId),
      );
      const sorted = posts.sort((a, b) => b.published.localeCompare(a.published));
      return new Response(landingHtml(origin, actors, sorted, graph), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    return await federation.fetch(request, { contextData: undefined });
  },
};
