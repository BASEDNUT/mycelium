// v0.8.0 audit-fix regression tests (audit HIGH: no test/conformance layer).
// Zero new deps: plain assertions keep the frozen lockfile untouched.
import { classifyVisibility } from "../notes.ts";
import { clientKey, NodeRateLimits } from "../ratelimit.ts";
import { NetworkProjection } from "../network.ts";
import type { ActorRecord, PostRecord } from "../store.ts";

function ok(cond: unknown, msg: string): void {
  if (!cond) throw new Error("FAIL: " + msg);
}
function eq(a: unknown, b: unknown, msg: string): void {
  if (a !== b) {
    throw new Error(`FAIL: ${msg} — expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
  }
}

Deno.test("classifyVisibility: public when to=Public", () => {
  eq(classifyVisibility({
    to: ["https://www.w3.org/ns/activitystreams#Public"],
    cc: ["https://example.com/followers"],
  }), "public", "to=Public → public");
});

Deno.test("classifyVisibility: unlisted when cc=Public only", () => {
  eq(classifyVisibility({
    to: ["https://example.com/followers"],
    cc: ["https://www.w3.org/ns/activitystreams#Public"],
  }), "unlisted", "cc=Public → unlisted");
});

Deno.test("classifyVisibility: followers default for non-public addressing", () => {
  eq(classifyVisibility({ to: ["https://x/followers"] }), "followers", "followers-only → followers");
  eq(classifyVisibility({}), "followers", "no addressing → followers");
  eq(classifyVisibility({ to: "https://x/alice" }), "followers", "direct → followers");
});

Deno.test("clientKey: rightmost XFF wins (leftmost spoofable)", () => {
  const r = new Request("https://n/", {
    headers: { "x-forwarded-for": "1.2.3.4, 10.0.0.1" },
  });
  eq(clientKey(r), "10.0.0.1", "rightmost XFF");
  const single = new Request("https://n/", {
    headers: { "x-forwarded-for": "5.6.7.8" },
  });
  eq(clientKey(single), "5.6.7.8", "single XFF");
});

Deno.test("clientKey: fallback when no XFF", () => {
  eq(clientKey(new Request("https://n/")), "local", "no XFF → local");
});

Deno.test("rate limits: write burst then deny", () => {
  const rl = new NodeRateLimits();
  let allowed = 0;
  for (let i = 0; i < 40; i++) {
    if (rl.write.allow("t-client")) allowed++;
  }
  eq(allowed, 30, "write burst = 30");
  eq(rl.write.allow("t-client"), false, "write denied after burst");
});

Deno.test("rate limits: read bucket independent", () => {
  const rl = new NodeRateLimits();
  for (let i = 0; i < 30; i++) rl.write.allow("t2");
  eq(rl.write.allow("t2"), false, "write exhausted");
  eq(rl.read.allow("t2"), true, "read still allowed");
});

Deno.test({
  name: "projection: outbound follows + remote authors + provenance + labels",
  fn: async () => {
    const kv = await Deno.openKv(":memory:");
    const net = new NetworkProjection(kv);
    await net.putSemanticObject({
      id: "obj1", type: "topic", name: "T", description: "",
      tags: [], createdBy: "peanutoshi", created: new Date().toISOString(),
    });
    eq((await net.getSemanticObject("obj1"))?.createdBy, "peanutoshi", "object provenance round-trip");
    await net.putSemanticLink({
      id: "lnk1", fromId: "obj1", toId: "obj1", relation: "part-of",
      weight: 5, createdBy: "__admin__", created: new Date().toISOString(),
    });
    eq((await net.getSemanticLink("lnk1"))?.createdBy, "__admin__", "link provenance round-trip");

    const actors: ActorRecord[] = [{
      identifier: "peanutoshi", name: "Peanutoshi", actorClass: "agent",
      created: new Date().toISOString(),
    } as ActorRecord];
    const posts: PostRecord[] = [{
      id: "https://mastodon.social/users/gargron/statuses/1",
      identifier: "https://mastodon.social/users/gargron",
      content: "remote", published: new Date().toISOString(),
      visibility: "public", form: "short", isRemote: true,
    } as PostRecord];
    const graph = await net.build(
      actors,
      posts,
      async () => [],
      async () => [{
        identifier: "peanutoshi",
        targetId: "https://mastodon.social/users/gargron",
      }],
    );
    const remoteNode = graph.nodes.find((n) => n.id === "actor:gargron@mastodon.social");
    ok(remoteNode != null, "remote author node exists");
    eq(remoteNode!.subkind, "remote", "remote node subkind");
    const followEdge = graph.edges.find((e) =>
      e.from === "actor:peanutoshi" && e.kind === "follows");
    ok(followEdge != null, "outbound follow edge exists");
    eq(followEdge!.to, "actor:gargron@mastodon.social", "follow target");
    const relEdge = graph.edges.find((e) => e.label === "part-of");
    ok(relEdge != null, "semantic edge keeps original relation label");
    kv.close();
  },
  permissions: { read: true, write: true, env: false, net: false },
});
