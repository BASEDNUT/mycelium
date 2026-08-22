// v0.9.1 audit-fix regression tests.
// P1: Like to remote author + Undo · inbox interaction validation ·
// followers/following collections · framework-neutral branding.
import { likeActivityId } from "../api.ts";
import { buildActorDoc } from "../actors.ts";
import type { ActorRecord } from "../store.ts";
import { landingHtml } from "../landing.ts";

function ok(cond: unknown, msg: string): void {
  if (!cond) throw new Error("FAIL: " + msg);
}

Deno.test("likeActivityId: deterministic and stable across calls", () => {
  const a = likeActivityId("https://node.example", "alice", "like", "p1");
  const b = likeActivityId("https://node.example", "alice", "like", "p1");
  ok(a.href === b.href, "activity id must be deterministic for Undo");
  ok(
    a.href === "https://node.example/ap/actor/alice/like/p1",
    "unexpected id shape: " + a.href,
  );
  const boost = likeActivityId("https://node.example", "alice", "boost", "p1");
  ok(boost.href !== a.href, "kind must be part of the id namespace");
});

Deno.test("buildActorDoc: followers/following included when ctx provides them", () => {
  const rec: ActorRecord = {
    identifier: "alice",
    actorClass: "person",
    name: "Alice",
    summary: "",
    created: new Date().toISOString(),
    discoverable: true,
  };
  const base = {
    getActorUri: (id: string) => new URL("https://n/ap/actor/" + id),
    getInboxUri: (id?: string) =>
      new URL("https://n/ap/actor/" + (id ?? "shared") + "/inbox"),
    getOutboxUri: (id: string) => new URL("https://n/ap/actor/" + id + "/outbox"),
  };
  const without = buildActorDoc(rec, base, []);
  ok(without.followersId == null, "no followers URI without ctx hook");
  const withHooks = buildActorDoc(rec, {
    ...base,
    getFollowersUri: (id: string) => new URL("https://n/ap/actor/" + id + "/followers"),
    getFollowingUri: (id: string) => new URL("https://n/ap/actor/" + id + "/following"),
  }, []);
  ok(
    withHooks.followersId?.href === "https://n/ap/actor/alice/followers",
    "followers collection missing from actor doc");
  ok(
    withHooks.followingId?.href === "https://n/ap/actor/alice/following",
    "following collection missing from actor doc");
});

Deno.test("landingHtml: branding is env-driven, no hardcoded node identity", () => {
  const graph = { nodes: [], edges: [], counts: { actors: 0, objects: 0, follows: 0, replies: 0, totalNodes: 0, totalEdges: 0 } } as never;
  const branded = landingHtml("https://tap.example", [], [], graph, undefined, "TAPROOT", "BASEDNUT");
  ok(branded.includes(">TAPROOT<"), "NODE_TITLE must render as wordmark");
  ok(branded.includes("by BASEDNUT"), "NODE_CREDIT must render");
  const neutral = landingHtml("https://any.example", [], [], graph, undefined, undefined, undefined);
  ok(!neutral.includes("by BASEDNUT"), "no credit line when env unset");
  ok(neutral.includes("any.example"), "neutral title falls back to host");
  ok(!neutral.toLowerCase().includes("taproot"), "no hardcoded TAPROOT in framework");
});
