// v0.9.0 audit-fix regression tests.
// CRITICAL: embedJson <script> escape · HIGH: legacy delete admin-only ·
// HIGH: master.key fail-closed regeneration.
import { embedJson } from "../landing.ts";
import { canDelete } from "../network_api.ts";
import { KeyEnvelope } from "../crypto.ts";

function ok(cond: unknown, msg: string): void {
  if (!cond) throw new Error("FAIL: " + msg);
}

Deno.test("embedJson: < must be emitted as literal six-char \\u003c, never raw <", () => {
  const hostile = { detail: "</script><script>alert(1)</script>" };
  const out = embedJson(hostile);
  ok(!out.includes("<"), "raw < leaked into JSON embed");
  ok(out.includes("\\u003c"), "escape sequence missing");
  // and it must still round-trip as JSON
  const back = JSON.parse(out.replace(/\\u003c/g, "<"));
  ok(back.detail === hostile.detail, "round-trip corrupted content");
});

Deno.test("canDelete: legacy provenance-less rows are admin-only", () => {
  ok(canDelete("__admin__", null), "admin must always delete");
  ok(canDelete("__admin__", "someone"), "admin overrides creator");
  ok(canDelete("alice", "alice"), "creator may delete own");
  ok(!canDelete("alice", "bob"), "non-creator may not delete");
  ok(!canDelete("alice", null), "LEGACY: createdBy==null must NOT be deletable by actor");
  ok(!canDelete("alice", undefined), "undefined createdBy must NOT be deletable by actor");
});

Deno.test("KeyEnvelope: refuses silent regeneration when encrypted keys exist", async () => {
  const env = new KeyEnvelope();
  const path = await Deno.makeTempFile();
  try {
    await Deno.writeTextFile(path, "garbage-not-hex\n"); // invalid key
    let threw = false;
    try {
      await env.loadOrGenerate(path, async () => true); // encrypted keys exist
    } catch {
      threw = true;
    }
    ok(threw, "must throw instead of regenerating over encrypted datastore");
    // fresh node (no encrypted keys) still generates
    const env2 = new KeyEnvelope();
    await env2.loadOrGenerate(path, async () => false);
    ok(env2.available, "fresh node must still generate a master key");
  } finally {
    await Deno.remove(path);
  }
});
