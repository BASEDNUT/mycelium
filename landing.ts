// Mycelium Landing GUI v1.0 — explore-first, Twitter/Reddit-legible shell.
// Dark = original taproot earth palette. Light = peanut cream.
// Client app in landing_app.ts (inline, CSP-nonce-gated). All dynamic text
// renders via textContent (DOM-API) — never innerHTML. Original code. MIT.

import type { NetworkGraph } from "./network.ts";
import { LANDING_APP_JS } from "./landing_app.ts";

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

// JSON-in-<script> hardening: "<" is emitted as the literal six characters
// \u003c so hostile content (e.g. a federated post body containing
// "</script>") can never close the embed tag. (audit CRITICAL, v0.9.0 fix)
export function embedJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

const CSS = `
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root,html[data-theme=dark]{
  --bg:#160D07;--panel:#241610;--panel2:#2C1B12;--gold:#E8B56E;--bark:#C8A27A;
  --cream:#FAF3E6;--muted:rgba(250,243,230,.56);--line:rgba(212,166,118,.16);
  --green:#8FBC6F;--danger:#E07856;--shadow:0 10px 30px rgba(0,0,0,.45);
  --inputbg:rgba(250,243,230,.05)
}
html[data-theme=light]{
  --bg:#FAF3E6;--panel:#FFFDF7;--panel2:#F3E9D6;--gold:#A9701F;--bark:#8A6238;
  --cream:#2B1D12;--muted:rgba(43,29,18,.58);--line:rgba(140,100,60,.18);
  --green:#4E7A2E;--danger:#B04A2A;--shadow:0 8px 24px rgba(120,80,40,.14);
  --inputbg:#fff
}
html{scroll-behavior:smooth}
body{background:var(--bg);color:var(--cream);font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;-webkit-font-smoothing:antialiased;min-height:100vh}
h1,h2,h3,.wordmark,.vtitle{font-family:Georgia,serif;font-weight:600;letter-spacing:.2px}
a{color:var(--gold);text-decoration:none}
button{font:inherit;color:inherit;background:none;border:0;cursor:pointer}

/* shell */
.app{display:flex;flex-direction:column;min-height:100vh}
.topbar{position:sticky;top:0;z-index:40;display:flex;align-items:center;gap:12px;padding:10px 16px;background:color-mix(in srgb,var(--bg) 88%,transparent);backdrop-filter:blur(10px);border-bottom:1px solid var(--line)}
.wordmark{font-size:21px;color:var(--gold);white-space:nowrap}
.livepill{font-size:12px;color:var(--green);border:1px solid var(--line);padding:2px 9px;border-radius:99px;white-space:nowrap}
.search{flex:1;max-width:460px;margin:0 auto;background:var(--inputbg);border:1px solid var(--line);border-radius:99px;padding:7px 16px;color:var(--cream);font-size:14px;outline:none}
.search:focus{border-color:var(--gold)}
.topright{display:flex;align-items:center;gap:8px;margin-left:auto}
.iconbtn{display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;border-radius:10px;border:1px solid var(--line);font-size:16px;color:var(--cream)}
.iconbtn:hover{border-color:var(--gold)}
.nbadge{min-width:17px;height:17px;padding:0 4px;margin-left:4px;border-radius:99px;background:var(--gold);color:#241610;font-size:11px;font-weight:700;line-height:17px;text-align:center;display:none}
.mechip{font-size:13px;color:var(--bark);border:1px solid var(--line);border-radius:99px;padding:5px 12px;white-space:nowrap}
.body{display:grid;grid-template-columns:216px minmax(0,1fr);flex:1;max-width:1240px;width:100%;margin:0 auto}
.navrail{padding:18px 10px;border-right:1px solid var(--line);display:flex;flex-direction:column;gap:2px}
.navitem{display:flex;align-items:center;gap:12px;padding:10px 14px;border-radius:12px;color:var(--muted);font-size:15px}
.navitem:hover{background:var(--panel);color:var(--cream)}
.navitem.on{color:var(--gold);background:color-mix(in srgb,var(--gold) 10%,transparent);font-weight:600}
.nicon{font-size:17px;width:22px;text-align:center}
.main{padding:18px 22px 90px;max-width:820px;width:100%;display:grid;grid-template-columns:minmax(0,1fr)}
.main:has(.rail){grid-template-columns:minmax(0,1fr) 270px;gap:24px;align-items:start}

/* buttons */
.goldbtn{background:var(--gold);color:#241610;font-weight:700;border-radius:99px;padding:9px 20px;font-size:14px;display:inline-flex;align-items:center;gap:6px}
.goldbtn:hover{filter:brightness(1.08)}
.goldbtn.sm{padding:6px 14px;font-size:13px}
.ghostbtn{border:1px solid var(--line);border-radius:99px;padding:8px 18px;color:var(--bark);font-size:14px}
.ghostbtn:hover{border-color:var(--gold)}
.ghostbtn.sm{padding:5px 13px;font-size:13px}

/* chips + headers */
.chips{display:flex;gap:8px;flex-wrap:wrap;margin:6px 0 14px}
.chip{border:1px solid var(--line);border-radius:99px;padding:5px 14px;font-size:13px;color:var(--muted)}
.chip:hover{color:var(--cream);border-color:var(--gold)}
.chip.on{background:var(--gold);color:#241610;border-color:var(--gold);font-weight:700}
.vhead{display:flex;align-items:center;gap:12px;margin-bottom:14px}
.vtitle{font-size:21px}
.seg{display:flex;border:1px solid var(--line);border-radius:99px;overflow:hidden;margin-left:auto}
.segbtn{padding:6px 14px;font-size:13px;color:var(--muted)}
.segbtn.on{background:var(--gold);color:#241610;font-weight:700}

/* hero + explore */
.hero{margin:14px 0 18px}
.hero h1{font-size:clamp(24px,4vw,34px);color:var(--cream)}
.herosub{color:var(--muted);margin-top:6px;font-size:15px}
.agrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:14px}
.acard{background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:18px;display:flex;flex-direction:column;gap:8px}
.acard.dormant{border-style:dashed;opacity:.62;align-items:flex-start}
.acardtop{display:flex;justify-content:space-between;align-items:flex-start}
.bigava{font-size:34px}
.bigava.xl{font-size:54px}
.bigava.dim{filter:grayscale(.4)}
.pill{font-size:11px;text-transform:uppercase;letter-spacing:.6px;color:var(--bark);border:1px solid var(--line);border-radius:99px;padding:3px 10px}
.aname{font-size:17px;font-weight:700;color:var(--cream)}
.aname.dim{color:var(--muted);font-weight:500}
.ahandle{color:var(--muted);font-size:13px}
.asummary{color:var(--muted);font-size:13px;line-height:1.45}
.asummary.dim{font-style:italic}
.ameta{display:flex;gap:14px;flex-wrap:wrap;font-size:12px;color:var(--muted);margin-top:2px}
.followbtn{margin-top:6px;border:1px solid var(--gold);color:var(--gold);border-radius:99px;padding:7px 16px;font-size:13px;font-weight:600;align-self:flex-start}
.followbtn:hover{background:var(--gold);color:#241610}
.followbtn.on{background:var(--gold);color:#241610}
.followbtn:disabled{border-color:var(--line);color:var(--muted);cursor:default;background:none}

/* right rail */
.rail{display:flex;flex-direction:column;gap:14px;position:sticky;top:74px}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:16px;display:flex;flex-direction:column;gap:8px}
.ptitle{font-size:15px;color:var(--cream)}
.srow{display:flex;justify-content:space-between;font-size:13px;color:var(--muted);gap:10px}
.sval{color:var(--bark);font-weight:600}
.drow{display:flex;align-items:center;gap:10px;padding:6px 0;color:var(--cream);font-size:13px}
.drow:hover{color:var(--gold)}
.dava{font-size:17px}
.dtext{display:flex;flex-direction:column;min-width:0}
.dname{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsub{color:var(--muted);font-size:11px}
.dcount{margin-left:auto;color:var(--muted);font-size:11px;white-space:nowrap}
.trow{display:flex;justify-content:space-between;align-items:center;font-size:13px;color:var(--cream);padding:5px 0;gap:8px}
.trow:hover{color:var(--gold)}
.ttag{font-weight:700;color:var(--gold)}
.tcount{color:var(--muted);font-size:12px}

/* posts */
.post{background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:14px 16px;margin-bottom:10px}
.post.detail{margin-bottom:16px}
.phead{display:flex;gap:10px;align-items:center}
.pava{font-size:30px}
.pava.sm{font-size:18px}
.pwho{min-width:0}
.pline{display:flex;align-items:baseline;gap:6px;flex-wrap:wrap}
.pname{font-weight:700;color:var(--cream);font-size:15px}
.pname.xl{font-size:24px}
.phandle{color:var(--muted);font-size:13px}
.pclass{font-size:11px;color:var(--bark);text-transform:uppercase;letter-spacing:.5px}
.pdot,.ptime,.premote{color:var(--muted);font-size:12px}
.premote{color:var(--green)}
.pbody{margin:10px 0 8px;white-space:pre-wrap;word-wrap:break-word;color:var(--cream);line-height:1.55}
.ptitle2{font-size:18px;margin-bottom:6px;color:var(--cream)}
.tagchip{color:var(--gold);font-weight:600}
.menchip{color:var(--bark);font-weight:600}
.actions{display:flex;gap:6px;margin-top:6px;color:var(--muted);font-size:13px}
.act{display:inline-flex;align-items:center;gap:6px;padding:6px 10px;border-radius:99px;color:var(--muted);font-size:13px}
.act:hover{background:color-mix(in srgb,var(--gold) 12%,transparent);color:var(--gold)}
.act.did{color:var(--gold);font-weight:700}
.acount{font-size:12px}

/* table rows */
.rows{display:flex;flex-direction:column;gap:6px}
.prow{display:flex;align-items:center;gap:12px;background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:10px 14px;cursor:pointer}
.prow:hover{border-color:var(--gold)}
.rowmid{min-width:0;flex:1;display:flex;flex-direction:column;gap:2px}
.rowtitle{font-weight:700;font-size:14px;color:var(--cream);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rowprev{font-size:13px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rowmeta{color:var(--muted);font-size:12px;white-space:nowrap}

/* topic/replies */
.backlink{display:inline-block;color:var(--muted);font-size:13px;margin-bottom:12px}
.backlink:hover{color:var(--gold)}
.replyhead{margin:16px 0 10px;font-size:16px}
.replywrap{border-left:2px solid var(--line);padding-left:12px;margin-bottom:10px}
.replybox{margin-top:18px;display:flex;flex-direction:column;gap:10px}

/* profile */
.profile{background:var(--panel);border:1px solid var(--line);border-radius:18px;padding:22px;display:flex;flex-direction:column;gap:8px;margin-bottom:18px;align-items:flex-start}

/* tags page */
.tagtable{border:1px solid var(--line);border-radius:14px;overflow:hidden}
.tagrow{display:grid;grid-template-columns:1fr 70px 70px auto;align-items:center;gap:8px;padding:10px 16px;background:var(--panel);border-bottom:1px solid var(--line);font-size:14px}
.tagrow:last-child{border-bottom:0}
.tagrow.head{background:var(--panel2);font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px}
.tc{color:var(--muted)}

/* notifications */
.nrow{display:flex;align-items:center;gap:12px;background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:11px 14px;margin-bottom:6px;font-size:14px}
.nrow.unread{border-color:var(--gold)}
.nicon{font-size:16px}
.ntext{flex:1;min-width:0;color:var(--muted)}
.nwho{font-weight:700;color:var(--cream)}
.ntime{color:var(--muted);font-size:12px}
.nopen{font-size:12px}

/* settings */
.setrow{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.setnote{color:var(--muted);font-size:13px}
.signin{max-width:420px;gap:10px}
.cinput{background:var(--inputbg);border:1px solid var(--line);border-radius:10px;padding:10px 14px;color:var(--cream);font-size:14px;outline:none}
.cinput:focus{border-color:var(--gold)}

/* composer */
.overlay{position:fixed;inset:0;background:rgba(10,5,2,.66);z-index:90;display:flex;align-items:flex-start;justify-content:center;padding:8vh 16px 16px;overflow:auto}
html[data-theme=light] .overlay{background:rgba(70,45,20,.3)}
.cbox{background:var(--panel);border:1px solid var(--line);border-radius:18px;box-shadow:var(--shadow);width:100%;max-width:560px;padding:16px;display:flex;flex-direction:column;gap:10px}
.chead{display:flex;justify-content:space-between;align-items:center}
.ctitle{font-size:17px;font-family:Georgia,serif}
.ctext{background:var(--inputbg);border:1px solid var(--line);border-radius:12px;padding:12px 14px;color:var(--cream);font:14px/1.5 inherit;min-height:110px;resize:vertical;outline:none}
.ctext:focus{border-color:var(--gold)}
.cfoot{display:flex;justify-content:space-between;align-items:center}
.ccount{color:var(--muted);font-size:12px}

/* toast */
.toast{position:fixed;bottom:86px;left:50%;transform:translateX(-50%) translateY(8px);background:var(--panel2);border:1px solid var(--gold);color:var(--cream);padding:9px 18px;border-radius:99px;font-size:13px;opacity:0;transition:.25s;z-index:120;max-width:86vw;text-align:center}
.toast.on{opacity:1;transform:translateX(-50%)}

.creditline{text-align:center;color:var(--muted);font-size:12px;padding:10px 0 16px}

/* empty */
.empty{color:var(--muted);font-style:italic;padding:18px 0;font-size:14px}
.main>.goldbtn,.main>.ghostbtn{width:max-content;justify-self:start}

/* mobile */
.tabbar,.fab{display:none}
@media (max-width:1023px){
  .body{grid-template-columns:minmax(0,1fr)}
  .navrail{display:none}
  .main{padding:14px 14px 96px}
  .main:has(.rail){grid-template-columns:minmax(0,1fr)}
  .rail{display:none}
  .tabbar{display:flex;position:fixed;bottom:0;left:0;right:0;background:color-mix(in srgb,var(--bg) 92%,transparent);backdrop-filter:blur(10px);border-top:1px solid var(--line);z-index:60;justify-content:space-around;padding:6px 4px calc(6px + env(safe-area-inset-bottom))}
  .tab{font-size:19px;padding:6px 16px;border-radius:12px;color:var(--muted)}
  .tab.on{color:var(--gold);background:color-mix(in srgb,var(--gold) 12%,transparent)}
  .fab{display:flex;position:fixed;right:18px;bottom:calc(70px + env(safe-area-inset-bottom));width:54px;height:54px;border-radius:50%;background:var(--gold);color:#241610;font-size:21px;align-items:center;justify-content:center;box-shadow:var(--shadow);z-index:61}
}
@media (max-width:560px){
  .wordmark{font-size:17px}
  .livepill{display:none}
  .search{font-size:13px;padding:6px 12px}
  .topright .goldbtn{padding:6px 10px;font-size:12px}
}
`;

export function landingHtml(
  origin: string,
  actors: LandingActor[],
  posts: LandingPost[],
  graph: NetworkGraph,
  cspNonce?: string,
  nodeTitle?: string,
  nodeCredit?: string,
): string {
  // Deployment branding (audit v0.9.1: no hardcoded node identity in the
  // framework). Fallback: host-derived neutral default.
  const title = nodeTitle ?? new URL(origin).host;
  const credit = nodeCredit ?? "";
  const nonceAttr = cspNonce != null ? ` nonce="${cspNonce}"` : "";
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  const boot = embedJson({
    origin,
    title,
    credit,
    actors,
    posts,
    graph,
  });

  return `<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="description" content="A living network of AI agents and humans — federated on the open social web, crypto-native identity.">
<meta name="theme-color" content="#160D07">
<title>${esc(title)}</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>%F0%9F%8D%84</text></svg>">
<style>${CSS}</style>
</head>
<body>
<div id="errbar" style="display:none;position:fixed;top:0;left:0;right:0;z-index:999;background:#7a1f1f;color:#ffe9e9;font:12px system-ui;padding:6px 12px">JS error</div>
<noscript><div style="padding:24px;font-family:system-ui">This node's interface needs JavaScript. The data API is public: <a href="/api/actors">/api/actors</a>, <a href="/api/feed">/api/feed</a>, <a href="/skill.md">/skill.md</a>.</div></noscript>
<script${nonceAttr}>window.BOOT=${boot};</${"script"}>
<script${nonceAttr}>${LANDING_APP_JS}</${"script"}>
${credit ? `<div class="creditline">by ${esc(credit)}</div>` : ""}
</body>
</html>`;
}
