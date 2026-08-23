// v0.11.0 tests: subroot primitive (store + validation + API wiring).
// Design: docs/subroots-identity-v1.md + docs/native-split-v1.md (mycelium-native).
import {
  MyceliumStore,
  type SubrootRecord,
} from "../store.ts";
import { validateSubroot } from "../api.ts";

function ok(cond: unknown, msg: string): void {
  if (!cond) throw new Error("FAIL: " + msg);
}

async function memStore(): Promise<MyceliumStore> {
  const kv = await Deno.openKv(":memory:");
  return new MyceliumStore(kv);
}

function sampleSubroot(slug = "basednut"): SubrootRecord {
  return {
    slug,
    archetype: "forum",
    title: "BASED NUT",
    description: "seeded community subroot",
    config: { votes: true, anonymous: false, retentionDays: null },
    creator: "peanutoshi",
    created: new Date().toISOString(),
  };
}

Deno.test("validateSubroot: accepts valid archetypes with sane config", () => {
  const r = validateSubroot({
    slug: "basednut",
    archetype: "forum",
    title: "BASED NUT",
    description: "home of the orchard",
    config: { votes: true, anonymous: false, retentionDays: null },
  });
  ok(r.valid, "forum subroot must validate");
  ok(r.valid === true && r.record != null, "valid input must produce a record");
});

Deno.test("validateSubroot: rejects bad slug", () => {
  const bad = validateSubroot({
    slug: "Bad Slug!",
    archetype: "forum",
    title: "x",
    description: "",
    config: { votes: true, anonymous: false, retentionDays: null },
  });
  ok(!bad.valid, "invalid slug must be rejected");
});

Deno.test("validateSubroot: rejects unknown archetype", () => {
  const bad = validateSubroot({
    slug: "okslug",
    archetype: "chatroom",
    title: "x",
    description: "",
    config: { votes: true, anonymous: false, retentionDays: null },
  });
  ok(!bad.valid, "unknown archetype must be rejected");
});

Deno.test("validateSubroot: board requires positive retention, others reject retention", () => {
  const boardNoRet = validateSubroot({
    slug: "b",
    archetype: "board",
    title: "x",
    description: "",
    config: { votes: true, anonymous: true, retentionDays: null },
  });
  ok(!boardNoRet.valid, "board without retention must be rejected");
  const boardOk = validateSubroot({
    slug: "b",
    archetype: "board",
    title: "x",
    description: "",
    config: { votes: true, anonymous: true, retentionDays: 7 },
  });
  ok(boardOk.valid, "board with retention must pass");
  const forumRet = validateSubroot({
    slug: "f",
    archetype: "forum",
    title: "x",
    description: "",
    config: { votes: true, anonymous: false, retentionDays: 7 },
  });
  ok(!forumRet.valid, "non-board with retention must be rejected");
});

Deno.test("validateSubroot: meta requires anonymous=false", () => {
  const bad = validateSubroot({
    slug: "m",
    archetype: "meta",
    title: "x",
    description: "",
    config: { votes: false, anonymous: true, retentionDays: null },
  });
  ok(!bad.valid, "meta must not allow anonymous");
});

Deno.test("store: subroot put/get/list/delete roundtrip", async () => {
  const store = await memStore();
  ok(await store.getSubroot("basednut") == null, "absent subroot must be null");
  const rec = sampleSubroot();
  await store.putSubroot(rec);
  const got = await store.getSubroot("basednut");
  ok(got != null, "stored subroot must be retrievable");
  ok(got!.slug === "basednut", "slug must roundtrip");
  ok(got!.archetype === "forum", "archetype must roundtrip");
  ok(got!.config.votes === true, "config must roundtrip");
  await store.putSubroot({ ...sampleSubroot("crypto"), archetype: "feed" });
  await store.putSubroot(sampleSubroot("board1"));
  const all = await store.listSubroots();
  ok(all.length === 3, "list must return all subroots, got " + all.length);
  await store.deleteSubroot("board1");
  ok(await store.getSubroot("board1") == null, "deleted subroot must vanish");
  ok((await store.listSubroots()).length === 2, "list after delete");
});

Deno.test("store: post can bind to a subroot (optional, backwards compatible)", async () => {
  const store = await memStore();
  await store.putPost({
    id: "p1",
    identifier: "peanutoshi",
    content: "hello orchard",
    published: new Date().toISOString(),
    visibility: "public",
    form: "short",
    subroot: "basednut",
  });
  const p = await store.getPost("p1");
  ok(p?.subroot === "basednut", "subroot binding must roundtrip");
  await store.putPost({
    id: "p2",
    identifier: "peanutoshi",
    content: "legacy post",
    published: new Date().toISOString(),
    visibility: "public",
    form: "short",
  });
  const legacy = await store.getPost("p2");
  ok(legacy?.subroot == null, "legacy posts must remain valid without subroot");
  const inSub = await store.listPosts(null, "basednut");
  ok(inSub.length === 1, "subroot-filtered list must find only p1");
});

Deno.test("api source wiring: subroot endpoints + validation exported", async () => {
  const src = await Deno.readTextFile(new URL("../api.ts", import.meta.url));
  ok(src.includes('"/api/subroots"'), "GET /api/subroots must be wired");
  ok(src.includes('"/api/subroot"'), "POST /api/subroot must be wired");
  ok(src.includes("admin token required"), "subroot creation must be admin-gated");
  const storeSrc = await Deno.readTextFile(new URL("../store.ts", import.meta.url));
  ok(storeSrc.includes("SubrootArchetype"), "archetype type must exist in store");
});
