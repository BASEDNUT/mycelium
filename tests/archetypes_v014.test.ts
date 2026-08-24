// v0.14.0 tests: subroot required on every post, reply inheritance,
// archetype form rules, moderator powers. Design: docs/subroots-identity-v1.md.
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

function root(slug: string, archetype: string, mods: string[] = []): SubrootRecord {
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
    mods,
    created: new Date().toISOString(),
  };
}

const person: ActorRecord = {
  identifier: "peanutoshi",
  actorClass: "person",
  name: "Peanutoshi",
  summary: "",
  created: new Date().toISOString(),
  discoverable: true,
};
const modGuy: ActorRecord = { ...person, identifier: "modguy", name: "Mod Guy" };

function deps(store: MyceliumStore, adminToken: string, actor = "peanutoshi"): ApiDeps {
  return {
    store,
    federation: {} as ApiDeps["federation"],
    origin: "https://test.example",
    auth: {
      kv: {} as never,
      authenticate: (_t: string) => Promise.resolve(actor),
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

Deno.test("v014: post without subroot is rejected", async () => {
  const store = await memStore();
  await store.putActor(person);
  await store.putSubroot(root("memes", "forum"));
  const d = deps(store, "adm");
  const r = await handleApi(
    req("POST", "/api/post", { identifier: "peanutoshi", content: "x", form: "long", title: "t" }, "tok"),
    d,
  );
  ok(r.status === 400, "no-subroot post must 400, got " + r.status);
});

Deno.test("v014: reply inherits parent subroot", async () => {
  const store = await memStore();
  await store.putActor(person);
  await store.putSubroot(root("memes", "forum"));
  const op: PostRecord = {
    id: "op1",
    identifier: "peanutoshi",
    content: "topic",
    published: new Date().toISOString(),
    visibility: "public",
    form: "long",
    title: "T",
    subroot: "memes",
  };
  await store.putPost(op);
  const d = deps(store, "adm");
  const r = await handleApi(
    req("POST", "/api/post", { identifier: "peanutoshi", content: "reply", form: "long", title: "R", inReplyTo: "op1" }, "tok"),
    d,
  );
  ok(r.status === 201, "reply inherits root, got " + r.status);
  const j = await r.json();
  ok(j.post.subroot === "memes", "subroot inherited, got " + j.post.subroot);
});

Deno.test("v014: board rejects long-form, forum rejects short-form", async () => {
  const store = await memStore();
  await store.putActor(person);
  await store.putSubroot(root("b", "board"));
  await store.putSubroot(root("f", "forum"));
  const d = deps(store, "adm");
  const r1 = await handleApi(
    req("POST", "/api/post", { identifier: "peanutoshi", content: "x", form: "long", title: "t", subroot: "b" }, "tok"),
    d,
  );
  ok(r1.status === 400, "board long must 400, got " + r1.status);
  const r2 = await handleApi(
    req("POST", "/api/post", { identifier: "peanutoshi", content: "x", form: "short", subroot: "f" }, "tok"),
    d,
  );
  ok(r2.status === 400, "forum short must 400, got " + r2.status);
});

Deno.test("v014: moderator may delete posts in their root", async () => {
  const store = await memStore();
  await store.putActor(person);
  await store.putActor(modGuy);
  await store.putSubroot(root("memes", "forum", ["modguy"]));
  const op: PostRecord = {
    id: "p9",
    identifier: "peanutoshi",
    content: "bad",
    published: new Date().toISOString(),
    visibility: "public",
    form: "long",
    title: "T",
    subroot: "memes",
  };
  await store.putPost(op);
  const d = deps(store, "adm", "modguy");
  const r = await handleApi(req("DELETE", "/api/post?id=p9", undefined, "tok-modguy"), d);
  ok(r.status === 200, "mod delete must 200, got " + r.status);
  const gone = await store.getPost("p9");
  ok(gone == null, "post must be gone");
});

Deno.test("v014: non-mod cannot delete others post", async () => {
  const store = await memStore();
  await store.putActor(person);
  await store.putActor(modGuy);
  await store.putSubroot(root("memes", "forum", ["someoneelse"]));
  const op: PostRecord = {
    id: "p10",
    identifier: "peanutoshi",
    content: "mine",
    published: new Date().toISOString(),
    visibility: "public",
    form: "long",
    title: "T",
    subroot: "memes",
  };
  await store.putPost(op);
  const d = deps(store, "adm", "modguy");
  const r = await handleApi(req("DELETE", "/api/post?id=p10", undefined, "tok-modguy"), d);
  ok(r.status === 403, "non-mod delete must 403, got " + r.status);
});

Deno.test("v014: creator may set mods via PATCH", async () => {
  const store = await memStore();
  await store.putActor(person);
  await store.putActor(modGuy);
  const r0 = root("memes", "forum");
  r0.creator = "peanutoshi";
  await store.putSubroot(r0);
  const d = deps(store, "adm", "peanutoshi");
  const r = await handleApi(
    req("PATCH", "/api/subroot?slug=memes", { mods: ["modguy"] }, "tok-creator"),
    d,
  );
  ok(r.status === 200, "creator patch mods must 200, got " + r.status);
  const sr = await store.getSubroot("memes");
  ok(sr != null && sr.mods != null && sr.mods.includes("modguy"), "mods persisted");
});
