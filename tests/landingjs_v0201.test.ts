// TDD red-first: regression guard for the blank-page bug class (v0.16,
// v0.20.0). The client app is emitted as an inline <script> built from a TS
// template literal. Escape sequences in that literal collapse when TS
// evaluates it: \/ becomes /, so a regex like /^https?:\/\// is emitted as
// /^https?:\/\/\/ whose trailing // parses as a line comment and breaks the
// whole script at parse time. Parse-validate the emitted payload here so
// this class of bug can never ship again.
import { LANDING_APP_JS } from "../landing_app.ts";

function ok(cond: unknown, msg: string): void {
  if (!cond) throw new Error("FAIL: " + msg);
}

Deno.test("landing client JS parses as valid JavaScript", () => {
  ok(typeof LANDING_APP_JS === "string", "LANDING_APP_JS should be a string");
  ok(LANDING_APP_JS.length > 1000, "LANDING_APP_JS should be a substantial payload");
  // Compile without executing: throws SyntaxError on corrupted escapes.
  new Function(LANDING_APP_JS);
});

Deno.test("landing client JS has no collapsed regex-comment corruption", () => {
  ok(
    !LANDING_APP_JS.includes("https?:///"),
    "regex escape collapsed: https?:/// present in emitted JS",
  );
});
