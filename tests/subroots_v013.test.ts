// v0.13.0 tests: creator management, icon/url fields, anonymous board posting,
// 24h board retention. Design: docs/subroots-identity-v1.md + Boss directives.
import {
  MyceliumStore,
  type SubrootRecord,
  type PostRecord,
  type ActorRecord,
} from "../store.ts";
import { validateSubroot, handleApi, type ApiDeps } from "../api.ts";
import type { Federation } from "@fedify/fedify";

function ok(cond: unknown, msg: string): void {
  if (!cond) throw new Error("FAIL: " + msg);
}

async function memStore(): Promise<MyceliumStore> {
  const kv = await Deno.openKv(":memory:");
  return new MyceliumStore(kv);
}

function board(slug = "board", retentionDays = 1): SubrootRecord {
  return {
    slug,
    archetype: "board",
    title: "Board",
    description: "anon board",
    icon: "\u{1F5BC}\uFE0F",
    url: "",
    config: { votes: false, anonymous: true, retentionDays },
    creator: "__instance__",
    created: new Date().toISOString(),
  };
}

function forum(slug = "basednut"): SubrootRecord {
  return {
    slug,
    archetype: "forum",
    title: "Forum",
    description: "forum root",
    icon: "",
    url: "",
    config: { votes: true, anonymous: false, retentionDays: null },
    creator: "peanutoshi",
    created: new Date().toISOString(),
  };
}

const anonActor: ActorRecord = {
  identifier: "anonymous",
  actorClass: "person",
  name: "Anonymous",
  summary: "",
  created: new Date().toISOString(),
  discoverable: false,
};

async function putPost(
  store: MyceliumStore,
  id: string,
  published: string,
  subroot?: string,
): Promise<void> {
  const rec: PostRecord = {
    id,
    identifier: "bot",
    content: "test " + id,
    published,
    visibility: "public",
    form: "short",
    ...(subroot != null ? { subroot } : {}),
  };
  await store.putPost(rec);
}

async function fakeDeps(store: MyceliumStore): Promise<ApiDeps> {
  return {
    store,
    federation: {} as unknown as Federation<void>, // fan-out failures are caught
    origin: "https://test.example",
    auth: {
      issue: (_actor: string) => Promise.resolve("tok-" + Math.random()),
      authenticate: (t: string) => Promise.resolve(t.startsWith("pea:") ? "peanutoshi" : t === "adm" ? "admin-x" : null),
      revoke: (_t: string) => Promise.resolve(),
    } as unknown as ApiDeps["auth"],
    rateLimits: {
      write: { allow: (_k: string) => true, snapshot: () => ({}) },
      read: { allow: (_k: string) => true, snapshot: () => ({}) },
    } as unknown as ApiDeps["rateLimits"],
    adminToken: "adm",
  };
}

Deno.test("v013: store.updateSubroot patches icon/url/description", async () => {
  const s = await memStore();
  await s.putSubroot(forum());
  const out = await s.updateSubroot("basednut", {
    icon: "\u{1F95C}",
    url: "https://basednut.com",
    description: "updated desc",
  });
  ok(out != null, "update returns record");
  ok(out!.icon === "\u{1F95C}", "icon patched");
  ok(out!.url === "https://basednut.com", "url patched");
  ok(out!.description === "updated desc", "desc patched");
  ok(out!.slug === "basednut" && out!.creator === "peanutoshi", "immutable fields kept");
  const miss = await s.updateSubroot("nope", { icon: "x" });
  ok(miss == null, "unknown slug -> null");
});

Deno.test("v013: validateSubroot accepts icon/url, rejects bad url", () => {
  const good = validateSubroot({
    slug: "b",
    archetype: "board",
    title: "x",
    description: "",
    icon: "\u{1F5BC}\uFE0F",
    url: "https://ok.example",
    config: { votes: true, anonymous: true, retentionDays: 1 },
  });
  ok(good.valid, "valid icon/url must pass");
  ok(good.valid === true && good.record.icon === "\u{1F5BC}\uFE0F", "icon preserved");
  const badUrl = validateSubroot({
    slug: "b",
    archetype: "board",
    title: "x",
    description: "",
    url: "javascript:alert(1)",
    config: { votes: true, anonymous: true, retentionDays: 1 },
  });
  ok(!badUrl.valid, "non-http url must fail");
  const noUrl = validateSubroot({
    slug: "b",
    archetype: "board",
    title: "x",
    description: "",
    config: { votes: true, anonymous: true, retentionDays: 1 },
  });
  ok(noUrl.valid, "no url (undefined) must pass with empty url");
  ok(noUrl.valid === true && noUrl.record.url === "", "url defaults empty");
});

Deno.test("v013: anonymous board post via handleApi (no auth token)", async () => {
  const s = await memStore();
  await s.putSubroot(board());
  await s.putActor(anonActor);
  const deps = await fakeDeps(s);
  const res = await handleApi(
    new Request("https://x/api/post", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        identifier: "",
        content: "hello from the void",
        form: "short",
        subroot: "board",
        anonymous: true,
      }),
    }),
    deps,
  );
  ok(res.status === 201, "anon board post must 201, got " + res.status);
  const posts = await s.listPosts(null, "board");
  ok(posts.length === 1 && posts[0].identifier === "anonymous", "stored as anonymous actor");
});

Deno.test("v013: anonymous post rejected outside anonymous boards", async () => {
  const s = await memStore();
  await s.putSubroot(forum());
  await s.putActor(anonActor);
  const deps = await fakeDeps(s);
  const res = await handleApi(
    new Request("https://x/api/post", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        identifier: "",
        content: "not allowed",
        form: "short",
        subroot: "basednut",
        anonymous: true,
      }),
    }),
    deps,
  );
  ok(res.status === 403, "anon post in non-anon root must 403, got " + res.status);
});

Deno.test("v013: anonymous post without flag still requires auth", async () => {
  const s = await memStore();
  await s.putSubroot(board());
  const deps = await fakeDeps(s);
  const res = await handleApi(
    new Request("https://x/api/post", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identifier: "bot", content: "x", form: "short", subroot: "board" }),
    }),
    deps,
  );
  ok(res.status === 401, "non-anon path without token must 401, got " + res.status);
});

Deno.test("v013: PATCH subroot as creator via actor token", async () => {
  const s = await memStore();
  await s.putSubroot(forum());
  const deps = await fakeDeps(s);
  const res = await handleApi(
    new Request("https://x/api/subroot?slug=basednut", {
      method: "PATCH",
      headers: { "content-type": "application/json", authorization: "Bearer pea:t" },
      body: JSON.stringify({
        title: "BASED NUT \u{1F95C}",
        description: "orchard home",
        icon: "\u{1F95C}",
        url: "https://basednut.com",
      }),
    }),
    deps,
  );
  ok(res.status === 200, "creator PATCH must 200, got " + res.status);
  const sr = await s.getSubroot("basednut");
  ok(sr != null && sr.title === "BASED NUT \u{1F95C}", "title updated");
});

Deno.test("v013: PATCH subroot rejected for non-creator", async () => {
  const s = await memStore();
  await s.putSubroot(forum()); // creator = peanutoshi
  const deps = await fakeDeps(s);
  // token authenticates as peanutoshi only when prefixed pea:; use unknown bearer
  const res = await handleApi(
    new Request("https://x/api/subroot?slug=basednut", {
      method: "PATCH",
      headers: { "content-type": "application/json", authorization: "Bearer other" },
      body: JSON.stringify({ title: "hijack" }),
    }),
    deps,
  );
  ok(res.status === 403, "non-creator PATCH must 403, got " + res.status);
});

Deno.test("v013: DELETE subroot admin-only", async () => {
  const s = await memStore();
  await s.putSubroot(forum());
  const deps = await fakeDeps(s);
  const noauth = await handleApi(
    new Request("https://x/api/subroot?slug=basednut", { method: "DELETE" }),
    deps,
  );
  ok(noauth.status === 401, "DELETE without admin must 401");
  const adm = await handleApi(
    new Request("https://x/api/subroot?slug=basednut", {
      method: "DELETE",
      headers: { authorization: "Bearer adm" },
    }),
    deps,
  );
  ok(adm.status === 200, "admin DELETE must 200");
  ok(await s.getSubroot("basednut") == null, "subroot gone");
});

Deno.test("v013: board 24h retention sweeps day-old posts", async () => {
  const s = await memStore();
  await s.putSubroot(board("board", 1)); // 1 day retention
  const now = new Date();
  const h25 = new Date(now.getTime() - 25 * 3_600_000).toISOString();
  const h12 = new Date(now.getTime() - 12 * 3_600_000).toISOString();
  await putPost(s, "stale", h25, "board");
  await putPost(s, "fresh", h12, "board");
  const n = await s.sweepExpiredPosts(now);
  ok(n === 1, "one post swept (25h > 24h), got " + n);
  ok(await s.getPost("stale") == null, "25h post deleted");
  ok(await s.getPost("fresh") != null, "12h post kept");
});
