// TDD: v0.19.1 — external-audit hardening pass.
// 1. Rate limits keyed by bearer token when present (token binding).
// 2. README file map matches actual repo layout.
// 3. Nav a11y: aria-current on active nav item.
// 4. CSP: style tag nonce-gated like scripts.
import { handleApi, type ApiDeps } from "../api.ts";
import { MyceliumStore, type SubrootRecord } from "../store.ts";
import { landingHtml } from "../landing.ts";

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

function deps(store: MyceliumStore, rateLimits: unknown, who = "alice"): ApiDeps {
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
    rateLimits: rateLimits as unknown as ApiDeps["rateLimits"],
    adminToken: "admin-secret",
  };
}

function req(method: string, path: string, body?: unknown, token?: string, xff?: string): Request {
  const init: RequestInit = { method };
  const headers: Record<string, string> = {};
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    headers["content-type"] = "application/json";
  }
  if (token) headers["authorization"] = "Bearer " + token;
  if (xff) headers["x-forwarded-for"] = xff;
  init.headers = headers;
  return new Request("https://test.example" + path, init);
}

Deno.test("rate limit: write limit binds to bearer token when present", async () => {
  const store = await memStore();
  await store.putActor({ identifier: "alice", actorClass: "person", name: "Alice", summary: "", created: new Date().toISOString(), discoverable: true });
  await store.putSubroot(root("talk", "feed"));
  const keys: string[] = [];
  const d = deps(store, {
    read: { allow: (_s: string) => true },
    write: { allow: (s: string) => { keys.push(s); return true; } },
    federation: { allow: (_s: string) => true },
  });
  const body = { identifier: "alice", content: "hello", form: "short", subroot: "talk" };
  // Same token, two different IPs: limiter key MUST be the same (token-bound).
  await handleApi(req("POST", "/api/post", body, "tok-alice", "203.0.113.1"), d);
  await handleApi(req("POST", "/api/post", body, "tok-alice", "203.0.113.2"), d);
  ok(keys.length === 2, "write limiter called twice, got " + keys.length);
  ok(keys[0] === keys[1], "same token across IPs must share one bucket: " + JSON.stringify(keys));
  ok(keys[0].indexOf("203.0.113") === -1, "key must not be IP-derived: " + keys[0]);
  // Different token => different bucket.
  await handleApi(req("POST", "/api/post", body, "tok-bob", "203.0.113.1"), d);
  ok(keys[2] !== keys[0], "different tokens must use different buckets");
  // Anonymous (no bearer): falls back to client IP key.
  const anonKeys: string[] = [];
  const d2 = deps(store, {
    read: { allow: (_s: string) => true },
    write: { allow: (s: string) => { anonKeys.push(s); return true; } },
    federation: { allow: (_s: string) => true },
  });
  await handleApi(req("POST", "/api/post", body, undefined, "198.51.100.7"), d2);
  ok(anonKeys.length === 1 && anonKeys[0].indexOf("198.51.100.7") !== -1, "anon key must be IP-derived, got " + JSON.stringify(anonKeys));
});

Deno.test("rate limit: federation limiter binds to bearer token too", async () => {
  const store = await memStore();
  await store.putActor({ identifier: "alice", actorClass: "person", name: "Alice", summary: "", created: new Date().toISOString(), discoverable: true });
  const keys: string[] = [];
  const d = deps(store, {
    read: { allow: (_s: string) => true },
    write: { allow: (_s: string) => true },
    federation: { allow: (s: string) => { keys.push(s); return true; } },
  });
  const body = { identifier: "alice", target: "https://remote.example/ap/actor/bob" };
  await handleApi(req("POST", "/api/follow", body, "tok-alice", "203.0.113.1"), d);
  await handleApi(req("POST", "/api/follow", body, "tok-alice", "203.0.113.9"), d);
  ok(keys.length === 2 && keys[0] === keys[1], "follow limiter must be token-bound: " + JSON.stringify(keys));
});

Deno.test("README: file map lists all tracked source modules", () => {
  const md = Deno.readTextFileSync("README.md");
  const required = ["auth.ts", "crypto.ts", "ratelimit.ts", "ssrf.ts", "mod_filter.ts", "ranking.ts", "llms_txt.ts", "landing_app.ts"];
  for (const f of required) {
    ok(md.includes("| " + f + " |"), "README layout table must list " + f);
  }
  ok(md.includes("tests/"), "README must mention tests/");
  ok(md.includes("docs/"), "README must mention docs/");
});

Deno.test("a11y: nav items carry aria-current when active", () => {
  const js = Deno.readTextFileSync("landing_app.ts");
  ok(js.includes("aria-current"), "navItem must set aria-current for the active view");
});

Deno.test("CSP: style tag is nonce-gated", () => {
  const graph = { nodes: [], edges: [], counts: { actors: 0, objects: 0, follows: 0, replies: 0, totalNodes: 0, totalEdges: 0 } } as never;
  const html = landingHtml("https://test.example", [], [], graph, "nonce123");
  ok(html.includes('<style nonce="nonce123">'), "style tag must carry the CSP nonce");
  ok(!html.includes("unsafe-inline"), "no unsafe-inline in rendered HTML");
});
