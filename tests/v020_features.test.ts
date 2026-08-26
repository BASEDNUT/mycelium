// TDD: v0.20.0 — three approved features.
// A. Moderation v1 (9-repo research): flood heuristics, 6-category report
//    reasons, append-only audit log.
// B. Admin-token TTL UX: ttlHours on issue, expires surfaced.
// C. External AP feed deck: outbox.ts pure module + SSRF-guarded /api/outbox
//    + #/deck view.
import { handleApi, type ApiDeps } from "../api.ts";
import { MyceliumStore, type SubrootRecord, type PostRecord } from "../store.ts";
import { anonFilter } from "../mod_filter.ts";
import { normalizeNote, webfingerUrl, extractPosts, OutboxCache } from "../outbox.ts";

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

interface IssueCap {
  actor?: string;
  label?: string;
  ttlMs?: number;
}

function deps(store: MyceliumStore, who = "alice", cap?: IssueCap): ApiDeps {
  return {
    store,
    federation: {} as ApiDeps["federation"],
    origin: "https://test.example",
    auth: {
      authenticate: (t: string) => Promise.resolve(t === "bad-tok" ? null : who),
      issue: (a: string, l: string | undefined, ttlMs?: number) => {
        if (cap) { cap.actor = a; cap.label = l; cap.ttlMs = ttlMs; }
        return Promise.resolve("tok-" + a);
      },
      revoke: (_t: string) => Promise.resolve(true),
      list: (_a?: string) => Promise.resolve([]),
    } as unknown as ApiDeps["auth"],
    rateLimits: {
      read: { allow: (_s: string) => true },
      write: { allow: (_s: string) => true },
      federation: { allow: (_s: string) => true },
    } as unknown as ApiDeps["rateLimits"],
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

async function seedPost(store: MyceliumStore, id: string): Promise<void> {
  await store.putActor({ identifier: "alice", actorClass: "person", name: "Alice", summary: "", created: new Date().toISOString(), discoverable: true });
  await store.putSubroot(root("talk", "feed"));
  await store.putPost({
    id,
    identifier: "alice",
    content: "hello world " + id,
    published: new Date().toISOString(),
    visibility: "public",
    form: "short",
    subroot: "talk",
  } as unknown as PostRecord);
}

// ── A1. mod_filter: flood heuristics (spec B verdict: SHIP) ──

Deno.test("filter: all-caps spam flood blocked", () => {
  const r = anonFilter("BUY NOW CLICK HERE FREE MONEY GUARANTEED WIN BIG PRIZE CLAIM TODAY");
  ok(!r.ok, "all-caps spam must be blocked, got " + JSON.stringify(r));
  ok(r.reason === "spam-flood", "reason must be spam-flood, got " + r.reason);
});

Deno.test("filter: link flood (4+ links) blocked", () => {
  const r = anonFilter("check this out http://a.example http://b.example http://c.example http://d.example");
  ok(!r.ok && r.reason === "spam-flood", "link flood must be blocked as spam-flood");
});

Deno.test("filter: single-char spam (10+ repeats) blocked", () => {
  const r = anonFilter("aaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  ok(!r.ok && r.reason === "spam-flood", "char spam must be blocked as spam-flood");
});

Deno.test("filter: profanity and short caps stay legal", () => {
  ok(anonFilter("this is fucking great").ok, "profanity is protected");
  ok(anonFilter("NICE!").ok, "short caps emphasis is protected");
  ok(anonFilter("i love this place so much everyone").ok, "normal text is protected");
});

// ── A2. report reasons: 6-category SFW policy (spec D) ──

Deno.test("report: impersonation and malware reasons accepted", async () => {
  const store = await memStore();
  await seedPost(store, "p1");
  const d = deps(store);
  const a = await handleApi(req("POST", "/api/report", { identifier: "alice", postId: "p1", reason: "impersonation", note: "fake admin" }, "tok"), d);
  ok(a.status === 201, "impersonation reason must be accepted, got " + a.status);
  const b = await handleApi(req("POST", "/api/report", { identifier: "alice", postId: "p1", reason: "malware", note: "bad link" }, "tok"), d);
  ok(b.status === 201, "malware reason must be accepted, got " + b.status);
});

// ── A3. append-only audit log ──

Deno.test("audit: report + resolve leave audit trail", async () => {
  const store = await memStore();
  await seedPost(store, "p1");
  const d = deps(store);
  const rep = await handleApi(req("POST", "/api/report", { identifier: "alice", postId: "p1", reason: "harassment", note: "rude" }, "tok"), d);
  const repBody = await rep.json();
  const res = await handleApi(req("POST", "/api/moderation/resolve", { id: repBody.report.id, action: "dismiss" }, "admin-secret"), d);
  ok(res.status === 200, "resolve must succeed");
  const audit = await handleApi(req("GET", "/api/moderation/audit", undefined, "admin-secret"), d);
  ok(audit.status === 200, "audit endpoint must exist, got " + audit.status);
  const body = await audit.json();
  ok(body.count === 2, "two audit entries expected (report + resolve), got " + body.count);
  const actions = body.audit.map((e: { action: string }) => e.action).sort();
  ok(actions[0] === "dismiss" && actions[1] === "report", "audit actions must be report+dismiss, got " + JSON.stringify(actions));
  for (const e of body.audit) {
    ok(typeof e.ts === "string" && typeof e.actor === "string" && typeof e.target === "string", "audit entries need actor/target/ts");
  }
});

Deno.test("audit: endpoint is admin-gated", async () => {
  const store = await memStore();
  const d = deps(store);
  const r = await handleApi(req("GET", "/api/moderation/audit"), d);
  ok(r.status === 403, "audit endpoint must be admin-gated, got " + r.status);
});

// ── B. token TTL ──

Deno.test("token: issue accepts ttlHours and surfaces expires", async () => {
  const store = await memStore();
  await store.putActor({ identifier: "alice", actorClass: "person", name: "Alice", summary: "", created: new Date().toISOString(), discoverable: true });
  const cap: IssueCap = {};
  const d = deps(store, "alice", cap);
  const r = await handleApi(req("POST", "/api/token/issue", { identifier: "alice", ttlHours: 24 }, "admin-secret"), d);
  ok(r.status === 201, "issue with ttlHours must succeed, got " + r.status);
  const body = await r.json();
  ok(cap.ttlMs === 24 * 60 * 60 * 1000, "ttlMs must be 86400000, got " + cap.ttlMs);
  ok(typeof body.expires === "string" && body.expires.length > 10, "response must include expires ISO string");
});

Deno.test("token: issue without ttlHours has no expires", async () => {
  const store = await memStore();
  await store.putActor({ identifier: "alice", actorClass: "person", name: "Alice", summary: "", created: new Date().toISOString(), discoverable: true });
  const cap: IssueCap = {};
  const d = deps(store, "alice", cap);
  const r = await handleApi(req("POST", "/api/token/issue", { identifier: "alice" }, "admin-secret"), d);
  const body = await r.json();
  ok(r.status === 201 && cap.ttlMs === undefined, "no ttlHours means no TTL passed");
  ok(body.expires === undefined, "no expires without ttlHours");
});

Deno.test("token: invalid ttlHours rejected", async () => {
  const store = await memStore();
  await store.putActor({ identifier: "alice", actorClass: "person", name: "Alice", summary: "", created: new Date().toISOString(), discoverable: true });
  const d = deps(store);
  const r = await handleApi(req("POST", "/api/token/issue", { identifier: "alice", ttlHours: 0 }, "admin-secret"), d);
  ok(r.status === 400, "ttlHours 0 must be rejected, got " + r.status);
});

// ── C1. outbox.ts pure module ──

Deno.test("outbox: webfingerUrl builds correct endpoint", () => {
  const u = webfingerUrl("alice@social.example");
  ok(u === "https://social.example/.well-known/webfinger?resource=acct%3Aalice%40social.example", "webfinger url, got " + u);
});

Deno.test("outbox: normalizeNote strips HTML and maps fields", () => {
  const n = normalizeNote({
    type: "Note",
    id: "https://social.example/notes/1",
    attributedTo: "https://social.example/users/alice",
    content: "<p>Hello <b>world</b> &amp; friends</p>",
    published: "2026-01-01T00:00:00Z",
  });
  ok(n != null, "note must normalize");
  ok(n!.id === "https://social.example/notes/1", "id preserved");
  ok(n!.actor === "https://social.example/users/alice", "actor preserved");
  ok(n!.content === "Hello world & friends", "html stripped, got " + JSON.stringify(n!.content));
  ok(n!.published === "2026-01-01T00:00:00Z", "published preserved");
});

Deno.test("outbox: normalizeNote rejects non-notes", () => {
  ok(normalizeNote({ type: "Announce", id: "x", object: "y" }) === null, "non-Note must be null");
  ok(normalizeNote({ type: "Note", id: "x", attributedTo: "a" }) === null, "note without content must be null");
});

Deno.test("outbox: extractPosts pulls notes from orderedItems", () => {
  const doc = {
    type: "OrderedCollection",
    orderedItems: [
      { type: "Note", id: "n1", attributedTo: "a1", content: "one", published: "t1" },
      { type: "Announce", id: "x", object: "y" },
      { type: "Note", id: "n2", attributedTo: "a2", content: "two", published: "t2" },
    ],
  };
  const posts = extractPosts(doc);
  ok(posts.length === 2, "two notes extracted, got " + posts.length);
  ok(posts[0].id === "n1" && posts[1].id === "n2", "order preserved");
});

Deno.test("outbox: cache honors TTL", async () => {
  const c = new OutboxCache(40);
  c.set("k", { type: "OrderedCollection" });
  ok(c.get("k") != null, "fresh entry present");
  await new Promise((r) => setTimeout(r, 70));
  ok(c.get("k") === null, "expired entry must be gone");
});

// ── C2. /api/outbox route contract ──

Deno.test("outbox route: missing params rejected", async () => {
  const store = await memStore();
  const d = deps(store);
  const r = await handleApi(req("GET", "/api/outbox"), d);
  ok(r.status === 400, "missing params must 400, got " + r.status);
});

Deno.test("outbox route: SSRF blocked", async () => {
  const store = await memStore();
  const d = deps(store);
  const target = encodeURIComponent("http://127.0.0.1:9/x");
  const r = await handleApi(req("GET", "/api/outbox?url=" + target), d);
  ok(r.status === 403, "private IP must be 403, got " + r.status);
});

// ── C3/B-UI. surface wiring (source checks like v0.19.1 a11y test) ──

Deno.test("deck: #/deck view wired in landing app", () => {
  const js = Deno.readTextFileSync("landing_app.ts");
  ok(js.includes("#/deck"), "router must mount #/deck");
  ok(js.includes("viewDeck"), "viewDeck function must exist");
});

Deno.test("admin: token panel lists tokens with expiry", () => {
  const js = Deno.readTextFileSync("landing_app.ts");
  ok(js.includes("/api/token/list"), "admin panel must call token list");
  ok(js.includes("ttlHours"), "admin panel must offer TTL option");
});

Deno.test("README: outbox.ts listed in file map", () => {
  const md = Deno.readTextFileSync("README.md");
  ok(md.includes("| outbox.ts |"), "README must list outbox.ts");
});
