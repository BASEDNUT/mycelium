// TDD: v0.19.0 — anonymous content pre-filter. Precision > recall. Profanity allowed.
import { anonFilter } from "../mod_filter.ts";
import { MyceliumStore, type SubrootRecord, type ActorRecord } from "../store.ts";
import { handleApi, type ApiDeps } from "../api.ts";

function ok(cond: unknown, msg: string): void {
  if (!cond) throw new Error("FAIL: " + msg);
}

Deno.test("v019: anon filter blocks NSFW solicitation", () => {
  const r = anonFilter("selling my onlyfans content dm me");
  ok(!r.ok, "must block");
});
Deno.test("v019: anon filter blocks crypto shilling", () => {
  ok(!anonFilter("buy $PEPE now 100x guaranteed profit").ok, "shill 1");
  ok(!anonFilter("presale open dm me for allocation").ok, "shill 2");
  ok(!anonFilter("join t.me/moonshot_pump_group").ok, "shill 3");
});
Deno.test("v019: anon filter blocks targeted threats", () => {
  ok(!anonFilter("I am going to kill you tomorrow").ok, "threat 1");
  ok(!anonFilter("we should murder them all").ok, "threat 2");
});
Deno.test("v019: anon filter ALLOWS profanity", () => {
  ok(anonFilter("this shit is fucking great").ok, "profanity stays");
  ok(anonFilter("what a damn mess").ok, "mild curse stays");
});
Deno.test("v019: anon filter ALLOWS edgy speech", () => {
  ok(anonFilter("the moon landing was fake").ok, "conspiracy ok");
  ok(anonFilter("I hate this movie so much").ok, "opinion ok");
  ok(anonFilter("this politician is an idiot").ok, "politics ok");
  ok(anonFilter("the rocket will launch to the moon soon").ok, "moon literal ok");
});
Deno.test("v019: anon filter rejects at API level with reason", async () => {
  const kv = await Deno.openKv(":memory:");
  const store = new MyceliumStore(kv);
  const alice: ActorRecord = { identifier: "anonymous", actorClass: "person", name: "Anonymous", summary: "", created: new Date().toISOString(), discoverable: false };
  await store.putActor(alice);
  const r: SubrootRecord = {
    slug: "board", archetype: "board", title: "board", description: "", icon: "", url: "",
    config: { votes: false, anonymous: true, retentionDays: 1 },
    creator: "__instance__", mods: [], created: new Date().toISOString(),
  };
  await store.putSubroot(r);
  const deps: ApiDeps = {
    store,
    federation: {} as ApiDeps["federation"],
    origin: "https://test.example",
    auth: {
      kv: {} as never,
      authenticate: () => Promise.resolve(null),
      issue: () => Promise.resolve("t"),
      revoke: () => Promise.resolve(true),
      list: () => Promise.resolve([]),
    } as unknown as ApiDeps["auth"],
    rateLimits: {
      read: { allow: () => true },
      write: { allow: () => true },
    } as unknown as ApiDeps["rateLimits"],
    adminToken: "adm",
  };
  const req = new Request("https://test.example/api/post", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identifier: "", content: "buy $SCAM token guaranteed 100x gains", form: "short", subroot: "board", anonymous: true }),
  });
  const resp = await handleApi(req, deps);
  ok(resp.status === 403, "shill rejected 403, got " + resp.status);
  const j = await resp.json();
  ok(j.reason != null || /rejected/.test(j.error), "has reason: " + JSON.stringify(j));
});
