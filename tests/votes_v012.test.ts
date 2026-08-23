// v0.12.0 tests: votes primitive + board retention sweeper + ranking.
// Design: docs/subroots-identity-v1.md (mycelium-native, /r/ slugs).
import {
  MyceliumStore,
  type SubrootRecord,
  type PostRecord,
} from "../store.ts";
import { validateSubroot } from "../api.ts";
import { wilsonScore, hotScore } from "../ranking.ts";

function ok(cond: unknown, msg: string): void {
  if (!cond) throw new Error("FAIL: " + msg);
}

async function memStore(): Promise<MyceliumStore> {
  const kv = await Deno.openKv(":memory:");
  return new MyceliumStore(kv);
}

function board(slug = "board"): SubrootRecord {
  return {
    slug,
    archetype: "board",
    title: "Board",
    description: "anon board",
    config: { votes: true, anonymous: true, retentionDays: 7 },
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
    config: { votes: true, anonymous: false, retentionDays: null },
    creator: "__instance__",
    created: new Date().toISOString(),
  };
}

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

Deno.test("votes: put/get/list/delete roundtrip", async () => {
  const s = await memStore();
  await s.putVote({ postId: "p1", actorId: "bot", value: 1, voted: new Date().toISOString() });
  ok((await s.getVote("p1", "bot"))?.value === 1, "upvote stored");
  await s.putVote({ postId: "p1", actorId: "pea", value: -1, voted: new Date().toISOString() });
  const vs = await s.listVotes("p1");
  ok(vs.length === 2, "two votes listed");
  await s.deleteVote("p1", "bot");
  ok((await s.listVotes("p1")).length === 1, "vote deleted");
});

Deno.test("votes: re-vote same value overwrites (one vote per actor per post)", async () => {
  const s = await memStore();
  await s.putVote({ postId: "p1", actorId: "bot", value: 1, voted: "t1" });
  await s.putVote({ postId: "p1", actorId: "bot", value: -1, voted: "t2" });
  const vs = await s.listVotes("p1");
  ok(vs.length === 1 && vs[0].value === -1, "same-key set overwrites");
});

Deno.test("sweeper: deletes expired board posts, keeps fresh + forum + legacy", async () => {
  const s = await memStore();
  await s.putSubroot(board());
  await s.putSubroot(forum());
  const now = new Date();
  const old = new Date(now.getTime() - 8 * 86_400_000).toISOString();
  const fresh = new Date(now.getTime() - 1 * 86_400_000).toISOString();
  await putPost(s, "old-board", old, "board");
  await putPost(s, "fresh-board", fresh, "board");
  await putPost(s, "old-forum", old, "basednut");
  await putPost(s, "legacy", old);
  const n = await s.sweepExpiredPosts(now);
  ok(n === 1, "exactly one post swept, got " + n);
  ok(await s.getPost("old-board") == null, "expired board post deleted");
  ok(await s.getPost("fresh-board") != null, "fresh board post kept");
  ok(await s.getPost("old-forum") != null, "forum post immune");
  ok(await s.getPost("legacy") != null, "legacy post immune");
});

Deno.test("sweeper: cascades votes away with post", async () => {
  const s = await memStore();
  await s.putSubroot(board());
  const old = new Date(Date.now() - 9 * 86_400_000).toISOString();
  await putPost(s, "gone", old, "board");
  await s.putVote({ postId: "gone", actorId: "bot", value: 1, voted: "t" });
  await s.sweepExpiredPosts();
  ok(await s.getPost("gone") == null, "post deleted");
  ok((await s.listVotes("gone")).length === 0, "votes cascaded");
});

Deno.test("wilsonScore: zero votes = 0; clean beats contested", () => {
  ok(wilsonScore(0, 0) === 0, "no votes -> 0");
  ok(wilsonScore(10, 0) > wilsonScore(10, 9), "clean beats contested");
  ok(wilsonScore(100, 1) > wilsonScore(1, 0), "volume beats 1-vote certainty");
});

Deno.test("hotScore: decays with age", () => {
  ok(hotScore(10, 0, 0) > hotScore(10, 0, 24), "fresh beats day-old");
  ok(hotScore(10, 0, 0) > hotScore(0, 0, 0), "positive score beats zero votes");
  ok(hotScore(0, 10, 0) < hotScore(0, 0, 0), "negative score sinks below zero");
});

Deno.test("validateSubroot: /r/ style slugs validate", () => {
  const r = validateSubroot({
    slug: "basednut",
    archetype: "forum",
    title: "x",
    description: "",
    config: { votes: true, anonymous: false, retentionDays: null },
  });
  ok(r.valid, "slug validates");
  ok(r.valid === true && r.record?.slug === "basednut", "record carries slug");
});
