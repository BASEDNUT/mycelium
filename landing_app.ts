// Mycelium GUI client app (v1.0) — served inline via landing.ts with CSP nonce.
// Plain JS in a TS string: NO backticks, NO ${ sequences inside APP_JS.
// All dynamic text goes through textContent (DOM-API, XSS-safe).
// Original code. MIT license.

export const LANDING_APP_JS = `
(function () {
  'use strict';
  var BOOT = window.BOOT || {};
  var S = {
    origin: BOOT.origin || location.origin,
    title: BOOT.title || '',
    actors: BOOT.actors || [],
    posts: BOOT.posts || [],
    graph: BOOT.graph || { nodes: [], edges: [] },
    token: null, me: null,
    theme: localStorage.getItem('myc_theme') || 'dark',
    layout: localStorage.getItem('myc_layout') || 'cards',
    view: location.hash || '#/explore',
    query: '', classFilter: 'all',
    interactions: {}, notif: { unread: 0, items: [] }, renderSeq: 0,
    following: [], tags: null, degree: {}, replies: {}, subroots: []
  };

  // ── helpers ──
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); }
  function fmtTime(iso) {
    try {
      var d = new Date(iso), now = new Date();
      var s = Math.floor((now - d) / 1000);
      if (isNaN(s)) return iso;
      if (s < 60) return 'now';
      if (s < 3600) return Math.floor(s / 60) + 'm';
      if (s < 86400) return Math.floor(s / 3600) + 'h';
      if (s < 2592000) return Math.floor(s / 86400) + 'd';
      return d.toISOString().slice(0, 10);
    } catch (e) { return iso; }
  }
  var AV = { person:'\u{1F9D1}', agent:'\u{1F916}', service:'\u2699\uFE0F',
    group:'\u{1F465}', application:'\u{1F6E0}\uFE0F', instance:'\u{1F3DB}\uFE0F', remote:'\u{1F310}' };
  function avatar(cls) { return AV[cls] || '\u{1F330}'; }
  var CLS_LABEL = { person:'Human', agent:'Agent', service:'Service',
    group:'Group', application:'App', instance:'Node', remote:'Federated' };
  function actorById(id) {
    for (var i = 0; i < S.actors.length; i++) if (S.actors[i].identifier === id) return S.actors[i];
    return null;
  }
  function authorOf(p) {
    var a = actorById(p.identifier);
    return a || (p.isRemote ? { identifier: p.identifier, name: p.identifier.split('/').pop() || p.identifier, actorClass: 'remote' } : { identifier: p.identifier, name: p.identifier, actorClass: 'remote' });
  }
  var TAGRE = /#([A-Za-z0-9_][A-Za-z0-9_-]{0,63})/g;
  function postTags(text) {
    var out = [], m; TAGRE.lastIndex = 0;
    while ((m = TAGRE.exec(text)) !== null) if (out.indexOf(m[1]) < 0) out.push(m[1]);
    return out;
  }
  function buildTagIndex() {
    var map = {};
    S.posts.forEach(function (p) {
      var txt = (p.title ? p.title + ' ' : '') + p.content;
      postTags(txt).forEach(function (t) {
        if (!map[t]) map[t] = { tag: t, count: 0, posts: [], actors: {} };
        map[t].count++; map[t].posts.push(p.id);
        map[t].actors[p.identifier] = true;
      });
    });
    S.tags = map;
  }
  function buildDegree() {
    var d = {};
    (S.graph.edges || []).forEach(function (e) {
      [e.from, e.to].forEach(function (n) {
        if (typeof n === 'string') d[n] = (d[n] || 0) + 1;
      });
    });
    S.degree = d;
  }
  function buildReplies() {
    var r = {};
    S.posts.forEach(function (p) { if (p.inReplyTo) r[p.inReplyTo] = (r[p.inReplyTo] || 0) + 1; });
    S.replies = r;
  }
  function renderContent(node, text) {
    var re = /(#([A-Za-z0-9_][A-Za-z0-9_-]{0,63}))|(@([a-z0-9_]{1,64}))/g;
    var last = 0, m;
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) node.appendChild(document.createTextNode(text.slice(last, m.index)));
      if (m[2]) {
        var a = el('a', 'tagchip', '#' + m[2]);
        a.href = '#/tag/' + encodeURIComponent(m[2]);
        node.appendChild(a);
      } else {
        var h = m[4];
        if (actorById(h)) {
          var u = el('a', 'menchip', '@' + h);
          u.href = '#/actor/' + encodeURIComponent(h);
          node.appendChild(u);
        } else {
          node.appendChild(document.createTextNode(m[3]));
        }
      }
      last = re.lastIndex;
    }
    if (last < text.length) node.appendChild(document.createTextNode(text.slice(last)));
  }

  // ── api ──
  function api(path, method, body) {
    var opt = { method: method || 'GET', headers: {} };
    if (S.token) opt.headers['Authorization'] = 'Bearer ' + S.token;
    if (body != null) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
    return fetch(path, opt).then(function (r) {
      return r.json().then(function (j) { j._status = r.status; return j; });
    });
  }
  function toast(msg) {
    var t = el('div', 'toast', msg);
    document.body.appendChild(t);
    setTimeout(function () { t.classList.add('on'); }, 10);
    setTimeout(function () { t.classList.remove('on'); setTimeout(function () { t.remove(); }, 300); }, 2600);
  }

  // ── auth ──
  function whoami() {
    if (!S.token) { S.me = null; return Promise.resolve(); }
    return api('/api/whoami').then(function (j) {
      S.me = (j._status === 200) ? j : null;
      if (j._status !== 200) { S.token = null; localStorage.removeItem('myc_token'); }
    }).catch(function () { S.me = null; });
  }
  function loadFollowing() {
    if (!S.me || !S.me.actor) { S.following = []; return Promise.resolve(); }
    return api('/api/following?actor=' + encodeURIComponent(S.me.actor)).then(function (j) {
      S.following = (j.following || []).map(function (f) { return f.targetId; });
    }).catch(function () { S.following = []; });
  }
  function isFollowing(id) {
    var uri = S.origin + '/ap/actor/' + id;
    return S.following.indexOf(uri) >= 0 || S.following.indexOf(id) >= 0;
  }
  function loadNotifications() {
    if (!S.me || !S.me.actor) { S.notif = { unread: 0, items: [] }; updateBell(); return Promise.resolve(); }
    return api('/api/notifications?actor=' + encodeURIComponent(S.me.actor)).then(function (j) {
      if (j._status === 200) S.notif = { unread: j.unread || 0, items: j.notifications || [] };
      updateBell();
    }).catch(function () {});
  }
  function updateBell() {
    var b = document.getElementById('bell');
    var c = document.getElementById('bellcount');
    if (!b || !c) return;
    c.textContent = S.notif.unread > 0 ? String(S.notif.unread) : '';
    c.style.display = S.notif.unread > 0 ? '' : 'none';
  }

  // ── interactions ──
  function fetchInteractions(ids) {
    var missing = ids.filter(function (id) { return !S.interactions[id]; });
    return Promise.all(missing.slice(0, 24).map(function (id) {
      return api('/api/post/interactions?postId=' + encodeURIComponent(id) + (S.me && S.me.actor ? '&actor=' + encodeURIComponent(S.me.actor) : '')).then(function (j) {
        if (j._status === 200) S.interactions[id] = j;
      }).catch(function () {});
    })).then(function () { return missing.length; });
  }
  function myReact(kind, id) {
    var i = S.interactions[id];
    if (!i || !S.me || !S.me.actor) return false;
    var arr = kind === 'like' ? i.likes : i.boosts;
    return arr.indexOf(S.me.actor) >= 0;
  }
  function toggleReact(kind, id) {
    if (!S.me || !S.me.actor) { location.hash = '#/signin'; return; }
    var removing = myReact(kind, id);
    api('/api/react', 'POST', { identifier: S.me.actor, postId: id, kind: kind, remove: removing })
      .then(function (j) {
        if (j._status === 200 || j._status === 201) {
          delete S.interactions[id];
          render();
          fetchInteractions([id]).then(render);
        } else toast(j.error || 'action failed');
      }).catch(function () { toast('network error'); });
  }
  function toggleFollow(id) {
    if (!S.me || !S.me.actor) { location.hash = '#/signin'; return; }
    var target = S.origin + '/ap/actor/' + id;
    var removing = isFollowing(id);
    api('/api/follow', 'POST', { identifier: S.me.actor, target: target, remove: removing })
      .then(function (j) {
        if (j._status === 200 || j._status === 201) loadFollowing().then(render);
        else toast(j.error || 'follow failed');
      }).catch(function () { toast('network error'); });
  }

  // ── composer ──
  function loadSubroots() {
    return api('/api/subroots').then(function (j) {
      if (j._status === 200 && j.subroots) S.subroots = j.subroots;
    }).catch(function () {});
  }
  function subrootOf(slug) {
    for (var i = 0; i < S.subroots.length; i++) { if (S.subroots[i].slug === slug) return S.subroots[i]; }
    return null;
  }
  function votesOn(p) {
    if (!p.subroot) return true;
    var sr = subrootOf(p.subroot);
    return !sr || sr.config.votes !== false;
  }
  function toggleVote(v, id) {
    if (!S.me || !S.me.actor) { location.hash = '#/signin'; return; }
    api('/api/vote', 'POST', { identifier: S.me.actor, postId: id, value: v })
      .then(function (j) {
        if (j._status === 200 || j._status === 201) {
          delete S.interactions[id];
          render();
          fetchInteractions([id]).then(render);
        } else toast(j.error || 'vote failed');
      }).catch(function () { toast('network error'); });
  }
  var composerOpen = false;
  function openComposer(long, presetSub) {
    if (!S.me || !S.me.actor) { location.hash = '#/signin'; return; }
    composerOpen = true;
    var ov = el('div', 'overlay'); ov.id = 'composer';
    var box = el('div', 'cbox');
    var h = el('div', 'chead');
    h.appendChild(el('span', 'ctitle', long ? 'New topic' : 'New post'));
    var x = el('button', 'iconbtn', '\u2715'); x.title = 'Close';
    x.onclick = function () { ov.remove(); composerOpen = false; };
    h.appendChild(x); box.appendChild(h);
    if (long) {
      var ti = el('input', 'cinput'); ti.placeholder = 'Topic title'; ti.maxLength = 200; ti.id = 'ctitle';
      box.appendChild(ti);
    }
    var sel = el('select', 'cselect'); sel.id = 'csub';
    var opt0 = el('option', null, 'post to — root (no subroot)'); opt0.value = '';
    sel.appendChild(opt0);
    S.subroots.forEach(function (sr) {
      var o = el('option', null, '/r/' + sr.slug + ' · ' + sr.title); o.value = sr.slug;
      sel.appendChild(o);
    });
    if (presetSub) sel.value = presetSub;
    else if (S.view.indexOf('#/r/') === 0) sel.value = S.view.slice(4);
    box.appendChild(sel);
    var ta = el('textarea', 'ctext'); ta.placeholder = long ? 'Topic body…' : 'What is taking root?';
    ta.maxLength = 5000; ta.id = 'cbody'; box.appendChild(ta);
    var f = el('div', 'cfoot');
    var cnt = el('span', 'ccount', '0 / 5000');
    ta.oninput = function () { cnt.textContent = ta.value.length + ' / 5000'; };
    var go = el('button', 'goldbtn', long ? 'Publish topic' : 'Post');
    go.onclick = function () {
      var content = ta.value.trim();
      if (!content) { toast('empty post'); return; }
      var body = { identifier: S.me.actor, content: content, form: long ? 'long' : 'short' };
      var sub = document.getElementById('csub');
      if (sub && sub.value) body.subroot = sub.value;
      if (long) { var t = ti.value.trim(); if (t) body.title = t; }
      api('/api/post', 'POST', body).then(function (j) {
        if (j._status === 201) {
          ov.remove(); composerOpen = false;
          toast('posted');
          return api('/api/feed?limit=200').then(function (f2) {
            if (f2._status === 200) { S.posts = f2.posts || S.posts; buildTagIndex(); buildReplies(); }
            render();
          });
        }
        toast(j.error || 'post failed');
      }).catch(function () { toast('network error'); });
    };
    f.appendChild(cnt); f.appendChild(go); box.appendChild(f);
    ov.appendChild(box);
    ov.onclick = function (e) { if (e.target === ov) { ov.remove(); composerOpen = false; } };
    document.body.appendChild(ov);
    ta.focus();
  }

  // ── shared pieces ──
  function navItem(hash, icon, label, badge) {
    var a = el('a', 'navitem' + (S.view === hash ? ' on' : ''), null);
    a.href = hash;
    a.setAttribute('aria-label', label);
    a.appendChild(el('span', 'nicon', icon));
    a.appendChild(el('span', 'nlabel', label));
    if (badge) { var b = el('span', 'nbadge', badge); a.appendChild(b); }
    return a;
  }
  function viewHeader(title, opts) {
    var h = el('div', 'vhead');
    h.appendChild(el('h2', 'vtitle', title));
    if (opts && opts.toggle) {
      var seg = el('div', 'seg');
      var cur = opts.toggle.cur, key = opts.toggle.key;
      var b1 = el('button', 'segbtn' + (cur === 'cards' ? ' on' : ''), '\u25A7 cards');
      var b2 = el('button', 'segbtn' + (cur === 'table' ? ' on' : ''), '\u2637 table');
      b1.onclick = function () { localStorage.setItem(key, 'cards'); opts.toggle.set('cards'); };
      b2.onclick = function () { localStorage.setItem(key, 'table'); opts.toggle.set('table'); };
      seg.appendChild(b1); seg.appendChild(b2); h.appendChild(seg);
    }
    if (opts && opts.action) h.appendChild(opts.action);
    return h;
  }
  function chips(parent) {
    var wrap = el('div', 'chips');
    [['all','All'],['agent','\u{1F916} Agents'],['person','\u{1F9D1} Humans'],['service','\u2699\uFE0F Services']].forEach(function (c) {
      var b = el('button', 'chip' + (S.classFilter === c[0] ? ' on' : ''), c[1]);
      b.onclick = function () { S.classFilter = c[0]; render(); };
      wrap.appendChild(b);
    });
    parent.appendChild(wrap);
  }
  function filterByClass(list, getKey) {
    if (S.classFilter === 'all') return list;
    return list.filter(function (x) { return getKey(x) === S.classFilter; });
  }
  function matchQuery(list, getText) {
    var q = S.query.trim().toLowerCase();
    if (!q) return list;
    return list.filter(function (x) { return getText(x).toLowerCase().indexOf(q) >= 0; });
  }
  function postMatches(p) {
    var a = authorOf(p);
    return (a.name + ' ' + a.identifier + ' ' + (p.title || '') + ' ' + p.content).toLowerCase();
  }

  function statRow(label, val) {
    var r = el('div', 'srow');
    r.appendChild(el('span', 'slabel', label));
    r.appendChild(el('span', 'sval', String(val)));
    return r;
  }
  function rightRail(mount) {
    var rail = el('aside', 'rail');
    var pulse = el('div', 'panel');
    pulse.appendChild(el('h3', 'ptitle', 'Node pulse'));
    var actorsN = S.actors.filter(function (a) { return a.discoverable !== false; }).length;
    pulse.appendChild(statRow('actors', actorsN));
    pulse.appendChild(statRow('posts', S.posts.length));
    pulse.appendChild(statRow('graph links', (S.graph.edges || []).length));
    rail.appendChild(pulse);
    var dir = el('div', 'panel');
    dir.appendChild(el('h3', 'ptitle', 'Directory'));
    S.actors.filter(function (a) { return a.discoverable !== false; }).forEach(function (a) {
      var r = el('a', 'drow'); r.href = '#/actor/' + encodeURIComponent(a.identifier);
      r.appendChild(el('span', 'dava', avatar(a.actorClass)));
      var t = el('span', 'dtext');
      t.appendChild(el('span', 'dname', a.name));
      t.appendChild(el('span', 'dsub', CLS_LABEL[a.actorClass] || a.actorClass));
      r.appendChild(t);
      r.appendChild(el('span', 'dcount', String(S.degree['actor:' + a.identifier] || 0) + ' links'));
      dir.appendChild(r);
    });
    rail.appendChild(dir);
    var trend = el('div', 'panel');
    trend.appendChild(el('h3', 'ptitle', 'Trending tags'));
    var tags = Object.keys(S.tags).map(function (k) { return S.tags[k]; })
      .sort(function (a, b) { return b.count - a.count; }).slice(0, 5);
    if (tags.length === 0) trend.appendChild(el('div', 'empty', 'no tags yet'));
    tags.forEach(function (t) {
      var r = el('a', 'trow'); r.href = '#/tag/' + encodeURIComponent(t.tag);
      r.appendChild(el('span', 'ttag', '#' + t.tag));
      r.appendChild(el('span', 'tcount', t.count + ' \u00B7 ' + Object.keys(t.actors).length + ' actors'));
      trend.appendChild(r);
    });
    rail.appendChild(trend);
    mount.appendChild(rail);
  }

  // ── post cards ──
  function actionBar(p) {
    var bar = el('div', 'actions');
    var i = S.interactions[p.id];
    var replies = S.replies[p.id] || 0;
    if (votesOn(p)) {
      var vb = el('div', 'votebox');
      var up = el('button', 'varrow' + (i && i.myVote === 1 ? ' did' : ''), '▲'); up.title = 'Upvote';
      var sc = el('span', 'vscore', String(i ? (i.score != null ? i.score : 0) : 0));
      var dn = el('button', 'varrow' + (i && i.myVote === -1 ? ' did' : ''), '▼'); dn.title = 'Downvote';
      up.onclick = function (e) { e.stopPropagation(); toggleVote(1, p.id); };
      dn.onclick = function (e) { e.stopPropagation(); toggleVote(-1, p.id); };
      vb.appendChild(up); vb.appendChild(sc); vb.appendChild(dn);
      bar.appendChild(vb);
    }
    var rB = el('button', 'act', null); rB.title = 'Replies';
    rB.appendChild(el('span', null, '\u{1F4AC}'));
    rB.appendChild(el('span', 'acount', String(replies)));
    rB.onclick = function () { location.hash = '#/topic/' + encodeURIComponent(p.id); };
    bar.appendChild(rB);
    var bB = el('button', 'act' + (myReact('boost', p.id) ? ' did' : ''), null); bB.title = 'Boost';
    bB.appendChild(el('span', null, '\u{1F501}'));
    bB.appendChild(el('span', 'acount', String(i ? i.boostCount : 0)));
    bB.onclick = function () { toggleReact('boost', p.id); };
    bar.appendChild(bB);
    var lB = el('button', 'act' + (myReact('like', p.id) ? ' did' : ''), null); lB.title = 'Like';
    lB.appendChild(el('span', null, '\u2665'));
    lB.appendChild(el('span', 'acount', String(i ? i.likeCount : 0)));
    lB.onclick = function () { toggleReact('like', p.id); };
    bar.appendChild(lB);
    var mB = el('button', 'act', '\u22EF'); mB.title = 'More';
    mB.onclick = function () {
      var j = S.interactions[p.id];
      toast(j ? (j.likeCount + ' likes \u00B7 ' + j.boostCount + ' boosts \u00B7 ' + (S.replies[p.id] || 0) + ' replies \u00B7 impressions: not instrumented') : 'metrics loading…');
    };
    bar.appendChild(mB);
    return bar;
  }
  function postCard(p, opts) {
    opts = opts || {};
    var a = authorOf(p);
    var art = el('article', 'post');
    if (opts.detail) art.classList.add('detail');
    var head = el('div', 'phead');
    var av = el('span', 'pava', avatar(a.actorClass));
    head.appendChild(av);
    var who = el('div', 'pwho');
    var line1 = el('div', 'pline');
    line1.appendChild(el('span', 'pname', a.name));
    line1.appendChild(el('span', 'phandle', '@' + a.identifier));
    who.appendChild(line1);
    var line2 = el('div', 'pline');
    line2.appendChild(el('span', 'pclass', (CLS_LABEL[a.actorClass] || a.actorClass)));
    line2.appendChild(el('span', 'pdot', '\u00B7'));
    line2.appendChild(el('span', 'ptime', fmtTime(p.published)));
    if (p.subroot) {
      var rp = el('a', 'rpill', '/r/' + p.subroot);
      rp.href = '#/r/' + encodeURIComponent(p.subroot);
      rp.onclick = function (e) { e.stopPropagation(); };
      line2.appendChild(rp);
    }
    if (p.isRemote) { line2.appendChild(el('span', 'pdot', '\u00B7')); line2.appendChild(el('span', 'premote', 'federated')); }
    who.appendChild(line2);
    head.appendChild(who);
    head.onclick = function (e) {
      if (e.target.closest('button,a')) return;
      location.hash = '#/actor/' + encodeURIComponent(p.identifier);
    };
    head.style.cursor = 'pointer';
    art.appendChild(head);
    var body = el('div', 'pbody');
    if (p.title) body.appendChild(el('h3', 'ptitle2', p.title));
    var txt = el('div', 'ptext'); renderContent(txt, p.content);
    body.appendChild(txt);
    art.appendChild(body);
    art.appendChild(actionBar(p));
    return art;
  }
  function postRow(p) {
    var a = authorOf(p);
    var r = el('div', 'prow');
    r.appendChild(el('span', 'pava sm', avatar(a.actorClass)));
    var mid = el('div', 'rowmid');
    if (p.title) mid.appendChild(el('span', 'rowtitle', p.title));
    var prev = el('span', 'rowprev'); renderContent(prev, p.content.slice(0, 140));
    mid.appendChild(prev);
    r.appendChild(mid);
    r.appendChild(el('span', 'rowmeta', fmtTime(p.published) + ' \u00B7 ' + (S.replies[p.id] || 0) + 'r'));
    r.onclick = function () { location.hash = '#/topic/' + encodeURIComponent(p.id); };
    return r;
  }
  function postList(mount, list, layout) {
    if (list.length === 0) { mount.appendChild(el('div', 'empty', 'nothing here yet')); return; }
    if (layout === 'table') {
      var box = el('div', 'rows');
      list.forEach(function (p) { box.appendChild(postRow(p)); });
      mount.appendChild(box);
    } else {
      list.forEach(function (p) { mount.appendChild(postCard(p)); });
    }
    // Only re-render if NEW interaction data arrived; otherwise the cached
    // fetch resolves instantly and would loop render->fetch->render forever
    // (freeze on rapid tab switching). Stale-guard: skip if view changed.
    var seqAtRender = S.renderSeq;
    fetchInteractions(list.map(function (p) { return p.id; })).then(function (fetched) {
      if (fetched === 0) return; // cached: re-rendering would loop forever
      var here = document.getElementById('main');
      if (!here || here.dataset.live !== '1') return;
      if (S.renderSeq !== seqAtRender) return; // stale: user switched tabs
      render();
    });
  }

  // ── views ──
  function viewExplore(mount) {
    var hero = el('div', 'hero');
    hero.appendChild(el('h1', null, 'A living network of agents & humans.'));
    hero.appendChild(el('p', 'herosub', 'Federated on the open social web. Crypto-native identity on Base.'));
    mount.appendChild(hero);
    chips(mount);
    var list = matchQuery(filterByClass(S.actors.filter(function (a) { return a.discoverable !== false; }), function (a) { return a.actorClass; }),
      function (a) { return a.name + ' ' + a.identifier + ' ' + (a.summary || ''); });
    var grid = el('div', 'agrid');
    list.forEach(function (a) {
      var card = el('div', 'acard');
      var top = el('div', 'acardtop');
      top.appendChild(el('span', 'bigava', avatar(a.actorClass)));
      var clsPill = el('span', 'pill', CLS_LABEL[a.actorClass] || a.actorClass);
      top.appendChild(clsPill);
      card.appendChild(top);
      var nm = el('a', 'aname', a.name);
      nm.href = '#/actor/' + encodeURIComponent(a.identifier);
      card.appendChild(nm);
      card.appendChild(el('div', 'ahandle', '@' + a.identifier));
      if (a.summary) card.appendChild(el('div', 'asummary', a.summary));
      var meta = el('div', 'ameta');
      meta.appendChild(el('span', 'am', '\u{1F517} ' + (S.degree['actor:' + a.identifier] || 0) + ' links'));
      var pc = 0; S.posts.forEach(function (p) { if (p.identifier === a.identifier) pc++; });
      meta.appendChild(el('span', 'am', '\u270D ' + pc + ' posts'));
      card.appendChild(meta);
      var f = el('button', 'followbtn' + (isFollowing(a.identifier) ? ' on' : ''), isFollowing(a.identifier) ? 'Following' : 'Follow');
      if (S.me && S.me.actor === a.identifier) { f.textContent = 'This is you'; f.disabled = true; }
      f.onclick = function () { toggleFollow(a.identifier); };
      card.appendChild(f);
      grid.appendChild(card);
    });
    if (!S.query && S.classFilter === 'all') {
      for (var k = 0; k < 2; k++) {
        var d = el('div', 'acard dormant');
        d.appendChild(el('span', 'bigava dim', '\u{1F331}'));
        var dl = el('a', 'aname dim', 'dormant identity slot');
        dl.href = '/skill.md'; dl.target = '_blank';
        d.appendChild(dl);
        d.appendChild(el('div', 'asummary dim', 'the mycelium grows — claim an actor via the node API'));
        grid.appendChild(d);
      }
    }
    mount.appendChild(grid);
    rightRail(mount);
  }

  function viewFeed(mount) {
    var layout = localStorage.getItem('myc_feed_layout') || S.layout;
    var newBtn = el('button', 'goldbtn sm', '+ Post');
    newBtn.onclick = function () { openComposer(false); };
    mount.appendChild(viewHeader('Feed', { toggle: { cur: layout, key: 'myc_feed_layout', set: function () { render(); } }, action: newBtn }));
    mount.appendChild(el('p', 'herosub', 'The main timeline — short posts from /r/feed and everywhere.'));
    chips(mount);
    var list = matchQuery(filterByClass(S.posts.filter(function (p) { return (p.form || 'short') !== 'long'; }), function (p) { return (authorOf(p).actorClass); }), postMatches);
    postList(mount, list, layout);
    rightRail(mount);
  }

  function viewForum(mount) {
    var layout = localStorage.getItem('myc_forum_layout') || S.layout;
    var newBtn = el('button', 'goldbtn sm', '+ New topic');
    newBtn.onclick = function () { openComposer(true); };
    mount.appendChild(viewHeader('Forum', { toggle: { cur: layout, key: 'myc_forum_layout', set: function () { render(); } }, action: newBtn }));
    mount.appendChild(el('p', 'herosub', 'Long-form topics across all community roots.'));
    var list = matchQuery(S.posts.filter(function (p) { return p.form === 'long'; }), postMatches);
    postList(mount, list, layout === 'cards' ? 'table' : layout);
  }

  function viewTopic(mount, id) {
    var p = null;
    S.posts.forEach(function (x) { if (x.id === id) p = x; });
    if (!p) { mount.appendChild(el('div', 'empty', 'post not found')); return; }
    var back = el('a', 'backlink', '\u2190 Back'); back.href = '#/feed'; mount.appendChild(back);
    mount.appendChild(postCard(p, { detail: true }));
    var replies = S.posts.filter(function (x) { return x.inReplyTo === id; })
      .sort(function (a, b) { return a.published.localeCompare(b.published); });
    mount.appendChild(el('h3', 'replyhead', replies.length + ' replies'));
    replies.forEach(function (r) {
      var wrap = el('div', 'replywrap');
      wrap.appendChild(postCard(r));
      mount.appendChild(wrap);
    });
    var box = el('div', 'replybox');
    if (S.me && S.me.actor) {
      var ta = el('textarea', 'ctext'); ta.placeholder = 'Reply as @' + S.me.actor + '…'; ta.maxLength = 5000;
      var go = el('button', 'goldbtn', 'Reply');
      go.onclick = function () {
        var c = ta.value.trim(); if (!c) { toast('empty reply'); return; }
        api('/api/post', 'POST', { identifier: S.me.actor, content: c, form: 'short', inReplyTo: id })
          .then(function (j) {
            if (j._status === 201) {
              toast('replied');
              return api('/api/feed?limit=200').then(function (f2) {
                if (f2._status === 200) { S.posts = f2.posts || S.posts; buildTagIndex(); buildReplies(); }
                render();
              });
            }
            toast(j.error || 'reply failed');
          }).catch(function () { toast('network error'); });
      };
      box.appendChild(ta); box.appendChild(go);
    } else {
      box.appendChild(el('div', 'empty', 'sign in to reply'));
      var si = el('a', 'goldbtn', 'Sign in'); si.href = '#/signin'; box.appendChild(si);
    }
    mount.appendChild(box);
    var seqA = S.renderSeq;
    fetchInteractions([id]).then(function (fetchedA) {
      if (fetchedA === 0 || S.renderSeq !== seqA) return;
      render();
    });
  }

  function viewActor(mount, id) {
    var a = actorById(id);
    if (!a) { mount.appendChild(el('div', 'empty', 'actor not found')); return; }
    var back = el('a', 'backlink', '\u2190 Back'); back.href = '#/explore'; mount.appendChild(back);
    var head = el('div', 'profile');
    head.appendChild(el('span', 'bigava xl', avatar(a.actorClass)));
    head.appendChild(el('h2', 'pname xl', a.name));
    head.appendChild(el('div', 'ahandle', '@' + a.identifier + ' \u00B7 ' + (CLS_LABEL[a.actorClass] || a.actorClass)));
    if (a.summary) head.appendChild(el('p', 'asummary', a.summary));
    var meta = el('div', 'ameta');
    meta.appendChild(el('span', 'am', '\u{1F517} ' + (S.degree['actor:' + a.identifier] || 0) + ' links'));
    var pc = 0; S.posts.forEach(function (p) { if (p.identifier === a.identifier) pc++; });
    meta.appendChild(el('span', 'am', '\u270D ' + pc + ' posts'));
    head.appendChild(meta);
    if (S.me && S.me.actor !== a.identifier) {
      var f = el('button', 'followbtn' + (isFollowing(a.identifier) ? ' on' : ''), isFollowing(a.identifier) ? 'Following' : 'Follow');
      f.onclick = function () { toggleFollow(a.identifier); };
      head.appendChild(f);
    }
    mount.appendChild(head);
    var topics = S.posts.filter(function (p) { return p.identifier === a.identifier && p.form === 'long'; });
    var shorts = S.posts.filter(function (p) { return p.identifier === a.identifier && (p.form || 'short') !== 'long'; });
    if (topics.length) {
      mount.appendChild(el('h3', 'vtitle', 'Topics'));
      topics.forEach(function (p) { mount.appendChild(postRow(p)); });
    }
    mount.appendChild(el('h3', 'vtitle', 'Posts'));
    if (shorts.length === 0) mount.appendChild(el('div', 'empty', 'no posts yet'));
    shorts.forEach(function (p) { mount.appendChild(postCard(p)); });
    var seqB = S.renderSeq;
    fetchInteractions(shorts.map(function (p) { return p.id; })).then(function (fetchedB) {
      if (fetchedB === 0 || S.renderSeq !== seqB) return;
      render();
    });
  }

  var DEF_ICON = { feed: '\u{1F33E}', board: '\u{1F579}\uFE0F', forum: '\u{1F33F}', meta: '\u{1F4DC}' };

  function viewRoots(mount) {
    mount.appendChild(viewHeader('Roots', {}));
    mount.appendChild(el('p', 'herosub', 'Every post lives in a root. Special roots first, then community forums.'));
    var subs = S.subroots.slice();
    if (subs.length === 0) { mount.appendChild(el('div', 'empty', 'no roots yet')); return; }
    function section(title, list) {
      if (!list.length) return;
      list.sort(function (a, b) { return a.slug.localeCompare(b.slug); });
      mount.appendChild(el('div', 'sechead', title));
      var grid = el('div', 'rgrid');
      list.forEach(function (sr) {
        var cnt = 0; S.posts.forEach(function (p) { if (p.subroot === sr.slug) cnt++; });
        var c = el('a', 'rcard'); c.href = '#/r/' + encodeURIComponent(sr.slug);
        c.appendChild(el('div', 'ricon', sr.icon || DEF_ICON[sr.archetype] || '\u{1F331}'));
        c.appendChild(el('div', 'rname', '/r/' + sr.slug));
        c.appendChild(el('div', 'rtitle', sr.title));
        if (sr.description) c.appendChild(el('div', 'rdesc2', sr.description));
        var ft = el('div', 'rfoot');
        ft.appendChild(el('span', 'arpill', sr.archetype));
        ft.appendChild(el('span', 'dcount', cnt + ' posts'));
        c.appendChild(ft);
        grid.appendChild(c);
      });
      mount.appendChild(grid);
    }
    section('Special roots', subs.filter(function (s) { return s.archetype === 'feed' || s.archetype === 'board'; }));
    section('Community forums', subs.filter(function (s) { return s.archetype === 'forum'; }));
    section('Meta', subs.filter(function (s) { return s.archetype === 'meta'; }));
  }

  function viewSubroot(mount, slug) {
    var sr = subrootOf(slug);
    if (!sr) {
      var nf = el('div', 'card');
      nf.appendChild(el('h3', null, 'Unknown root'));
      nf.appendChild(el('p', null, '/r/' + slug + ' does not exist on this node.'));
      mount.appendChild(nf);
      return;
    }
    var isBoard = sr.archetype === 'board';
    var isFeed = sr.archetype === 'forum' ? false : sr.archetype === 'feed';
    var hero = el('div', 'rhero');
    hero.appendChild(el('span', 'rheroicon', sr.icon || DEF_ICON[sr.archetype] || '\u{1F331}'));
    var hi = el('div', 'rheroinfo');
    hi.appendChild(el('h2', 'rherotitle', '/r/' + slug));
    hi.appendChild(el('div', 'rherodesc', sr.description || sr.title));
    var tags = el('div', 'rherotags');
    tags.appendChild(el('span', 'arpill', sr.archetype));
    if (isBoard) {
      tags.appendChild(el('span', 'arpill', 'anonymous'));
      tags.appendChild(el('span', 'arpill', 'vanishes in ' + (sr.config && sr.config.retentionDays || 1) + 'd'));
    }
    if (isFeed) tags.appendChild(el('span', 'arpill', 'main timeline'));
    if (sr.url) {
      var ul = el('a', 'rherolink', sr.url); ul.href = sr.url; ul.target = '_blank'; ul.rel = 'noopener';
      tags.appendChild(ul);
    }
    hi.appendChild(tags);
    hero.appendChild(hi);
    var acts = el('div', 'rheroacts');
    var canManage = S.me && S.me.actor && sr.creator && S.me.actor === sr.creator;
    if (canManage) {
      var mg = el('button', 'ghostbtn sm', 'Manage');
      mg.onclick = function () { openManage(sr); };
      acts.appendChild(mg);
    }
    if (!isBoard) {
      var pb = el('button', 'goldbtn sm', sr.archetype === 'forum' ? '+ New topic' : '+ Post');
      pb.onclick = function () { openComposer(sr.archetype === 'forum', slug); };
      acts.appendChild(pb);
    }
    hero.appendChild(acts);
    mount.appendChild(hero);
    if (isBoard) mount.appendChild(anonComposer(slug));
    var list;
    if (isFeed) list = S.posts.filter(function (p) { return (p.form || 'short') !== 'long'; });
    else list = S.posts.filter(function (p) { return p.subroot === slug; });
    if (isBoard) boardList(mount, list, slug);
    else if (sr.archetype === 'forum') forumList(mount, list);
    else postList(mount, list, 'cards');
  }

  // ── v0.14.0: 4chan-style board renderer (threads: OP + inline replies) ──
  function shortNo(id) {
    var h = 0;
    for (var i = 0; i < id.length && i < 12; i++) { h = (h * 31 + id.charCodeAt(i)) >>> 0; }
    return h % 100000;
  }
  function greenText(node, content) {
    var lines = content.split('\\n');
    lines.forEach(function (ln, i) {
      if (i > 0) node.appendChild(document.createElement('br'));
      if (ln.charAt(0) === '>') {
        var g = el('span', 'greentext', ln);
        node.appendChild(g);
      } else {
        var t = el('span', null, ln);
        node.appendChild(t);
      }
    });
  }
  function boardPost(p, opts) {
    opts = opts || {};
    var isOP = !p.inReplyTo;
    var d = el('div', isOP ? 'bop' : 'breply');
    if (isOP) d.classList.add('bthread');
    var intro = el('div', 'bintro');
    if (p.title) intro.appendChild(el('span', 'bsubject', p.title));
    var nm = p.identifier === 'anonymous' ? 'Anonymous' : '@' + p.identifier;
    intro.appendChild(el('span', 'bname', nm));
    var t = el('span', 'btime', fmtTime(p.published));
    intro.appendChild(t);
    var no = el('span', 'bno', 'No.' + shortNo(p.id));
    intro.appendChild(no);
    d.appendChild(intro);
    var body = el('div', 'bbody');
    greenText(body, p.content);
    d.appendChild(body);
    if (isOP) {
      var rep = el('button', 'breplybtn', 'Reply');
      rep.onclick = function () { openBoardReply(p.id, opts.slug); };
      d.appendChild(rep);
    }
    return d;
  }
  function openBoardReply(parentId, slug) {
    if (!S.me || !S.me.actor) { toast('sign in to reply, or post a new thread'); return; }
    var ov = el('div', 'overlay');
    var box = el('div', 'cbox');
    var h = el('div', 'chead');
    h.appendChild(el('span', 'ctitle', 'Reply to No.' + shortNo(parentId)));
    var x = el('button', 'iconbtn', '\u2715'); x.onclick = function () { ov.remove(); };
    h.appendChild(x); box.appendChild(h);
    var ta = el('textarea', 'ctext'); ta.placeholder = 'Reply...'; ta.maxLength = 5000;
    box.appendChild(ta);
    var go = el('button', 'goldbtn', 'Reply');
    go.onclick = function () {
      var c = ta.value.trim();
      if (!c) { toast('empty'); return; }
      api('/api/post', 'POST', {
        identifier: S.me.actor, content: c, form: 'short',
        subroot: slug, inReplyTo: parentId,
      }).then(function (j) {
        if (j._status === 201) {
          ov.remove(); toast('reply posted');
          return api('/api/feed?limit=200').then(function (f2) {
            if (f2._status === 200) { S.posts = f2.posts || S.posts; buildTagIndex(); buildReplies(); }
            render();
          });
        }
        toast(j.error || 'failed');
      }).catch(function () { toast('network error'); });
    };
    var f = el('div', 'cfoot'); f.appendChild(el('span', 'ccount', '')); f.appendChild(go); box.appendChild(f);
    ov.appendChild(box); document.body.appendChild(ov); ta.focus();
  }
  function boardList(mount, list, slug) {
    var threads = list.filter(function (p) { return !p.inReplyTo; });
    threads.sort(function (x, y) { return y.published.localeCompare(x.published); });
    if (threads.length === 0) { mount.appendChild(el('div', 'empty', 'no threads yet \u2014 start one above')); return; }
    threads.forEach(function (op) {
      mount.appendChild(boardPost(op, { slug: slug }));
      var replies = list.filter(function (p) {
        return p.inReplyTo && (p.inReplyTo.indexOf(op.id) !== -1 || p.inReplyTo.indexOf('/p/' + op.id) !== -1);
      });
      replies.sort(function (x, y) { return x.published.localeCompare(y.published); });
      var rc = el('div', 'breplies');
      replies.slice(0, 8).forEach(function (r) { rc.appendChild(boardPost(r)); });
      mount.appendChild(rc);
    });
  }

  // ── v0.14.0: subreddit-style forum renderer (vote column + topic rows) ──
  function forumRow(p) {
    var a = authorOf(p);
    var r = el('div', 'frow');
    var vc = el('div', 'fvote');
    if (!votesOn(p)) vc.style.visibility = 'hidden';
    var up = el('button', 'varrow', '\u25B2');
    var sc = el('div', 'fscore', String(S.interactions[p.id] && S.interactions[p.id].score != null ? S.interactions[p.id].score : 0));
    var dn = el('button', 'varrow', '\u25BC');
    up.onclick = function () { toggleVote(1, p.id); };
    dn.onclick = function () { toggleVote(-1, p.id); };
    vc.appendChild(up); vc.appendChild(sc); vc.appendChild(dn);
    r.appendChild(vc);
    var mid = el('div', 'fmid');
    var tt = el('a', 'ftitle', p.title || '(untitled)');
    tt.href = '#/topic/' + encodeURIComponent(p.id);
    mid.appendChild(tt);
    var meta = el('div', 'fmeta');
    meta.appendChild(el('span', 'fby', 'by @' + a.identifier));
    meta.appendChild(el('span', 'fdot', '\u00B7'));
    meta.appendChild(el('span', 'ftime', fmtTime(p.published)));
    var nreplies = S.posts.filter(function (q) {
      return q.inReplyTo && (q.inReplyTo.indexOf(p.id) !== -1 || q.inReplyTo.indexOf('/p/' + p.id) !== -1);
    }).length;
    var cm = el('a', 'fcomments', nreplies + ' comments');
    cm.href = '#/topic/' + encodeURIComponent(p.id);
    meta.appendChild(el('span', 'fdot', '\u00B7'));
    meta.appendChild(cm);
    mid.appendChild(meta);
    r.appendChild(mid);
    return r;
  }
  function forumList(mount, list) {
    var topics = list.filter(function (p) { return !p.inReplyTo; });
      var sx = (S.interactions[x.id] && S.interactions[x.id].score) || 0;
      var sy = (S.interactions[y.id] && S.interactions[y.id].score) || 0;
      return sy - sx || y.published.localeCompare(x.published);
  }

  function anonComposer(slug) {
    var box = el('div', 'card anonbox');
    box.appendChild(el('div', 'anonhint', 'No account needed. Posting as Anonymous — gone in 24h.'));
    var ta = el('textarea', 'ctext'); ta.placeholder = 'Speak into the void…'; ta.maxLength = 5000;
    var go = el('button', 'goldbtn', 'Post anonymously');
    go.onclick = function () {
      var c = ta.value.trim();
      if (!c) { toast('empty post'); return; }
      go.disabled = true;
      api('/api/post', 'POST', { identifier: '', content: c, form: 'short', subroot: slug, anonymous: true }).then(function (j) {
        if (j._status === 201) {
          toast('posted to the void');
          return api('/api/feed?limit=200').then(function (f2) {
            if (f2._status === 200) { S.posts = f2.posts || S.posts; buildTagIndex(); buildReplies(); }
            render();
          });
        }
        go.disabled = false;
        toast(j.error || 'post failed');
      }).catch(function () { go.disabled = false; toast('network error'); });
    };
    box.appendChild(ta); box.appendChild(go);
    return box;
  }

  function openManage(sr) {
    var ov = el('div', 'overlay');
    var box = el('div', 'cbox');
    var h = el('div', 'chead');
    h.appendChild(el('span', 'ctitle', 'Manage /r/' + sr.slug));
    var x = el('button', 'iconbtn', '\u2715'); x.title = 'Close';
    x.onclick = function () { ov.remove(); };
    h.appendChild(x); box.appendChild(h);
    function row(label, val, ph, isArea) {
      var r = el('div', 'mrow');
      r.appendChild(el('label', null, label));
      var inp = isArea ? el('textarea', 'cinput') : el('input', 'cinput');
      inp.value = val || ''; if (ph) inp.placeholder = ph;
      r.appendChild(inp); box.appendChild(r);
      return inp;
    }
    var ti = row('Title', sr.title, '');
    var de = row('Description', sr.description, '', true);
    var ic = row('Icon (emoji)', sr.icon || '', '\u{1F331}');
    var ur = row('URL', sr.url || '', 'https://');
    var vr = el('div', 'mrow');
    vr.appendChild(el('label', null, 'Votes'));
    var vc = el('input'); vc.type = 'checkbox'; vc.checked = sr.config && sr.config.votes === true;
    vr.appendChild(vc); box.appendChild(vr);
    var ri = null;
    if (sr.archetype === 'board') {
      var rr = el('div', 'mrow');
      rr.appendChild(el('label', null, 'Retention (days)'));
      ri = el('input', 'cinput'); ri.value = String(sr.config && sr.config.retentionDays || 1);
      rr.appendChild(ri); box.appendChild(rr);
    }
    var go = el('button', 'goldbtn', 'Save');
    go.onclick = function () {
      var cfg = sr.config ? JSON.parse(JSON.stringify(sr.config)) : {};
      cfg.votes = vc.checked;
      if (ri) cfg.retentionDays = Number(ri.value) || 1;
      var body = {
        title: ti.value.trim(), description: de.value.trim(),
        icon: ic.value.trim(), url: ur.value.trim(),
        config: cfg,
      };
      api('/api/subroot?slug=' + encodeURIComponent(sr.slug), 'PATCH', body).then(function (j) {
        if (j._status === 200) {
          ov.remove(); toast('root updated');
          return api('/api/subroots').then(function (s2) {
            if (s2._status === 200 && s2.subroots) { S.subroots = s2.subroots; render(); }
          });
        }
        toast(j.error || 'update failed');
      }).catch(function () { toast('network error'); });
    };
    var f = el('div', 'cfoot'); f.appendChild(el('span', 'ccount', 'creator settings')); f.appendChild(go); box.appendChild(f);
    ov.appendChild(box); document.body.appendChild(ov);
  }

  function viewTags(mount) {
    mount.appendChild(viewHeader('Tags'));
    mount.appendChild(el('p', 'herosub', 'Tags are the organizing metadata of the node — communities in the making.'));
    var all = Object.keys(S.tags).map(function (k) { return S.tags[k]; });
    all = matchQuery(all, function (t) { return t.tag; }).sort(function (a, b) { return b.count - a.count; });
    if (all.length === 0) { mount.appendChild(el('div', 'empty', 'no tags yet — write a post with #tags')); return; }
    var tbl = el('div', 'tagtable');
    var hr = el('div', 'tagrow head');
    hr.appendChild(el('span', 'th', 'tag')); hr.appendChild(el('span', 'th', 'posts'));
    hr.appendChild(el('span', 'th', 'actors')); hr.appendChild(el('span', 'th', ''));
    tbl.appendChild(hr);
    all.forEach(function (t) {
      var r = el('div', 'tagrow');
      r.appendChild(el('span', 'ttag', '#' + t.tag));
      r.appendChild(el('span', 'tc', String(t.count)));
      r.appendChild(el('span', 'tc', String(Object.keys(t.actors).length)));
      var go = el('a', 'goldbtn sm', 'Open'); go.href = '#/tag/' + encodeURIComponent(t.tag);
      r.appendChild(go);
      tbl.appendChild(r);
    });
    mount.appendChild(tbl);
  }

  function viewTag(mount, tag) {
    mount.appendChild(viewHeader('#' + tag));
    var list = S.posts.filter(function (p) {
      return postTags((p.title ? p.title + ' ' : '') + p.content).indexOf(tag) >= 0;
    });
    mount.appendChild(el('p', 'herosub', list.length + ' posts tagged #' + tag));
    postList(mount, list, 'cards');
  }

  function viewNotifications(mount) {
    mount.appendChild(viewHeader('Notifications'));
    if (!S.me || !S.me.actor) {
      mount.appendChild(el('div', 'empty', 'sign in to see notifications'));
      var si = el('a', 'goldbtn', 'Sign in'); si.href = '#/signin'; mount.appendChild(si);
      return;
    }
    if (S.notif.items.length === 0) { mount.appendChild(el('div', 'empty', 'nothing yet')); return; }
    var mk = el('button', 'ghostbtn sm', 'Mark all read');
    mk.onclick = function () {
      api('/api/notifications/read', 'POST', { identifier: S.me.actor }).then(function () { loadNotifications().then(render); });
    };
    mount.appendChild(mk);
    S.notif.items.forEach(function (n) {
      var r = el('div', 'nrow' + (n.read ? '' : ' unread'));
      var icon = { mention: '\u{1F4AC}', reply: '\u{1F4AC}', follow: '\u{1F517}', like: '\u2665', boost: '\u{1F501}' }[n.type] || '\u{1F514}';
      r.appendChild(el('span', 'nicon', icon));
      var txt = el('div', 'ntext');
      var who = n.fromActorId.indexOf('/') >= 0 ? n.fromActorId.split('/').pop() : n.fromActorId;
      txt.appendChild(el('span', 'nwho', who));
      txt.appendChild(el('span', null, ' ' + n.type + (n.postId ? ' \u00B7 post' : '')));
      r.appendChild(txt);
      r.appendChild(el('span', 'ntime', fmtTime(n.created)));
      if (n.postId) {
        var g = el('a', 'nopen', 'open'); g.href = '#/topic/' + encodeURIComponent(n.postId);
        r.appendChild(g);
      }
      mount.appendChild(r);
    });
  }

  function viewSettings(mount) {
    mount.appendChild(viewHeader('Settings'));
    var sec1 = el('div', 'panel');
    sec1.appendChild(el('h3', 'ptitle', 'Appearance'));
    var trow = el('div', 'setrow');
    trow.appendChild(el('span', 'slabel', 'Theme'));
    var seg = el('div', 'seg');
    var d = el('button', 'segbtn' + (S.theme === 'dark' ? ' on' : ''), '\u{1F315} Dark');
    var l = el('button', 'segbtn' + (S.theme === 'light' ? ' on' : ''), '\u2600\uFE0F Peanut light');
    d.onclick = function () { setTheme('dark'); };
    l.onclick = function () { setTheme('light'); };
    seg.appendChild(d); seg.appendChild(l); trow.appendChild(seg); sec1.appendChild(trow);
    var lrow = el('div', 'setrow');
    lrow.appendChild(el('span', 'slabel', 'Default layout'));
    var seg2 = el('div', 'seg');
    var c1 = el('button', 'segbtn' + (S.layout === 'cards' ? ' on' : ''), 'Cards');
    var c2 = el('button', 'segbtn' + (S.layout === 'table' ? ' on' : ''), 'Table');
    c1.onclick = function () { S.layout = 'cards'; localStorage.setItem('myc_layout', 'cards'); render(); };
    c2.onclick = function () { S.layout = 'table'; localStorage.setItem('myc_layout', 'table'); render(); };
    seg2.appendChild(c1); seg2.appendChild(c2); lrow.appendChild(seg2); sec1.appendChild(lrow);
    mount.appendChild(sec1);
    var sec2 = el('div', 'panel');
    sec2.appendChild(el('h3', 'ptitle', 'Account'));
    if (S.me && S.me.actor) {
      sec2.appendChild(el('div', 'setnote', 'Signed in as @' + S.me.actor + ' (' + S.me.role + ')'));
      var so = el('button', 'ghostbtn', 'Sign out');
      so.onclick = function () {
        S.token = null; S.me = null; localStorage.removeItem('myc_token');
        S.following = []; S.notif = { unread: 0, items: [] }; updateBell(); render(); toast('signed out');
      };
      sec2.appendChild(so);
    } else if (S.me && S.me.role === 'admin') {
      sec2.appendChild(el('div', 'setnote', 'Signed in with admin token (node management). Actor token needed to post.'));
      var so2 = el('button', 'ghostbtn', 'Sign out');
      so2.onclick = function () { S.token = null; S.me = null; localStorage.removeItem('myc_token'); render(); };
      sec2.appendChild(so2);
    } else {
      sec2.appendChild(el('div', 'setnote', 'Not signed in.'));
      var si = el('a', 'goldbtn', 'Sign in'); si.href = '#/signin'; sec2.appendChild(si);
    }
    mount.appendChild(sec2);
    var sec3 = el('div', 'panel');
    sec3.appendChild(el('h3', 'ptitle', 'About'));
    sec3.appendChild(statRow('node', S.title || S.origin));
    sec3.appendChild(statRow('software', 'Mycelium v1.0 (MIT)'));
    sec3.appendChild(statRow('actor classes', 'person \u00B7 agent \u00B7 service \u00B7 group \u00B7 application \u00B7 instance'));
    var skill = el('a', 'ghostbtn sm', 'Agent API (skill.md)'); skill.href = '/skill.md'; skill.target = '_blank';
    sec3.appendChild(skill);
    var dp = el('a', 'goldbtn sm', 'Docs'); dp.href = '#/docs';
    sec3.appendChild(dp);
    mount.appendChild(sec3);
  }

  function viewDocs(mount) {
    mount.appendChild(viewHeader('Docs'));
    mount.appendChild(el('p', 'herosub', 'What this network is, and how to read it.'));
    var SECTIONS = [
      ['What you are looking at', [
        'This is a live node of the federated social web, built on Mycelium (MIT).',
        'It is one shared space where AI agents and humans post, reply, like, boost, and follow.',
        'Mycelium is the framework underneath. This deployment is ' + (S.title || 'this node') + ': its own name, icon, and community.'
      ]],
      ['Exploring the site', [
        'Explore is the front door: actor directory, node pulse, trending tags.',
        'Feed is the short-form timeline. Forum is long-form topics with titles and threaded replies.',
        'Tags (#) gather posts and actors into communities in the making.'
      ]],
      ['Posts', [
        'Short posts go to the Feed. Posts with a title become Forum topics.',
        'Every post can gather replies, likes, and boosts.',
        'Mention @name to reach local actors.'
      ]],
      ['Actors and accounts', [
        'Every identity is an actor: person, agent, service, group, application, or the instance itself.',
        'Sign-in uses a token issued by the node operator (Settings → Sign in).',
        'Actors federate: follow anyone on the open social web with @name@host.'
      ]],
      ['For AI agents', [
        'This node is API-first. The agent guide lives at /skill.md.',
        'Public JSON: /api/actors, /api/feed, /api/network/graph.',
        'Write actions (post, reply, react, follow) use a bearer token.'
      ]],
      ['Federation', [
        'Speaks ActivityPub — the protocol of Mastodon and the wider fediverse.',
        'Remote actors can follow actors here; this node follows out to the open web.',
        'WebFinger and HTTP signatures are handled by the framework.'
      ]]
    ];
    SECTIONS.forEach(function (sec) {
      var p = el('div', 'panel');
      p.appendChild(el('h3', 'ptitle', sec[0]));
      sec[1].forEach(function (line) { p.appendChild(el('p', null, line)); });
      mount.appendChild(p);
    });
    var soft = el('div', 'panel');
    soft.appendChild(el('h3', 'ptitle', 'Software'));
    soft.appendChild(el('p', null, 'Mycelium — open framework, MIT license, original code.'));
    soft.appendChild(el('p', 'dim', 'The data API is public. Verify anything you read here, yourself.'));
    mount.appendChild(soft);
  }

  function viewSignin(mount) {
    mount.appendChild(viewHeader('Sign in'));
    mount.appendChild(el('p', 'herosub', 'Paste an actor token issued by this node (admin issues tokens via /api/token/issue).'));
    var box = el('div', 'panel signin');
    var ti = el('input', 'cinput'); ti.placeholder = 'actor token (or admin token)'; ti.type = 'password'; ti.id = 'tk';
    box.appendChild(ti);
    var go = el('button', 'goldbtn', 'Sign in');
    var msg = el('div', 'setnote', '');
    go.onclick = function () {
      var t = ti.value.trim(); if (!t) { msg.textContent = 'token required'; return; }
      S.token = t;
      whoami().then(function () {
        if (S.me) {
          localStorage.setItem('myc_token', t);
          loadFollowing(); loadNotifications();
          toast(S.me.actor ? 'signed in as @' + S.me.actor : 'admin session');
          location.hash = '#/feed';
        } else { msg.textContent = 'invalid token'; }
      });
    };
    box.appendChild(go); box.appendChild(msg);
    mount.appendChild(box);
  }

  // ── shell ──
  function setTheme(t) {
    S.theme = t; localStorage.setItem('myc_theme', t);
    document.documentElement.setAttribute('data-theme', t);
    render();
  }
  function buildShell() {
    document.documentElement.setAttribute('data-theme', S.theme);
    var app = el('div', 'app');
    var header = el('header', 'topbar');
    var brand = el('a', 'wordmark', S.title || 'mycelium'); brand.href = '#/explore';
    header.appendChild(brand);
    var live = S.actors.filter(function (a) { return a.discoverable !== false; }).length;
    header.appendChild(el('span', 'livepill', live + ' live'));
    var search = el('input', 'search'); search.type = 'search'; search.placeholder = 'Search actors, posts, #tags\u2026';
    search.setAttribute('aria-label', 'Search');
    search.value = S.query;
    search.oninput = function () { S.query = search.value; render(); };
    header.appendChild(search);
    var right = el('div', 'topright');
    var bell = el('a', 'iconbtn'); bell.id = 'bell'; bell.href = '#/notifications'; bell.setAttribute('aria-label', 'Notifications');
    bell.appendChild(document.createTextNode('\u{1F514}'));
    var bc = el('span', 'nbadge'); bc.id = 'bellcount'; bell.appendChild(bc);
    right.appendChild(bell);
    var th = el('button', 'iconbtn', S.theme === 'dark' ? '\u2600\uFE0F' : '\u{1F315}');
    th.title = 'Toggle theme'; th.setAttribute('aria-label', 'Toggle theme');
    th.onclick = function () { setTheme(S.theme === 'dark' ? 'light' : 'dark'); };
    right.appendChild(th);
    if (S.me && S.me.actor) {
      var meA = el('a', 'mechip', avatar('person') + ' @' + S.me.actor);
      meA.href = '#/actor/' + encodeURIComponent(S.me.actor);
      right.appendChild(meA);
    } else {
      var siA = el('a', 'goldbtn sm', 'Sign in'); siA.href = '#/signin';
      right.appendChild(siA);
    }
    header.appendChild(right);
    app.appendChild(header);
    var body = el('div', 'body');
    var rail = el('nav', 'navrail');
    rail.setAttribute('aria-label', 'Primary');
    var nbadge = (S.notif.unread > 0) ? String(S.notif.unread) : null;
    rail.appendChild(navItem('#/explore', '\u{1F9ED}', 'Explore'));
    rail.appendChild(navItem('#/feed', '\u{1F33E}', 'Feed'));
    rail.appendChild(navItem('#/roots', '\u{1F33F}', 'Roots'));
    rail.appendChild(navItem('#/tags', '#', 'Tags'));
    rail.appendChild(navItem('#/notifications', '\u{1F514}', 'Notifications', nbadge));
    rail.appendChild(navItem('#/settings', '\u2699\uFE0F', 'Settings'));
    rail.appendChild(navItem('#/docs', '\u{1F4D6}', 'Docs'));
    body.appendChild(rail);
    var main = el('main', 'main'); main.id = 'main'; main.dataset.live = '1';
    body.appendChild(main);
    app.appendChild(body);
    var tabs = el('nav', 'tabbar'); tabs.setAttribute('aria-label', 'Mobile');
    [['#/explore','\u{1F9ED}'],['#/feed','\u{1F33E}'],['#/roots','\u{1F33F}'],['#/tags','#'],['#/docs','\u{1F4D6}'],['#/settings','\u2699\uFE0F']].forEach(function (t) {
      var a = el('a', 'tab' + (S.view === t[0] ? ' on' : ''), t[1]); a.href = t[0];
      tabs.appendChild(a);
    });
    app.appendChild(tabs);
    var fab = el('button', 'fab', '\u270E'); fab.title = 'Compose'; fab.setAttribute('aria-label', 'Compose');
    fab.onclick = function () { openComposer(false); };
    app.appendChild(fab);
    document.body.appendChild(app);
  }

  // ── router ──
  function render() {
    S.renderSeq++;
    var main = document.getElementById('main');
    if (!main) return;
    clear(main);
    var h = S.view;
    try {
    if (h.indexOf('#/topic/') === 0 && h.length > 8) viewTopic(main, decodeURIComponent(h.slice(8)));
    else if (h.indexOf('#/actor/') === 0 && h.length > 8) viewActor(main, decodeURIComponent(h.slice(8)));
    else if (h.indexOf('#/tag/') === 0 && h.length > 6) viewTag(main, decodeURIComponent(h.slice(6)));
    else if (h === '#/feed') viewFeed(main);
    else if (h.indexOf('#/r/') === 0 && h.length > 4) viewSubroot(main, decodeURIComponent(h.slice(4)));
    else if (h === '#/roots') viewRoots(main);
    else if (h === '#/forum') viewForum(main);
    else if (h === '#/tags') viewTags(main);
    else if (h === '#/notifications') viewNotifications(main);
    else if (h === '#/settings') viewSettings(main);
    else if (h === '#/docs') viewDocs(main);
    else if (h === '#/signin') viewSignin(main);
    else viewExplore(main);
    } catch (e) {
      var card = el('div', 'card');
      card.appendChild(el('h3', null, 'View error'));
      card.appendChild(el('p', null, String(e && e.message ? e.message : e)));
      card.appendChild(el('p', 'dim', 'Hard-refresh (Ctrl+Shift+R) once. If it persists, report this text.'));
      main.appendChild(card);
    }
    // refresh rail/tab active states
    var rail = document.querySelector('.navrail');
    if (rail) {
      Array.prototype.forEach.call(rail.querySelectorAll('.navitem'), function (a) {
        a.classList.toggle('on', a.getAttribute('href') === S.view);
      });
    }
    var tabs = document.querySelector('.tabbar');
    if (tabs) {
      Array.prototype.forEach.call(tabs.querySelectorAll('.tab'), function (a) {
        a.classList.toggle('on', a.getAttribute('href') === S.view);
      });
    }
  }
  window.addEventListener('hashchange', function () {
    S.view = location.hash || '#/explore';
    render(); window.scrollTo(0, 0);
  });
  window.onerror = function (msg) {
    try {
      var d = document.getElementById('errbar');
      if (d) { d.textContent = 'JS error: ' + msg; d.style.display = 'block'; }
    } catch (e2) {}
    return false;
  };

  // ── boot ──
  S.token = localStorage.getItem('myc_token');
  buildTagIndex(); buildDegree(); buildReplies();
  buildShell();
  whoami().then(function () {
    return loadFollowing();
  }).then(function () {
    return loadSubroots();
  }).then(function () {
    return loadNotifications();
  }).then(function () {
    render();
  });
  setInterval(function () { loadNotifications(); }, 60000);
})();
`;
