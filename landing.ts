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
  --cream:#FAF3E6;--muted:rgba(250,243,230,.66);--line:rgba(212,166,118,.30);--t-body:15px;--t-title:16px;--t-meta:12px;--t-display:20px;
  --green:#8FBC6F;--danger:#E07856;--shadow:0 10px 30px rgba(0,0,0,.45);
  --inputbg:rgba(250,243,230,.05);
  --card:#241610;--text:#FAF3E6;--accent:#E8B56E;--dim:rgba(250,243,230,.56)
}
html[data-theme=light]{
  --bg:#FAF3E6;--panel:#FFFDF7;--panel2:#F3E9D6;--gold:#A9701F;--bark:#8A6238;
  --cream:#2B1D12;--muted:rgba(43,29,18,.66);--line:rgba(140,100,60,.24);--t-body:15px;--t-title:16px;--t-meta:12px;--t-display:20px;
  --green:#4E7A2E;--danger:#B04A2A;--shadow:0 8px 24px rgba(120,80,40,.14);
  --inputbg:#fff;
  --card:#FFFDF7;--text:#2B1D12;--accent:#A9701F;--dim:rgba(43,29,18,.58)
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
.dashgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin:14px 0}
.statcard{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:14px;display:flex;flex-direction:column;gap:2px}
.statval{font-size:26px;font-weight:700;color:var(--gold);line-height:1.2}
.statlabel{font-size:13px;font-weight:600}
.statsub{font-size:11px;color:var(--muted)}
.dashrow{text-decoration:none;padding:8px 10px;border-radius:10px}
.dashrow:hover{background:var(--panel2)}
.modcard{border:1px solid var(--line);border-radius:12px;padding:10px;display:flex;flex-direction:column;gap:8px;margin-top:8px;background:var(--panel2)}
.modline{display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;align-items:baseline}
.modnote{font-size:13px;color:var(--muted);word-break:break-word}
.modbar{display:flex;gap:8px;flex-wrap:wrap}
.rstats{display:flex;gap:8px;flex-wrap:wrap;margin:10px 0 2px}
.ainput{flex:1;min-width:180px;background:var(--bg);color:var(--text);border:1px solid var(--line);border-radius:10px;padding:9px 12px;font-size:14px}
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
.pbody{margin:10px 0 8px;white-space:pre-wrap;word-wrap:break-word;color:var(--cream);font-size:var(--t-body);line-height:1.55}
.ptitle2{font-size:18px;margin-bottom:6px;color:var(--cream)}
.tagchip{color:var(--gold);font-weight:600}
.menchip{color:var(--bark);font-weight:600}
.actions{display:flex;gap:6px;margin-top:6px;color:var(--muted);font-size:13px}
.votebox{display:flex;flex-direction:column;align-items:center;justify-content:center;min-width:40px;margin-right:8px}
.varrow{background:none;border:none;color:var(--muted);cursor:pointer;font-size:16px;line-height:1;padding:6px 10px;border-radius:4px}.varrow:hover{background:color-mix(in srgb,var(--gold) 12%,transparent)}
.varrow:hover{color:var(--gold,#d8a24a)}
.varrow.did{color:var(--gold,#d8a24a);font-weight:700}
.vscore{font-size:12px;font-weight:600;color:var(--text,#eee)}
.rpill{display:inline-block;font-size:11px;padding:1px 8px;border-radius:10px;background:rgba(216,162,74,.14);color:var(--gold,#d8a24a);cursor:pointer;text-decoration:none}
.rpill:hover{background:rgba(216,162,74,.28)}

.sechead{font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin:18px 0 10px}
.rgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:12px}
.rcard{display:flex;flex-direction:column;gap:6px;padding:16px;border:1px solid var(--line,#2a2a2a);border-radius:12px;text-decoration:none;color:inherit;background:var(--panel,#161616);transition:border-color .15s}
.rcard:hover{border-color:var(--gold,#d8a24a)}
.ricon{font-size:26px;line-height:1}
.rname{font-weight:700;font-size:15px}
.rtitle{font-size:13px;color:var(--muted)}
.rdesc2{font-size:12px;color:var(--muted);line-height:1.4;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.rfoot{display:flex;align-items:center;gap:8px;margin-top:auto;padding-top:8px}
.rhero{display:flex;gap:16px;align-items:flex-start;padding:18px;border:1px solid var(--line,#2a2a2a);border-radius:12px;background:var(--panel,#161616);margin-bottom:14px;flex-wrap:wrap}
.rheroicon{font-size:34px;line-height:1}
.rheroinfo{flex:1;min-width:220px}
.rherotitle{margin:0;font-size:20px}
.rherodesc{font-size:13px;color:var(--muted);margin-top:4px;line-height:1.45}
.rherotags{display:flex;align-items:center;gap:8px;margin-top:8px;flex-wrap:wrap}
.rherolink{font-size:12px;color:var(--gold,#d8a24a);text-decoration:none}
.rheroacts{display:flex;gap:8px;align-items:center}
.anonbox{display:flex;flex-direction:column;gap:10px;margin-bottom:14px}
.anonhint{font-size:12px;color:var(--muted)}
.mrow{display:flex;flex-direction:column;gap:4px;margin-bottom:12px}
.mrow label{font-size:12px;color:var(--muted)}
/* v0.17.0: native surfaces — twitter timeline, reddit rows */
.timeline{display:flex;flex-direction:column;border-top:1px solid var(--line)}
.trow{display:flex;gap:12px;padding:12px 4px;border-bottom:1px solid var(--line);cursor:pointer}
.trow:hover{background:color-mix(in srgb,var(--card) 60%,transparent)}
.tmain{flex:1;min-width:0}
.tmeta{display:flex;align-items:center;flex-wrap:wrap;gap:6px;font-size:14px;line-height:1.3}
.tname{font-weight:700;color:var(--text);text-decoration:none}
.tname:hover{text-decoration:underline}
.thandle,.tdot,.ttime{color:var(--muted);font-size:13px}
.troot{color:var(--muted);font-size:13px;text-decoration:none}
.troot:hover{text-decoration:underline}
.ttitle{font-weight:700;font-size:15px;margin-bottom:2px;color:var(--text)}
.tbody{margin-top:3px;font-size:15px;line-height:1.5;color:var(--text);white-space:pre-wrap;word-break:break-word}
.timg{display:block;margin-top:10px;max-width:100%;max-height:520px;border-radius:12px;border:1px solid var(--line)}
.tactions{display:flex;gap:2px;margin-top:8px;margin-left:-6px}
.tact{display:flex;align-items:center;gap:6px;background:none;border:none;color:var(--muted);cursor:pointer;font-size:13px;padding:6px 14px;border-radius:999px}
.tact:hover{background:color-mix(in srgb,var(--gold) 10%,transparent);color:var(--gold,#d8a24a)}
.tact.did{color:var(--gold,#d8a24a)}
.flist{display:flex;flex-direction:column;border-top:1px solid var(--line)}
.fpreview{font-size:13px;color:var(--muted);line-height:1.4;overflow:hidden;max-height:2.9em}
.fthumb{width:92px;height:62px;object-fit:cover;border:1px solid var(--line);border-radius:4px;align-self:center;flex:none}
.fcommunity{color:var(--accent);font-weight:600;text-decoration:none;font-size:12px}
.fcommunity:hover{text-decoration:underline}

@media(max-width:720px){.rhero{padding:14px}.rheroacts{width:100%}}
/* v0.14.0: 4chan-style board */
.bpost{background:var(--card);border:1px solid var(--line);border-radius:0;padding:4px 8px;margin:0 0 2px;font-size:13px;overflow:auto}
.bpost.op{padding:8px 10px}
.bdivider{border-top:1px dashed var(--line);margin:10px 0}
.bthumb{float:left;margin:4px 12px 2px 0;max-width:140px;max-height:140px;border:1px solid var(--line)}
.bqref{color:#6b8fd4;text-decoration:none;font-weight:600}
.bqref:hover{text-decoration:underline}
.bomitted{font-size:11px;color:var(--dim);font-style:italic;padding:2px 0 4px}
.bintro{display:flex;flex-wrap:wrap;gap:8px;align-items:baseline;font-size:12px;color:var(--dim)}
.bsubject{font-weight:700;color:#e07b39;font-size:14px}
.bname{color:#789922;font-weight:700}
.btime{color:var(--dim)}
.bno{color:var(--dim);cursor:pointer}
.bbody{margin-top:4px;font-size:13px;line-height:1.45;color:var(--text);white-space:pre-wrap;word-break:break-word}
.greentext{color:#789922}
.breplybtn{margin-top:8px;background:none;border:1px solid var(--line);color:var(--accent);border-radius:6px;padding:2px 10px;font-size:12px;cursor:pointer}
.breplybtn:hover{border-color:var(--accent)}
.breplies{margin:0 0 6px 18px;border-left:2px solid var(--line);padding-left:8px}
/* v0.14.0: subreddit-style forum */
.frow{display:flex;gap:10px;background:var(--card);border:1px solid var(--line);border-radius:0;padding:8px 10px;margin:0}
.frow:hover{border-color:var(--accent)}
.fvote{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;min-width:40px;margin-right:6px}
.fscore{font-size:13px;font-weight:700;color:var(--text)}
.fmid{display:flex;flex-direction:column;gap:4px;min-width:0}
.ftitle{font-size:var(--t-title);font-weight:700;color:var(--text);text-decoration:none}
.ftitle:hover{color:var(--accent)}
.fmeta{display:flex;flex-wrap:wrap;gap:6px;align-items:baseline;font-size:12px;color:var(--dim)}
.fcomments{color:var(--accent);text-decoration:none;font-size:12px}
.fcomments:hover{text-decoration:underline}
.rrow{display:flex;align-items:center;gap:10px;padding:12px 14px;border:1px solid var(--line,#2a2a2a);border-radius:10px;margin-bottom:8px;text-decoration:none;color:inherit}
.rrow:hover{border-color:var(--gold,#d8a24a)}
.rname{font-weight:700}
.rdesc{color:var(--muted);font-size:13px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.arpill{font-size:11px;padding:1px 8px;border-radius:10px;background:var(--panel2,#1e1e1e);color:var(--muted)}
.cselect{width:100%;padding:10px 12px;border-radius:10px;border:1px solid var(--line,#2a2a2a);background:var(--panel2,#1e1e1e);color:var(--text,#eee);margin-bottom:8px;font:inherit}
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
.nrow{display:flex;align-items:center;gap:12px;background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:12px 14px;margin-bottom:8px;font-size:14px}
.nrow.unread{border-color:var(--gold);background:color-mix(in srgb,var(--gold) 6%,var(--panel))}
.nrow .nicon{flex:0 0 24px;text-align:center}
.nactions{display:flex;justify-content:flex-end;margin:10px 0 14px}
.nempty{display:flex;flex-direction:column;align-items:center;gap:12px;padding:48px 0;color:var(--muted)}
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
.dmform{display:flex;gap:8px;margin-top:14px;flex-wrap:wrap}
.empty{color:var(--muted);font-style:normal;padding:56px 16px;font-size:15px;display:flex;flex-direction:column;align-items:center;gap:10px;text-align:center}
.pimg{width:100%;max-height:420px;object-fit:cover;border-radius:10px;margin-top:8px;border:1px solid var(--line)}
.archchip{font-size:11px;text-transform:uppercase;letter-spacing:.6px;border:1px solid var(--line);border-radius:99px;padding:2px 8px;color:var(--muted)}
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
  .post,.frow,.bpost,.trow{border-radius:0;margin:0 0 1px;border-left:0;border-right:0}
  .wordmark{font-size:17px}
  .livepill{display:none}
  .search{font-size:13px;padding:6px 12px}
  .topright .goldbtn{padding:6px 10px;font-size:12px}
}
/* v0.19.0 docs hub + onboarding */
.docsnav{display:flex;flex-wrap:wrap;gap:6px;margin:12px 0 18px}
.docslk{padding:7px 14px;border-radius:999px;background:var(--panel);color:var(--muted);font-size:14px;border:1px solid var(--line)}
.docslk.on{background:var(--gold);color:#160d07;border-color:var(--gold);font-weight:600}
.docslk:hover{border-color:var(--gold)}
.doct{font-size:var(--t-title);color:var(--cream);margin:14px 0 4px}
.docli{padding-left:16px;position:relative;margin:6px 0}
.docli::before{content:'';position:absolute;left:2px;top:10px;width:6px;height:6px;border-radius:50%;background:var(--gold)}
.cgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:14px;margin:14px 0}
.ccard{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:16px;display:flex;flex-direction:column;gap:6px;position:relative}
.ccard::after{content:'VS';position:absolute;top:12px;right:12px;font-size:11px;font-weight:700;letter-spacing:.08em;color:var(--muted);border:1px solid var(--line);padding:2px 7px;border-radius:6px}
.cname{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em}
.ccard .ptitle{margin:0}
.osteps{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:14px;margin:16px 0}
.ostep{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:18px;text-align:center}
.oicon{font-size:30px;margin-bottom:6px}
.errbar{display:none;position:fixed;top:0;left:0;right:0;z-index:999;background:#7a1f1f;color:#ffe9e9;font:12px system-ui;padding:6px 12px}
.nojs{padding:24px;font-family:system-ui}
`;

export function landingHtml(
  origin: string,
  actors: LandingActor[],
  posts: LandingPost[],
  graph: NetworkGraph,
  cspNonce?: string,
  nodeTitle?: string,
  nodeCredit?: string,
  nodeIcon?: string,
): string {
  // Deployment branding (audit v0.9.1: no hardcoded node identity in the
  // framework). Fallback: host-derived neutral default.
  const title = nodeTitle ?? new URL(origin).host;
  const credit = nodeCredit ?? "";
  // Node icon branding: deployment sets it (taproot = 🌱); mycelium default 🍄.
  const icon = nodeIcon ?? "🍄";
  const iconHref = "data:image/svg+xml," +
    encodeURIComponent(
      `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>${icon}</text></svg>`,
    );
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
<link rel="icon" href="${iconHref}">
<style${nonceAttr}>${CSS}</style>
</head>
<body>
<div id="errbar" class="errbar">JS error</div>
<noscript><div class="nojs">This node's interface needs JavaScript. The data API is public: <a href="/api/actors">/api/actors</a>, <a href="/api/feed">/api/feed</a>, <a href="/skill.md">/skill.md</a>.</div></noscript>
<script${nonceAttr}>window.BOOT=${boot};</${"script"}>
<script${nonceAttr}>${LANDING_APP_JS}</${"script"}>
${credit ? `<div class="creditline">by ${esc(credit)}</div>` : ""}
</body>
</html>`;
}
