// TDD: image support for posts (v0.16.0). HTTPS URL only, no data: URIs.
// TDD: image support for posts (v0.16.0). HTTPS URL only, no data: URIs.
// Mirrors primitives_v015 harness. Boss: images for dankmemes/art/showcase + all forums.
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

// ── Image posts ──

Deno.test("v016: image field accepted (https URL)", async () => {
  const store = await memStore();
  await store.putActor(actor("alice"));
  await store.putSubroot(root("art", "forum"));
  const d = deps(store, "adm");
  const r = await handleApi(
    req("POST", "/api/post", {
      identifier: "alice",
      content: "my art",
      form: "long",
      title: "art dump",
      subroot: "art",
      image: "https://example.com/pic.png",
    }, "tok"),
    d,
  );
  ok(r.status === 201, "image post must 201, got " + r.status);
  const j = await r.json();
  ok(j.post.image === "https://example.com/pic.png", "image stored, got " + j.post.image);
});

Deno.test("v016: rejects http://, data:, javascript: URIs", async () => {
  const store = await memStore();
  await store.putActor(actor("alice"));
  await store.putSubroot(root("art", "forum"));
  const d = deps(store, "adm");
  for (const bad of ["http://example.com/pic.png", "data:image/png;base64,AAAA", "javascript:alert(1)", "not a url"]) {
    const r = await handleApi(
      req("POST", "/api/post", {
        identifier: "alice",
        content: "x",
        form: "long",
        title: "t",
        subroot: "art",
        image: bad,
      }, "tok"),
      d,
    );
    ok(r.status === 400, "bad image must 400, got " + r.status + " for " + bad);
  }
});

Deno.test("v016: image URL max length enforced", async () => {
  const store = await memStore();
  await store.putActor(actor("alice"));
  await store.putSubroot(root("art", "forum"));
  const d = deps(store, "adm");
  const long = "https://example.com/" + "a".repeat(2500);
  const r = await handleApi(
    req("POST", "/api/post", {
      identifier: "alice",
      content: "x",
      form: "long",
      title: "t",
      subroot: "art",
      image: long,
    }, "tok"),
    d,
  );
  ok(r.status === 400, "oversized image must 400, got " + r.status);
});

Deno.test("v016: no image field still fine", async () => {
  const store = await memStore();
  await store.putActor(actor("alice"));
  await store.putSubroot(root("art", "forum"));
  const d = deps(store, "adm");
  const r = await handleApi(
    req("POST", "/api/post", {
      identifier: "alice",
      content: "x",
      form: "long",
      title: "t",
      subroot: "art",
    }, "tok"),
    d,
  );
  ok(r.status === 201, "no-image post must 201, got " + r.status);
});
