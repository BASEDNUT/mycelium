// v0.15.0 primitives: DMs, bookmarks, reports/mod queue, feed sort tabs,
// board long-form. Design: docs/services-v1.md + council directives.
import {
  MyceliumStore,
  type SubrootRecord,
  type PostRecord,
  type ActorRecord,
} from "../store.ts";
import { handleApi, type ApiDeps } from "../api.ts";

function ok(cond: unknown, msg: string): void {
  if (!cond) throw new Error("FAIL: " + msg);
}

async function memStore(): Promise<MyceliumStore> {
  const kv = await Deno.openKv(":memory:");
  return new MyceliumStore(kv);
}

function root(slug: string, archetype: string): SubrootRecord {
  return {
    slug,
    archetype: archetype as SubrootRecord["archetype"],
    title: slug,
    description: "",
    icon: "",
    url: "",
    config: {
      votes: archetype !== "board",
      anonymous: archetype === "board",
      retentionDays: archetype === "board" ? 1 : null,
    },
    creator: "__instance__",
    mods: [],
    created: new Date().toISOString(),
  };
}

function actor(id: string): ActorRecord {
  return {
    identifier: id,
    actorClass: "person",
    name: id,
    summary: "",
    created: new Date().toISOString(),
    discoverable: true,
  };
}

function deps(
  store: MyceliumStore,
  adminToken: string,
  actor = "alice",
): ApiDeps {
  return {
    store,
    federation: {} as ApiDeps["federation"],
    origin: "https://test.example",
    auth: {
      kv: {} as never,
      authenticate: (t: string) =>
        Promise.resolve(t === "bad-tok" ? null : actor),
      issue: (_a: string, _k: string) => Promise.resolve("tok"),
      revoke: (_t: string) => Promise.resolve(true),
      list: (_a: string) => Promise.resolve([]),
    } as unknown as ApiDeps["auth"],
    rateLimits: {
      read: { allow: (_s: string) => true },
      write: { allow: (_s: string) => true },
    } as ApiDeps["rateLimits"],
    adminToken,
  };
}

function req(
  method: string,
  path: string,
  body?: unknown,
  token?: string,
): Request {
  const init: RequestInit = { method };
  const headers: Record<string, string> = {};
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    headers["content-type"] = "application/json";
  }
  if (token) headers["authorization"] = "Bearer " + token;
  init.headers = headers;
  return new Request("https://test.example" + path, init);
}

// ── DMs ──

Deno.test("v015: DM send + recipient list + unauthorized read blocked", async () => {
  const store = await memStore();
  await store.putActor(actor("alice"));
  await store.putActor(actor("bob"));
  const d = deps(store, "adm", "alice");
  const r1 = await handleApi(
    req("POST", "/api/dm", {
      identifier: "alice",
      to: "bob",
      content: "gm bob",
    }, "tok"),
    d,
  );
  ok(r1.status === 201, "DM send must 201, got " + r1.status);
  const j1 = await r1.json();
  ok(typeof j1.dm.id === "string", "DM id string");
  const dBob = deps(store, "adm", "bob");
  const r2 = await handleApi(
    req("GET", "/api/dm?actor=bob", undefined, "tok"),
    dBob,
  );
  ok(r2.status === 200, "DM list must 200, got " + r2.status);
  const j2 = await r2.json();
  ok(j2.count === 1, "bob sees 1 DM, got " + j2.count);
  ok(j2.dms[0].content === "gm bob", "DM content roundtrip");
  const dEve = deps(store, "adm", "eve");
  const r3 = await handleApi(
    req("GET", "/api/dm?actor=bob", undefined, "tok"),
    dEve,
  );
  ok(r3.status === 401, "cross-actor DM read must 401, got " + r3.status);
});

Deno.test("v015: DM rejects unknown recipient + oversize content", async () => {
  const store = await memStore();
  await store.putActor(actor("alice"));
  await store.putActor(actor("bob"));
  const d = deps(store, "adm", "alice");
  const r1 = await handleApi(
    req("POST", "/api/dm", {
      identifier: "alice",
      to: "ghost",
      content: "hi",
    }, "tok"),
    d,
  );
  ok(r1.status === 404, "DM to unknown actor must 404, got " + r1.status);
  const r2 = await handleApi(
    req("POST", "/api/dm", {
      identifier: "alice",
      to: "bob",
      content: "x".repeat(2001),
    }, "tok"),
    d,
  );
  ok(r2.status === 400, "oversize DM must 400, got " + r2.status);
});

// ── bookmarks ──

Deno.test("v015: bookmark add/list/remove", async () => {
  const store = await memStore();
  await store.putActor(actor("alice"));
  const post: PostRecord = {
    id: "p1",
    identifier: "alice",
    content: "note",
    published: new Date().toISOString(),
    visibility: "public",
  } as PostRecord;
  await store.putPost(post);
  const d = deps(store, "adm", "alice");
  const r1 = await handleApi(
    req("POST", "/api/bookmark", { identifier: "alice", postId: "p1" }, "tok"),
    d,
  );
  ok(r1.status === 201, "bookmark add must 201, got " + r1.status);
  const r2 = await handleApi(
    req("GET", "/api/bookmarks?actor=alice", undefined, "tok"),
    d,
  );
  ok(r2.status === 200, "bookmark list must 200");
  const j2 = await r2.json();
  ok(j2.count === 1, "1 bookmark, got " + j2.count);
  const r3 = await handleApi(
    req("DELETE", "/api/bookmark", { identifier: "alice", postId: "p1" }, "tok"),
    d,
  );
  ok(r3.status === 200, "bookmark remove must 200");
  const r4 = await handleApi(
    req("GET", "/api/bookmarks?actor=alice", undefined, "tok"),
    d,
  );
  const j4 = await r4.json();
  ok(j4.count === 0, "0 bookmarks after remove, got " + j4.count);
});

// ── reports + mod queue ──

Deno.test("v015: report -> admin queue -> resolve -> resolved filter", async () => {
  const store = await memStore();
  await store.putActor(actor("alice"));
  await store.putActor(actor("bob"));
  await store.putSubroot(root("memes", "forum"));
  const post: PostRecord = {
    id: "p1",
    identifier: "bob",
    content: "bad stuff",
    published: new Date().toISOString(),
    visibility: "public",
    subroot: "memes",
  } as PostRecord;
  await store.putPost(post);
  const d = deps(store, "adm", "alice");
  const r1 = await handleApi(
    req("POST", "/api/report", {
      identifier: "alice",
      postId: "p1",
      reason: "nsfw",
      note: "rule 2",
    }, "tok"),
    d,
  );
  ok(r1.status === 201, "report must 201, got " + r1.status);
  const r2 = await handleApi(
    req("GET", "/api/moderation/queue", undefined, "tok"),
    d,
  );
  ok(r2.status === 403, "non-admin queue must 403, got " + r2.status);
  const r3 = await handleApi(
    req("GET", "/api/moderation/queue", undefined, "adm"),
    d,
  );
  ok(r3.status === 200, "admin queue must 200");
  const j3 = await r3.json();
  ok(j3.count === 1, "1 report, got " + j3.count);
  ok(j3.reports[0].reason === "nsfw", "reason roundtrip");
  const rid = j3.reports[0].id;
  const r4 = await handleApi(
    req("POST", "/api/moderation/resolve", { id: rid, action: "dismiss" }, "adm"),
    d,
  );
  ok(r4.status === 200, "resolve must 200, got " + r4.status);
  const r5 = await handleApi(
    req("GET", "/api/moderation/queue?status=resolved", undefined, "adm"),
    d,
  );
  const j5 = await r5.json();
  ok(j5.count === 1, "1 resolved report, got " + j5.count);
});

Deno.test("v015: report reasons restricted to enum", async () => {
  const store = await memStore();
  await store.putActor(actor("alice"));
  const d = deps(store, "adm", "alice");
  const r1 = await handleApi(
    req("POST", "/api/report", {
      identifier: "alice",
      postId: "p1",
      reason: "whatever",
    }, "tok"),
    d,
  );
  ok(r1.status === 400, "bad reason must 400, got " + r1.status);
});

// ── feed sort ──

Deno.test("v015: feed sort new/top/hot", async () => {
  const store = await memStore();
  await store.putActor(actor("alice"));
  await store.putSubroot(root("feed", "feed"));
  const now = Date.now();
  const old: PostRecord = {
    id: "old",
    identifier: "alice",
    content: "old gold",
    published: new Date(now - 864e5).toISOString(),
    visibility: "public",
    subroot: "feed",
  } as PostRecord;
  const fresh: PostRecord = {
    id: "fresh",
    identifier: "alice",
    content: "fresh",
    published: new Date(now).toISOString(),
    visibility: "public",
    subroot: "feed",
  } as PostRecord;
  await store.putPost(old);
  await store.putPost(fresh);
  const d = deps(store, "adm", "alice");
  for (let i = 0; i < 5; i++) {
    await handleApi(
      req("POST", "/api/vote", {
        identifier: "voter" + i,
        postId: "old",
        value: 1,
      }, "adm"),
      d,
    );
  }
  const rNew = await handleApi(req("GET", "/api/feed?sort=new"), d);
  const jNew = await rNew.json();
  ok(jNew.posts[0].id === "fresh", "new sort: fresh first, got " + jNew.posts[0].id);
  const rTop = await handleApi(req("GET", "/api/feed?sort=top"), d);
  const jTop = await rTop.json();
  ok(jTop.posts[0].id === "old", "top sort: old first, got " + jTop.posts[0].id);
  const rHot = await handleApi(req("GET", "/api/feed?sort=hot"), d);
  ok(rHot.status === 200, "hot sort 200");
  const rBad = await handleApi(req("GET", "/api/feed?sort=chaos"), d);
  ok(rBad.status === 400, "invalid sort must 400, got " + rBad.status);
});

// ── board long-form ──

Deno.test("v015: board accepts long-form posts", async () => {
  const store = await memStore();
  await store.putActor(actor("anon"));
  await store.putSubroot(root("board", "board"));
  const d = deps(store, "adm", "anon");
  const r1 = await handleApi(
    req("POST", "/api/post", {
      identifier: "anon",
      content: "long board text ".repeat(50).trim(),
      form: "long",
      title: "board topic",
      subroot: "board",
    }, "tok"),
    d,
  );
  ok(r1.status === 201, "board long-form must 201, got " + r1.status);
});
