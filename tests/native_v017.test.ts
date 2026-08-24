// TDD: v0.17.0 — anonymous board rules (no links, no images, anon replies).
// Client renderers (timeline / imageboard / reddit rows) are visual layers;
// these tests pin the API contract they rely on.
import {
  MyceliumStore,
  type SubrootRecord,
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
  who = "alice",
): ApiDeps {
  return {
    store,
    federation: {} as ApiDeps["federation"],
    origin: "https://test.example",
    auth: {
      kv: {} as never,
      authenticate: (t: string) =>
        Promise.resolve(t === "bad-tok" ? null : who),
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

async function setup(): Promise<MyceliumStore> {
  const store = await memStore();
  await store.putActor(actor("anonymous"));
  await store.putActor(actor("alice"));
  await store.putSubroot(root("board", "board"));
  await store.putSubroot(root("talk", "forum"));
  return store;
}

Deno.test("v017: anon board post with https link rejected", async () => {
  const store = await setup();
  const d = deps(store, "adm");
  const r = await handleApi(
    req("POST", "/api/post", {
      identifier: "",
      content: "check https://scam.example now",
      form: "short",
      subroot: "board",
      anonymous: true,
    }),
    d,
  );
  ok(r.status === 403, "must 403, got " + r.status);
  const j = await r.json();
  ok(/links/.test(j.error), "error mentions links: " + j.error);
});

Deno.test("v017: anon board post with www. link rejected", async () => {
  const store = await setup();
  const d = deps(store, "adm");
  const r = await handleApi(
    req("POST", "/api/post", {
      identifier: "",
      content: "see www.example.com lol",
      form: "short",
      subroot: "board",
      anonymous: true,
    }),
    d,
  );
  ok(r.status === 403, "must 403, got " + r.status);
});

Deno.test("v017: anon board post with image rejected", async () => {
  const store = await setup();
  const d = deps(store, "adm");
  const r = await handleApi(
    req("POST", "/api/post", {
      identifier: "",
      content: "clean text",
      form: "short",
      subroot: "board",
      anonymous: true,
      image: "https://example.com/pic.png",
    }),
    d,
  );
  ok(r.status === 403, "must 403, got " + r.status);
  const j = await r.json();
  ok(/images/.test(j.error), "error mentions images: " + j.error);
});

Deno.test("v017: anon board post clean text accepted", async () => {
  const store = await setup();
  const d = deps(store, "adm");
  const r = await handleApi(
    req("POST", "/api/post", {
      identifier: "",
      content: "just vibes, >>12345 checked",
      form: "short",
      subroot: "board",
      anonymous: true,
    }),
    d,
  );
  ok(r.status === 201, "must 201, got " + r.status);
  const j = await r.json();
  ok(j.post.identifier === "anonymous", "author anonymous: " + j.post.identifier);
});

Deno.test("v017: anonymous reply to board OP accepted (no auth)", async () => {
  const store = await setup();
  const d = deps(store, "adm");
  const op = await handleApi(
    req("POST", "/api/post", {
      identifier: "",
      content: "OP thread",
      form: "short",
      subroot: "board",
      anonymous: true,
    }),
    d,
  );
  ok(op.status === 201, "OP must 201, got " + op.status);
  const opj = await op.json();
  const r2 = await handleApi(
    req("POST", "/api/post", {
      identifier: "",
      content: "anon reply no login",
      form: "short",
      subroot: "board",
      anonymous: true,
      inReplyTo: opj.post.id,
    }),
    d,
  );
  ok(r2.status === 201, "reply must 201, got " + r2.status);
  const j2 = await r2.json();
  ok(String(j2.post.inReplyTo).indexOf(opj.post.id) !== -1, "inReplyTo set: " + j2.post.inReplyTo);
  ok(j2.post.identifier === "anonymous", "reply author anonymous");
});

Deno.test("v017: anon posting on forum root still rejected", async () => {
  const store = await setup();
  const d = deps(store, "adm");
  const r = await handleApi(
    req("POST", "/api/post", {
      identifier: "",
      content: "hi",
      form: "short",
      subroot: "talk",
      anonymous: true,
    }),
    d,
  );
  ok(r.status === 403, "must 403, got " + r.status);
});

Deno.test("v017: logged-in post with image still works (regression)", async () => {
  const store = await setup();
  const d = deps(store, "adm");
  const r = await handleApi(
    req("POST", "/api/post", {
      identifier: "alice",
      content: "my art",
      form: "long",
      title: "art dump",
      subroot: "talk",
      image: "https://example.com/pic.png",
    }, "tok"),
    d,
  );
  ok(r.status === 201, "must 201, got " + r.status);
});
