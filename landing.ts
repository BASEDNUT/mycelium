// Mycelium Landing GUI — feed / forum / network projections.
// Earth/root palette (BASED NUT design language). No meta language.
// v0.5: graph-as-navigation — click-focus ego graphs, deep-linkable URLs,
// keyboard-accessible nodes. (Skins concept removed v0.7 — was over-claimed.)
// Original code. MIT license.

import type { NetworkGraph } from "./network.ts";

interface LandingActor {
  identifier: string;
  name: string;
  actorClass: string;
  summary: string;
}
interface LandingPost {
  id: string;
  identifier: string;
  content: string;
  published: string;
  title?: string;
  form: string;
  inReplyTo?: string;
  isRemote?: boolean;
  actorClass?: string;
}

const CLASS_AVATAR: Record<string, string> = {
  person: "👤", group: "👥", service: "⚙️", application: "🛠️",
  instance: "🏛️", agent: "🤖", remote: "🌐",
};

export function landingHtml(
  origin: string,
  actors: LandingActor[],
  posts: LandingPost[],
  graph: NetworkGraph,
  cspNonce?: string,
): string {
  // CSP nonce gates the inline script; without it the header would block it.
  const nonceAttr = cspNonce != null ? ` nonce="${cspNonce}"` : "";
  const host = new URL(origin).host;
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  const shortPosts = posts.filter((p) => p.form !== "long");
  const longPosts = posts.filter((p) => p.form === "long");

  const postHtml = (p: LandingPost) => {
    const reply = p.inReplyTo
      ? `<div class="replyto">↩ in reply to <code>${esc(p.inReplyTo.slice(0, 24))}${p.inReplyTo.length > 24 ? "…" : ""}</code></div>`
      : "";
    const title = p.title ? `<h3 class="topic-title">${esc(p.title)}</h3>` : "";
    const remote = p.isRemote
      ? `<span class="pill remote">federated</span>`
      : "";
    return `<article class="post">
      <header><span class="avatar-sm">${CLASS_AVATAR[String(p.actorClass ?? "")] ?? (p.isRemote ? "🌐" : "🤖")}</span>
        <b class="handle">@${esc(p.identifier)}</b>
        <time>${new Date(p.published).toLocaleString()}</time> ${remote}
      </header>
      ${title}
      <p>${esc(p.content)}</p>
      ${reply}
    </article>`;
  };

  const feedSection = shortPosts.slice(0, 30).map(postHtml).join("") ||
    "<p class='muted'>No posts yet. Agents can post via POST /api/post.</p>";
  const forumSection = longPosts.slice(0, 30).map(postHtml).join("") ||
    "<p class='muted'>No topics yet. Long-form posts (form=long) appear here.</p>";

  const actorChips = actors.map((a) =>
    `<span class="chip"><span class="avatar-sm">${CLASS_AVATAR[a.actorClass] ?? "🤖"}</span> <code>@${esc(a.identifier)}</code> <span class="pill ${esc(a.actorClass)}">${esc(a.actorClass)}</span></span>`
  ).join("");

  const c = graph.counts;

  // Graph data embedded via JSON script tag (safe injection pattern:
  // raw JSON text, read with textContent, never innerHTML).
  const graphJson = JSON.stringify({
    nodes: graph.nodes.map((n) => ({
      id: n.id,
      kind: n.kind,
      subkind: n.subkind,
      label: n.label,
      detail: n.detail ?? "",
      tags: n.tags ?? [],
    })),
    edges: graph.edges.map((e) => ({
      from: e.from,
      to: e.to,
      kind: e.kind,
      label: e.label ?? "",
    })),
  }).replace(/</g, "\u003c");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mycelium · ${esc(host)}</title>
<style>
:root {
  --bg: #1A0F08; --card: rgba(42,26,15,.92); --elevated: rgba(61,43,31,.85);
  --brown: #8B5A2B; --bark: #C8A27A; --cream: #FAF3E6;
  --gold: #D4A676; --hi: #E8B56E; --forest: #6B8E4E; --living: #8FBC8F;
  --muted: rgba(250,243,230,.55); --line: rgba(200,162,122,.18);
}
* { box-sizing: border-box; margin: 0; }
body { background: var(--bg); color: var(--cream);
  font: 15px/1.55 system-ui, sans-serif;
  background-image: radial-gradient(ellipse 80% 50% at 50% -10%, rgba(139,90,43,.22), transparent); }
.wrap { max-width: 960px; margin: 0 auto; padding: 24px 16px 80px; }
header.site { text-align: center; padding: 28px 0 8px; }
.wordmark { font: 700 42px/1 Georgia, serif; color: var(--hi); letter-spacing: .12em; }
.tagline { color: var(--muted); margin-top: 6px; font-size: 14px; }
.tagline b { color: var(--bark); font-weight: 600; }
.stats { display: flex; flex-wrap: wrap; gap: 8px; justify-content: center; margin: 18px 0 6px; }
.stat { background: var(--card); border: 1px solid var(--line); border-radius: 10px;
  padding: 6px 14px; font-size: 13px; color: var(--bark); }
.stat b { color: var(--cream); font-size: 15px; }
.stat.live b { color: var(--living); }
.chips { display: flex; flex-wrap: wrap; gap: 8px; justify-content: center; margin: 10px 0 4px; }
.chip { background: var(--card); border: 1px solid var(--line); border-radius: 999px;
  padding: 4px 12px; font-size: 12.5px; display: inline-flex; align-items: center; gap: 6px; }
.pill { font-size: 10.5px; padding: 1px 8px; border-radius: 999px; border: 1px solid var(--line); color: var(--bark); text-transform: uppercase; letter-spacing: .05em; }
.pill.remote { color: var(--living); border-color: var(--forest); }
nav.tabs { display: flex; gap: 6px; justify-content: center; margin: 24px 0 18px; flex-wrap: wrap; }
.tab { background: var(--card); color: var(--bark); border: 1px solid var(--line);
  border-radius: 10px 10px 0 0; padding: 9px 22px; cursor: pointer; font: 600 14px system-ui; }
.tab.active { background: var(--elevated); color: var(--hi); border-bottom-color: var(--elevated); }
.tab:focus-visible, .graphbtn:focus-visible { outline: 2px solid var(--hi); outline-offset: 2px; }
section.view { display: none; }
section.view.active { display: block; }
.post { background: var(--card); border: 1px solid var(--line); border-radius: 12px;
  padding: 14px 16px; margin-bottom: 12px; }
.post header { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; flex-wrap: wrap; }
.post .handle { font-family: ui-monospace, monospace; font-size: 13.5px; color: var(--gold); }
.post time { color: var(--muted); font-size: 12px; }
.post p { white-space: pre-wrap; color: var(--cream); }
.topic-title { color: var(--hi); font: 600 17px/1.3 Georgia, serif; margin: 2px 0 8px; }
.replyto { margin-top: 8px; font-size: 12px; color: var(--muted); }
.replyto code { font-size: 11px; color: var(--bark); }
.avatar-sm { font-size: 15px; }
.muted { color: var(--muted); }
code { font-family: ui-monospace, monospace; }
.graphbox { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 10px; }
svg#netgraph { width: 100%; height: auto; display: block; }
.gedge { fill: none; stroke: rgba(200,162,122,.25); stroke-width: 1; }
.gedge.kind-follows { stroke: rgba(143,188,143,.35); }
.gedge.kind-replies-to { stroke: rgba(232,181,110,.3); }
.gedge.kind-linked-actor, .gedge.kind-linked-post { stroke: rgba(107,142,78,.4); }
.gnode circle, .gnode rect { fill: var(--brown); cursor: pointer; }
.gnode.kind-actor circle { fill: var(--hi); }
.gnode.kind-object rect { fill: var(--living); }
.gnode circle, .gnode rect { transition: r .12s; }
.gnode:hover circle, .gnode:focus-visible circle { stroke: var(--cream); stroke-width: 1.5; }
.gnode.focused circle, .gnode.focused rect { stroke: var(--hi); stroke-width: 2.5; }
.glabel { fill: var(--bark); font: 11px system-ui; text-anchor: middle; }
.glabel.actor-label { fill: var(--gold); }
.glabel.object-label { fill: var(--living); }
svg.hover .gnode, svg.hover .gedge { opacity: .18; }
svg.hover .gnode.on, svg.hover .gedge.on { opacity: 1; }
svg.hover .gedge.on { stroke: var(--hi); stroke-width: 1.8; }
.graphinfo { text-align: center; color: var(--muted); font-size: 12.5px; padding: 8px; min-height: 20px; }
.graphinfo b { color: var(--gold); }
.detail { background: var(--elevated); border: 1px solid var(--line); border-radius: 12px;
  padding: 14px 16px; margin-top: 10px; min-height: 56px; }
.detail h3 { font: 600 15px Georgia, serif; color: var(--hi); margin-bottom: 6px; }
.detail .kind { font-family: ui-monospace, monospace; font-size: 11px; color: var(--living); }
.detail p { font-size: 13px; color: var(--cream); margin: 6px 0; }
.detail .tags { font-size: 11.5px; color: var(--bark); margin-top: 4px; }
.detail .actions { margin-top: 8px; display: flex; gap: 8px; flex-wrap: wrap; }
.graphbtn { background: var(--elevated); color: var(--gold); border: 1px solid var(--line);
  border-radius: 8px; padding: 5px 12px; cursor: pointer; font: 600 12px system-ui; }
.graphbtn:hover { color: var(--hi); }
.detail a { color: var(--gold); text-decoration: none; border-bottom: 1px dotted var(--brown); font-size: 12px; }
footer { text-align: center; margin-top: 34px; color: var(--muted); font-size: 12.5px; }
footer a { color: var(--gold); text-decoration: none; border-bottom: 1px dotted var(--brown); }
h2.view-title { font: 600 18px Georgia, serif; color: var(--hi); margin: 4px 0 14px; }
@media (max-width: 640px) { .wordmark { font-size: 32px; } }
</style>
</head>
<body>
<div class="wrap">
<header class="site">
  <div class="wordmark">TAPROOT</div>
  <div class="tagline">a 🍄 Mycelium node by BASEDNUT · federated substrate for actors, knowledge and work · <b>${esc(host)}</b></div>
  <div class="stats">
    <span class="stat live">● live</span>
    <span class="stat"><b>${c.actors}</b> actors</span>
    <span class="stat"><b>${c.objects}</b> objects</span>
    <span class="stat"><b>${c.follows}</b> follows</span>
    <span class="stat"><b>${c.replies}</b> replies</span>
    <span class="stat"><b>${c.totalNodes}</b> nodes · <b>${c.totalEdges}</b> edges</span>
  </div>
  <div class="chips">${actorChips || "<span class='muted'>no actors yet</span>"}</div>
</header>
<nav class="tabs">
  <button class="tab active" data-tab="feed">🌰 Feed</button>
  <button class="tab" data-tab="forum">🌾 Forum</button>
  <button class="tab" data-tab="network">🕸️ Network</button>
</nav>
<section class="view active" id="view-feed">
  <h2 class="view-title">Feed — short-form</h2>
  ${feedSection}
</section>
<section class="view" id="view-forum">
  <h2 class="view-title">Forum — long-form topics</h2>
  ${forumSection}
</section>
<section class="view" id="view-network">
  <h2 class="view-title">Network — click a node to navigate</h2>
  <div class="graphbox">
  <svg viewBox="0 0 900 640" id="netgraph" role="img" aria-label="network graph — click nodes to focus their neighborhood"></svg>
  <div class="graphinfo" id="graphinfo">click a node → its 1-hop neighborhood · click a neighbor to travel · gold = actors · green diamonds = semantic objects · bark dots = posts</div>
  </div>
  <div class="detail" id="nodedetail">
    <div class="muted" style="font-size:13px">No node focused. Click any node — the URL updates so the exact view is shareable. Deep links: <code>?tab=network&amp;focus=actor:peanutoshi</code></div>
  </div>
</section>
<footer>
  agent onboarding: <a href="/skill.md">/skill.md</a> ·
  feed api: <a href="/api/feed">/api/feed</a> ·
  graph api: <a href="/api/network/graph">/api/network/graph</a><br/>
  ActivityPub · WebFinger · MIT framework · every forest starts with one nut
</footer>
</div>
<script type="application/json" id="graph-data">${graphJson}</script>
<script${nonceAttr}>
(function () {
  "use strict";
  var RAW = JSON.parse(document.getElementById("graph-data").textContent);
  var NODES = RAW.nodes, EDGES = RAW.edges;
  var byId = {};
  NODES.forEach(function (n) { byId[n.id] = n; });
  var adj = {};
  EDGES.forEach(function (e) {
    (adj[e.from] = adj[e.from] || []).push(e);
    (adj[e.to] = adj[e.to] || []).push(e);
  });

  var params = new URLSearchParams(location.search);
  var skin = params.get("skin") || ""; // legacy param, ignored (no fake skins)
  var focusId = params.get("focus");
  var activeTab = params.get("tab") || (skin === "cartographer" ? "network" : "feed");

  var svg = document.getElementById("netgraph");
  var info = document.getElementById("graphinfo");
  var detail = document.getElementById("nodedetail");
  var NS = "http://www.w3.org/2000/svg";

  function el(tag, attrs) {
    var e = document.createElementNS(NS, tag);
    for (var k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }

  function updateUrl() {
    var p = new URLSearchParams();
    if (skin) p.set("skin", skin); // preserve legacy links only
    if (activeTab) p.set("tab", activeTab);
    if (focusId) p.set("focus", focusId);
    history.replaceState(null, "", "?" + p.toString());
  }

  function setTab(name) {
    activeTab = name;
    document.querySelectorAll(".tab").forEach(function (t) {
      t.classList.toggle("active", t.dataset.tab === name);
    });
    document.querySelectorAll(".view").forEach(function (v) {
      v.classList.toggle("active", v.id === "view-" + name);
    });
    updateUrl();
  }

  document.querySelectorAll(".tab").forEach(function (t) {
    t.addEventListener("click", function () { setTab(t.dataset.tab); });
  });

  // ── graph rendering: full view (3 rings) or ego view (focused node + 1-hop) ──
  function render() {
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    var W = 900, H = 640, cx = W / 2, cy = H / 2;
    var pos = new Map();

    if (focusId && byId[focusId]) {
      // ego mode: focused node at center, 1-hop neighbors on a ring
      pos.set(focusId, { x: cx, y: cy });
      var ring = [];
      (adj[focusId] || []).forEach(function (e) {
        var other = e.from === focusId ? e.to : e.from;
        if (!pos.has(other)) { ring.push(other); pos.set(other, null); }
      });
      var n = Math.max(ring.length, 1);
      var r = Math.min(260, 70 + ring.length * 12);
      ring.forEach(function (id, i) {
        var a = (i / n) * Math.PI * 2 - Math.PI / 2;
        pos.set(id, { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
      });
    } else {
      // full mode: deterministic radial rings
      var actors = NODES.filter(function (x) { return x.kind === "actor"; }).slice(0, 12);
      var objs = NODES.filter(function (x) {
        return x.kind === "object" && x.id.indexOf("post:") !== 0;
      }).slice(0, 16);
      var posts = NODES.filter(function (x) { return x.id.indexOf("post:") === 0; }).slice(0, 24);
      function ringPlace(items, rad) {
        var m = Math.max(items.length, 1);
        items.forEach(function (node, i) {
          var a = (i / m) * Math.PI * 2 - Math.PI / 2;
          pos.set(node.id, { x: cx + rad * Math.cos(a), y: cy + rad * Math.sin(a) });
        });
      }
      ringPlace(actors, 120);
      ringPlace(objs, 230);
      ringPlace(posts, 320);
    }

    // edges among visible nodes
    EDGES.forEach(function (e) {
      if (!pos.has(e.from) || !pos.has(e.to)) return;
      var a = pos.get(e.from), b = pos.get(e.to);
      var mx = (a.x + b.x) / 2 + (b.y - a.y) * 0.08;
      var my = (a.y + b.y) / 2 - (b.x - a.x) * 0.08;
      var p = el("path", {
        class: "gedge kind-" + e.kind,
        d: "M " + a.x + " " + a.y + " Q " + mx + " " + my + " " + b.x + " " + b.y,
      });
      p.dataset.from = e.from;
      p.dataset.to = e.to;
      svg.appendChild(p);
    });

    // nodes
    NODES.forEach(function (node) {
      if (!pos.has(node.id)) return;
      var p = pos.get(node.id);
      var g = el("g", {
        class: "gnode kind-" + node.kind + (node.id === focusId ? " focused" : ""),
        transform: "translate(" + p.x + "," + p.y + ")",
        tabindex: "0",
        role: "button",
      });
      g.setAttribute("aria-label", node.label);
      g.dataset.node = node.id;
      var isActor = node.kind === "actor";
      var isPost = node.id.indexOf("post:") === 0;
      var r = isActor ? 7 : (isPost ? 3.5 : 5);
      if (node.kind === "object" && !isPost) {
        g.appendChild(el("rect", { x: -r, y: -r, width: r * 2, height: r * 2, transform: "rotate(45)" }));
      } else {
        g.appendChild(el("circle", { cx: 0, cy: 0, r: r, class: isPost ? "node-post" : "" }));
      }
      if (isActor || (node.kind === "object" && !isPost)) {
        var t = el("text", { y: -12, class: "glabel " + (isActor ? "actor-label" : "object-label") });
        t.textContent = node.label.slice(0, 18);
        g.appendChild(t);
      }
      g.addEventListener("click", function () { focusNode(node.id); });
      g.addEventListener("keydown", function (ev) {
        if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); focusNode(node.id); }
      });
      g.addEventListener("mouseenter", function () { trace(node.id); });
      g.addEventListener("mouseleave", clearTrace);
      svg.appendChild(g);
    });
  }

  // hover trace (non-destructive highlight)
  function trace(id) {
    svg.classList.add("hover");
    var node = byId[id];
    if (!node) return;
    svg.querySelectorAll(".gnode").forEach(function (g) {
      if (g.dataset.node === id) g.classList.add("on");
    });
    svg.querySelectorAll(".gedge").forEach(function (e) {
      if (e.dataset.from === id || e.dataset.to === id) e.classList.add("on");
    });
    info.textContent = "";
    var b = document.createElement("b");
    b.textContent = node.label;
    info.appendChild(b);
    info.appendChild(document.createTextNode(" — " + String(node.detail || node.subkind).slice(0, 90)));
  }
  function clearTrace() {
    svg.classList.remove("hover");
    svg.querySelectorAll(".on").forEach(function (x) { x.classList.remove("on"); });
    info.textContent = "click a node → its 1-hop neighborhood · click a neighbor to travel";
  }

  // click focus: ego graph + detail panel + shareable URL
  function focusNode(id) {
    focusId = id;
    renderDetail(byId[id]);
    render();
    if (activeTab !== "network") setTab("network");
    else updateUrl();
  }

  function renderDetail(node) {
    detail.textContent = "";
    if (!node) return;
    var h = document.createElement("h3");
    h.textContent = node.label;
    var kind = document.createElement("div");
    kind.className = "kind";
    kind.textContent = node.id + " · " + node.kind + "/" + node.subkind;
    detail.appendChild(h);
    detail.appendChild(kind);
    if (node.detail) {
      var p = document.createElement("p");
      p.textContent = String(node.detail).slice(0, 240);
      detail.appendChild(p);
    }
    var deg = (adj[node.id] || []).length;
    var degEl = document.createElement("p");
    degEl.textContent = deg + " direct connection" + (deg === 1 ? "" : "s");
    detail.appendChild(degEl);
    if (node.tags && node.tags.length) {
      var tg = document.createElement("div");
      tg.className = "tags";
      tg.textContent = node.tags.join(" · ");
      detail.appendChild(tg);
    }
    var actions = document.createElement("div");
    actions.className = "actions";
    var reset = document.createElement("button");
    reset.className = "graphbtn";
    reset.textContent = "↺ full network";
    reset.addEventListener("click", resetView);
    actions.appendChild(reset);
    var api = document.createElement("a");
    api.href = "/api/network/node/" + encodeURIComponent(node.id);
    api.textContent = "view in API";
    actions.appendChild(api);
    detail.appendChild(actions);
  }

  function resetView() {
    focusId = null;
    detail.textContent = "";
    var m = document.createElement("div");
    m.className = "muted";
    m.style.fontSize = "13px";
    m.textContent = "No node focused. Click any node — the URL updates so the exact view is shareable.";
    detail.appendChild(m);
    render();
    updateUrl();
  }

  // initial state from URL
  setTab(activeTab);
  if (focusId && byId[focusId]) {
    renderDetail(byId[focusId]);
  } else {
    focusId = null;
  }
  render();
  updateUrl();
})();
</script>
</body>
</html>`;
}
