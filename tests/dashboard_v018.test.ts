// TDD: v0.18.0 — admin dashboard contract: queue gate, resolve actions.
import { MyceliumStore, type SubrootRecord, type ActorRecord } from "../store.ts";
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
    config: { votes: archetype !== "board", anonymous: archetype === "board", retentionDays: archetype === "board" ? 1 : null },
    creator: "__instance__",
    mods: [],
    created: new Date().toISOString(),
  };
}

function deps(store: MyceliumStore, adminToken: string, who = "alice"): ApiDeps {
  return {
    store,
    federation: {} as ApiDeps["federation"],
    origin: "https://test.example",
    auth: {
      kv: {} as never,
      authenticate: (t: string) => Promise.resolve(t === "bad-tok" ? null : who),
      issue: (_a: string, _k: string) => Promise.resolve("tok"),
      revoke: (_t: string) => Promise.resolve(true),
      list: (_a: string) => Promise.resolve([]),
    } as unknown as ApiDeps["auth"],
    rateLimits: {
      read: { allow: (_s: string) => true },
      write: { allow: (_s: string) => true },
    } as unknown as ApiDeps["rateLimits"],
    adminToken,
  };
}

function req(method: string, path: string, body?: unknown, token?: string): Request {
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

Deno.test("dashboard: queue requires admin token", async () => {
  const store = await memStore();
  const d = deps(store, "admin-secret");
  const noTok = await handleApi(req("GET", "/api/moderation/queue"), d);
  ok(noTok.status === 403, "no token => 403, got " + noTok.status);
  const bad = await handleApi(req("GET", "/api/moderation/queue", undefined, "wrong"), d);
  ok(bad.status === 403, "wrong token => 403, got " + bad.status);
  const good = await handleApi(req("GET", "/api/moderation/queue", undefined, "admin-secret"), d);
  ok(good.status === 200, "admin token => 200, got " + good.status);
  const j = await good.json();
  ok(Array.isArray(j.reports) && j.count === 0, "empty queue shape");
});

Deno.test("dashboard: resolve dismiss + delete_post + 409 on re-resolve", async () => {
  const store = await memStore();
  const alice: ActorRecord = { identifier: "alice", actorClass: "person", name: "Alice", summary: "", created: new Date().toISOString(), discoverable: true };
  await store.putActor(alice);
  await store.putSubroot(root("talk", "feed"));
  const d = deps(store, "admin-secret");
  const post = await handleApi(req("POST", "/api/post", { identifier: "alice", content: "test post for report", form: "short", subroot: "talk" }, "tok"), d);
  ok(post.status === 201, "post created, got " + post.status + " " + await post.clone().text());
  const pj = (await post.json()).post;
  const rep = await handleApi(req("POST", "/api/report", { identifier: "alice", postId: pj.id, reason: "spam", note: "probe" }, "tok"), d);
  ok(rep.status === 201, "report created, got " + rep.status);
  const rj = await rep.json();
  const noAdmin = await handleApi(req("POST", "/api/moderation/resolve", { id: rj.report.id, action: "dismiss" }, "tok"), d);
  ok(noAdmin.status === 403, "resolve needs admin, got " + noAdmin.status);
  const dis = await handleApi(req("POST", "/api/moderation/resolve", { id: rj.report.id, action: "dismiss" }, "admin-secret"), d);
  ok(dis.status === 200, "dismiss ok, got " + dis.status);
  const again = await handleApi(req("POST", "/api/moderation/resolve", { id: rj.report.id, action: "dismiss" }, "admin-secret"), d);
  ok(again.status === 409, "re-resolve => 409, got " + again.status);
  const post2 = await handleApi(req("POST", "/api/post", { identifier: "alice", content: "second post to delete", form: "short", subroot: "talk" }, "tok"), d);
  ok(post2.status === 201, "second post created, got " + post2.status);
  const pj2 = (await post2.json()).post;
  const rep2 = await handleApi(req("POST", "/api/report", { identifier: "alice", postId: pj2.id, reason: "spam" }, "tok"), d);
  ok(rep2.status === 201, "second report created, got " + rep2.status);
  const rj2 = await rep2.json();
  const del = await handleApi(req("POST", "/api/moderation/resolve", { id: rj2.report.id, action: "delete_post" }, "admin-secret"), d);
  ok(del.status === 200, "delete_post ok, got " + del.status);
  const feed = await handleApi(req("GET", "/api/feed?limit=50"), d);
  const fj = await feed.json();
  ok(!fj.posts.some((p: { id: string }) => p.id === pj2.id), "post actually deleted from feed");
});
