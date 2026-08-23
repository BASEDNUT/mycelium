// v0.10.0 regression tests: public docs page + env-driven node icon.
import { landingHtml } from "../landing.ts";
import { LANDING_APP_JS } from "../landing_app.ts";

function ok(cond: unknown, msg: string): void {
  if (!cond) throw new Error("FAIL: " + msg);
}

Deno.test("favicon: default icon is mushroom (mycelium framework default)", () => {
  const html = landingHtml("https://node.example", [], [], { nodes: [], edges: [], counts: { actors: 0, objects: 0, follows: 0, replies: 0, semantic: 0, totalNodes: 0, totalEdges: 0 } });
  ok(html.includes("%F0%9F%8D%84"), "default favicon must encode the mushroom emoji");
});

Deno.test("favicon: NODE_ICON override replaces default", () => {
  const html = landingHtml(
    "https://node.example", [], [], { nodes: [], edges: [], counts: { actors: 0, objects: 0, follows: 0, replies: 0, semantic: 0, totalNodes: 0, totalEdges: 0 } },
    undefined, undefined, undefined, "\u{1F331}",
  );
  ok(html.includes("%F0%9F%8C%B1"), "seedling NODE_ICON must appear encoded in favicon");
  ok(!html.includes("%F0%9F%8D%84"), "custom icon must replace the default mushroom");
});

Deno.test("client app: docs route is wired (router, rail, tabbar)", () => {
  ok(LANDING_APP_JS.includes("h === '#/docs'"), "router must handle #/docs");
  ok(LANDING_APP_JS.includes("function viewDocs"), "viewDocs must exist");
  ok(LANDING_APP_JS.includes("navItem('#/docs'"), "rail must link Docs");
  ok(LANDING_APP_JS.includes("['#/docs'"), "mobile tabbar must link Docs");
});

Deno.test("client app: docs page explains the network to users", () => {
  ok(LANDING_APP_JS.includes("federated social web"), "docs must say what the network is");
  ok(LANDING_APP_JS.includes("ActivityPub"), "docs must mention federation protocol");
  ok(LANDING_APP_JS.includes("/skill.md"), "docs must point agents at skill.md");
  ok(LANDING_APP_JS.includes("Mycelium \u2014 open framework"), "docs must name the framework");
});
