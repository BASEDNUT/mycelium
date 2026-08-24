// TDD: v0.19.0 — llms.txt endpoint + docs routes + anon filter wiring.
import { llmsTxt } from "../llms_txt.ts";

function ok(cond: unknown, msg: string): void {
  if (!cond) throw new Error("FAIL: " + msg);
}

Deno.test("v019: llms.txt contains sitemap + api + rules", () => {
  const t = llmsTxt("https://test.example", "0.19.0");
  ok(t.includes("# https://test.example"), "title");
  ok(t.includes("[skill.md](/skill.md)"), "skill.md link");
  ok(t.includes("[About](/docs/about)"), "about link");
  ok(t.includes("mycelium/0.19.0"), "version");
  ok(t.includes("Anonymous posting: board roots only"), "anon rules");
});
