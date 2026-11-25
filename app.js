/* ---------- Google Drive: the clinic account keeps the DISPLAY COPIES (previews + thumbnails, never originals).
   Every device signs in once; new X-rays added anywhere show up everywhere within a minute. ---------- */
const XGD = (() => {
  const CLIENT = "177316097322-hqmo3pim5hsd1ii72vfemijkb5c3svg1.apps.googleusercontent.com";
  const SCOPE = "https://www.googleapis.com/auth/drive.file";   // only the files this app made, not the rest of the Drive
  const API = "https://www.googleapis.com/drive/v3/files", UP = "https://www.googleapis.com/upload/drive/v3/files";
  const ls = {
    get(k, d) { try { const v = localStorage.getItem("xr." + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem("xr." + k, JSON.stringify(v)); } catch (e) {} },
    del(k) { try { localStorage.removeItem("xr." + k); } catch (e) {} }
  };
  const ready = /^https?:$/.test(location.protocol) && !/__GD_/.test(CLIENT);
  const AR = {"أ": "ا", "إ": "ا", "آ": "ا", "ٱ": "ا", "ى": "ي", "ئ": "ي", "ؤ": "و", "ة": "ه"};
  const nk = s => (s || "").toLowerCase().replace(/[ً-ٰٟـ]/g, "").replace(/[أإآٱىئؤة]/g, c => AR[c]).replace(/\s+/g, " ").trim();
  const authErr = () => Object.assign(new Error("auth"), {auth: true});
  let S = null;          // what is on Drive: {root, imgF, idxKey, baseKey, base, base0, I, bimg, files: Map, phone: []}
  const api = {ready, on: () => ready && !!ls.get("gon"), S: () => S, email: () => ls.get("gmail", ""), onData: null, mode: ""};

  /* ---- sign in: a full-page trip to Google and back (no pop-ups, works in the installed app) */
  const tokRec = () => ls.get("gtok");
  const tok = () => { const t = tokRec(); return t && t.exp > Date.now() + 60000 ? t.t : ""; };
  api.minutesLeft = () => { const t = tokRec(); return t ? Math.floor((t.exp - Date.now()) / 60000) : 0; };
  api.auth = (interactive, backTo) => {
    const st = Math.random().toString(36).slice(2) + Date.now().toString(36);
    sessionStorage.setItem("xr.gst", JSON.stringify({st, hash: backTo !== undefined ? backTo : location.hash}));
    sessionStorage.setItem("xr.gtry", String(Date.now()));
    const p = new URLSearchParams({client_id: CLIENT, redirect_uri: location.origin + location.pathname.replace(/index\.html$/, ""),
      response_type: "token", scope: SCOPE, state: st, include_granted_scopes: "true", prompt: interactive ? "select_account" : "none"});
    const hint = ls.get("gmail"); if (hint) p.set("login_hint", hint);
    location.replace("https://accounts.google.com/o/oauth2/v2/auth?" + p);
    return new Promise(() => {});   // the page is leaving
  };
  api.canTrySilent = () => Date.now() - (+sessionStorage.getItem("xr.gtry") || 0) > 60000;
  api.takeReturn = () => {           // the answer from Google comes back in the address (#access_token=… or #error=…)
    const h = location.hash.slice(1);
    if (!/(^|&)(access_token|error)=/.test(h) || !/(^|&)state=/.test(h)) return null;
    const p = new URLSearchParams(h);
    let saved = {};
    try { saved = JSON.parse(sessionStorage.getItem("xr.gst")) || {}; } catch (e) {}
    history.replaceState(null, "", location.pathname + location.search + (saved.hash || ""));
    if (!saved.st || p.get("state") !== saved.st) return {error: "state"};
    if (p.get("access_token")) {
      ls.set("gtok", {t: p.get("access_token"), exp: Date.now() + (+p.get("expires_in") || 3600) * 1000});
      ls.set("gon", 1);
      return {ok: true};
    }
    return {error: p.get("error") || "error"};
  };
  api.signOut = () => { ls.del("gtok"); ls.del("gon"); ls.del("groot"); ls.del("gmail"); };

  /* ---- Drive calls */
  async function f(url, opt) {
    const t = tok();
    if (!t) throw authErr();
    opt = Object.assign({}, opt || {});
    opt.headers = Object.assign({Authorization: "Bearer " + t}, opt.headers || {});
    const r = await fetch(url, opt);
    if (r.status === 401) { ls.del("gtok"); throw authErr(); }
    if (!r.ok) throw new Error("Drive " + r.status);
    return r;
  }
  async function list(q, fields) {
    let out = [], page = "";
    do {
      const p = new URLSearchParams({q, fields: "nextPageToken,files(" + fields + ")", pageSize: "1000", spaces: "drive"});
      if (page) p.set("pageToken", page);
      const j = await (await f(API + "?" + p)).json();
      out = out.concat(j.files || []); page = j.nextPageToken || "";
    } while (page);
    return out;
  }
  async function range(id, a, b) {
    const ac = new AbortController();
    const r = await f(`${API}/${id}?alt=media`, {headers: {Range: `bytes=${a}-${b}`}, signal: ac.signal});
    if (r.status !== 206) { ac.abort(); throw new Error("range"); }
    return r.arrayBuffer();
  }
  let running = 0; const waiting = [];
  function queue(fn) {   // at most 6 downloads at a time
    return new Promise((ok, bad) => {
      const go = () => { running++; fn().then(ok, bad).finally(() => { running--; if (waiting.length) waiting.shift()(); }); };
      running < 6 ? go() : waiting.push(go);
    });
  }

  /* ---- small cache of the index (works with no internet) */
  const META = "https://xr.cache/meta/";
  let metaC = null;
  const metaCache = () => metaC || (metaC = (self.caches ? caches.open("xr-meta") : Promise.reject()).catch(() => null));
  async function cached(key, make) {
    const c = await metaCache();
    if (c) { const r = await c.match(META + key); if (r) return r.json(); }
    if (!make) return null;
    const v = await make();
    if (c) {
      const pre = META + key.split(":")[0] + ":";
      for (const k of await c.keys()) if (k.url.startsWith(pre) && k.url !== META + key) c.delete(k);
      await c.put(META + key, new Response(JSON.stringify(v), {headers: {"Content-Type": "application/json"}}));
    }
    return v;
  }

  /* ---- read what is on Drive */
  async function load() {
    let root = ls.get("groot");
    if (!root) {
      const r = await list("appProperties has { key='xr' and value='root' } and trashed=false", "id");
      if (!r.length) throw Object.assign(new Error("noroot"), {noroot: true});
      root = r[0].id; ls.set("groot", root);
    }
    let kids;
    try { kids = await list(`'${root}' in parents and trashed=false`, "id,name,modifiedTime,appProperties"); }
    catch (e) { if (/ 404/.test(e.message)) ls.del("groot"); throw e; }
    const by = v => kids.find(k => k.appProperties && k.appProperties.xr === v);
    const idx = by("index"), imgF = by("img");
    if (!idx || !imgF) throw Object.assign(new Error("noroot"), {noroot: true});
    const idxKey = "idx:" + idx.id + ":" + idx.modifiedTime;
    const I = await cached(idxKey, async () => (await f(`${API}/${idx.id}?alt=media`)).json());
    let bimg = {}, base0 = 0, baseKey = "";
    if (I.base) {
      baseKey = "base:" + I.base;
      const h = await cached(baseKey, async () => {
        const head = new Uint8Array(await range(I.base, 0, 11));
        if (new TextDecoder().decode(head.slice(0, 8)) !== "XRPACK1\n") throw new Error("base");
        const n = new DataView(head.buffer).getUint32(8, true);
        const j = JSON.parse(new TextDecoder().decode(await range(I.base, 12, 12 + n - 1)));
        return {img: j.img, base0: 12 + n};
      });
      bimg = h.img; base0 = h.base0;
    }
    const fl = await list(`'${imgF.id}' in parents and trashed=false`, "id,name,description,appProperties");
    const files = [], phone = [];
    for (const x of fl) {
      const [id, k] = x.name.split(".");
      files.push([id + "." + k, x.id]);
      if (x.appProperties && x.appProperties.o === "m" && k === "p" && x.description) {
        try { phone.push(Object.assign(JSON.parse(x.description), {id})); } catch (e) {}
      }
    }
    const st = {root, imgF: imgF.id, idxKey, baseKey, base: I.base || "", base0, files, phone, at: Date.now()};
    const c = await metaCache();
    if (c) c.put(META + "state", new Response(JSON.stringify(st), {headers: {"Content-Type": "application/json"}})).catch(() => {});
    return Object.assign(st, {I, bimg, files: new Map(files)});
  }
  async function loadCached() {
    const st = await cached("state");
    if (!st) return null;
    const I = await cached(st.idxKey);
    const h = st.baseKey ? await cached(st.baseKey) : {img: {}};
    if (!I || !h) return null;
    return Object.assign(st, {I, bimg: h.img, files: new Map(st.files), stale: true});
  }

  /* ---- the archive = index from the clinic PC + what was added from phones */
  function merge(D0) {
    const D = JSON.parse(JSON.stringify(D0));
    if (!S || !S.phone.length) return D;
    const by = new Map(D.patients.map(p => [nk(p.n) + "|" + p.y, p]));
    for (const r of S.phone.slice().sort((a, b) => (a.at || "").localeCompare(b.at || ""))) {
      const k = nk(r.n) + "|" + r.y;
      let p = by.get(k);
      if (!p) {
        let h = 0; for (const ch of k) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
        p = {i: "m" + h.toString(16), y: r.y, c: "", n: r.n, f: []};
        by.set(k, p);
        let at = D.patients.findIndex(q => q.y === r.y && q.n.localeCompare(r.n, "ar") > 0);
        if (at < 0) { const lastSame = D.patients.map(q => q.y).lastIndexOf(r.y); at = lastSame >= 0 ? lastSame + 1 : D.patients.findIndex(q => /^\d+$/.test(q.y) && q.y < r.y); }
        at < 0 ? D.patients.push(p) : D.patients.splice(at, 0, p);
      }
      // [rel, type, size, date, sub, w, h, imageId, hasPreview, addedOnDrive]
      p.f.push(["📱/" + (r.fn || "صورة.jpg"), "i", r.s || 0, r.d || "", "", r.w || 0, r.h || 0, r.id, 1, 1]);
      if (!D.years.includes(r.y)) { D.years.push(r.y); D.years.sort((a, b) => (/^\d+$/.test(b) - /^\d+$/.test(a)) || b.localeCompare(a)); }
    }
    return D;
  }
  api.data = local => merge(local || S.I.data);
  api.ignore = () => (S && S.I && S.I.ignore) || [];
  api.stale = () => !S || !!S.stale;
  api.has = id => !!S && (!!S.bimg[id] || S.files.has(id + ".t") || S.files.has(id + ".p"));
  const sig = () => S ? [S.idxKey, S.files.length || S.files.size, S.phone.map(r => r.id).join()].join("|") : "";

  /* start-up: returns false when the page is going to Google for a fresh sign-in */
  api.boot = async (ret, lite) => {
    if (ret && ret.error && !tok() && !lite) throw Object.assign(new Error(ret.error), {auth: true, need: true});
    if (!tok()) {
      if (navigator.onLine && api.canTrySilent() && !(ret && ret.error)) return api.auth(false);
      S = await loadCached();
      if (S) return true;
      throw Object.assign(new Error("auth"), {auth: true, need: true});
    }
    try {
      S = await load();
      if (!ls.get("gmail")) f("https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)").then(r => r.json()).then(j => ls.set("gmail", j.user.emailAddress)).catch(() => {});
    } catch (e) {
      if (e.noroot) throw e;
      S = await loadCached();
      if (!S) throw e;
    }
    return true;
  };
  /* check Drive for news (called every minute) */
  api.poll = async () => {
    if (!tok() || !navigator.onLine) return false;
    const before = sig();
    try { S = await load(); } catch (e) { return false; }
    if (sig() !== before && api.onData) api.onData();
    return true;
  };

  /* ---- pictures: object URLs, from the device cache first, then from Drive */
  const mem = new Map();
  let imgC = null;
  const imgCache = () => imgC || (imgC = (self.caches ? caches.open("xr-img") : Promise.reject()).catch(() => null));
  async function fetchImg(id, k) {
    const b = S.bimg[id];
    if (b) {
      let [o, l] = k === "t" ? [b[2], b[3]] : [b[0], b[1]];
      if (!l) [o, l] = k === "t" ? [b[0], b[1]] : [b[2], b[3]];
      const start = S.base0 + o;
      return new Blob([await queue(() => range(S.base, start, start + l - 1))], {type: "image/webp"});
    }
    const fid = S.files.get(id + "." + k) || S.files.get(id + "." + (k === "t" ? "p" : "t"));
    if (!fid) throw new Error("missing");
    return queue(async () => (await f(`${API}/${fid}?alt=media`)).blob());
  }
  api.url = (id, k) => {
    const key = id + "." + k;
    let p = mem.get(key);
    if (p) return p;
    p = (async () => {
      const c = await imgCache(), ck = "https://xr.cache/img/" + key;
      const hit = c && await c.match(ck);
      const blob = hit ? await hit.blob() : await fetchImg(id, k);
      if (c && !hit) c.put(ck, new Response(blob, {headers: {"Content-Type": blob.type || "image/webp"}})).catch(() => {});
      return URL.createObjectURL(blob);
    })();
    mem.set(key, p);
    p.catch(e => { mem.delete(key); if (e && e.auth && api.onAuthLost) api.onAuthLost(); });
    return p;
  };

  /* ---- adding / removing (phones, tablets, any PC) */
  api.upload = async (meta, blob) => {
    meta = Object.assign({parents: [S.imgF]}, meta);
    const b = "xrb" + Math.random().toString(36).slice(2);
    const body = new Blob([`--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`, JSON.stringify(meta),
      `\r\n--${b}\r\nContent-Type: ${blob.type || "image/jpeg"}\r\n\r\n`, blob, `\r\n--${b}--`]);
    const r = await f(UP + "?uploadType=multipart&fields=id", {method: "POST", headers: {"Content-Type": "multipart/related; boundary=" + b}, body});
    return (await r.json()).id;
  };
  api.remove = async id => {
    for (const k of ["p", "t"]) {
      const fid = S.files.get(id + "." + k);
      if (fid) await f(`${API}/${fid}?fields=id`, {method: "PATCH", headers: {"Content-Type": "application/json"}, body: JSON.stringify({trashed: true})});
    }
  };
  return api;
})();

function startApp() {
"use strict";
const D = window.XDATA;
const $ = s => document.querySelector(s);
if (!D) {
  document.body.innerHTML = '<p style="padding:30px;font-family:Tahoma">ملف data.js مش موجود — شغّل «rebuild.bat» الأول.</p>';
  return;
}

/* ---------- helpers ---------- */
const AR = {"أ":"ا","إ":"ا","آ":"ا","ٱ":"ا","ى":"ي","ئ":"ي","ؤ":"و","ة":"ه"};
const norm = s => (s || "").toLowerCase()
  .replace(/[ً-ٰٟـ]/g, "")
  .replace(/[أإآٱىئؤة]/g, c => AR[c])
  .replace(/[٠-٩]/g, d => d.charCodeAt(0) - 1632)
  .replace(/[۰-۹]/g, d => d.charCodeAt(0) - 1776)
  .replace(/\s+/g, " ").trim();
const num = n => String(n).replace(/\d/g, d => "٠١٢٣٤٥٦٧٨٩"[d]);
const fmtSize = b => b > 1048576 ? (b / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(b / 1024)) + " KB";
const esc = s => String(s).replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const VER = (D.built || "").replace(/\D/g, "");
const KIND = {p:"📄", v:"🎞️", a:"🗜️", o:"📎", i:"🖼️"};
const KIND_NAME = {p:"ملف PDF", v:"فيديو", a:"ملف مضغوط", o:"ملف"};
const store = {
  get(k, d) { try { const v = localStorage.getItem("xr." + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem("xr." + k, JSON.stringify(v)); } catch (e) {} }
};

// file record: [rel, type, size, date, sub, w, h, thumbId, hasPreview]
const F = {rel:0, t:1, s:2, d:3, sub:4, w:5, h:6, th:7, pv:8};
// Standalone mode: images are embedded inside this very file (window.XIMG = {t:{id:base64}, p:{id:base64}})
// Pack mode: images live in one big archive file and are read lazily, slice by slice (tiny memory use)
const PK = window.XPACK || null;
const pkCache = new Map();
const pkUrl = (id, k) => {
  const e = PK.img[id]; if (!e || !e[k + 1]) return "";
  const key = id + k; let u = pkCache.get(key);
  if (!u) { u = URL.createObjectURL(PK.file.slice(PK.base + e[k], PK.base + e[k] + e[k + 1], "image/webp")); pkCache.set(key, u); }
  return u;
};
const EMB = window.XIMG || (PK ? {t: {}, p: {}} : null);
const DU = "data:image/webp;base64,";
const thUrl = f => !f[F.th] ? "" : PK ? (pkUrl(f[F.th], 2) || pkUrl(f[F.th], 0)) : EMB
  ?(EMB.t[f[F.th]] ? DU + EMB.t[f[F.th]] : (EMB.p && EMB.p[f[F.th]] ? DU + EMB.p[f[F.th]] : ""))   // light edition: no thumbs, use previews
  : `thumbs/${f[F.th]}.webp?v=${VER}`;
const pvUrl = f => !(f[F.th] && f[F.pv]) ? "" : PK ? pkUrl(f[F.th], 0) : EMB ? (EMB.p && EMB.p[f[F.th]] ? DU + EMB.p[f[F.th]] : "") : `previews/${f[F.th]}.webp?v=${VER}`;
const origUrl = (f, dl) => "orig/" + f[F.rel].split("#")[0].split("/").map(encodeURIComponent).join("/") + (dl ? "?dl=1" : "");
const isPic = f => f[F.t] === "i" || f[F.t] === "g";   // g = a rendered PDF page
const baseName = f => f[F.rel].split("/").pop();

/* ---------- pictures kept on Google Drive ---------- */
const GDRIVE = window.XGD_MODE === "drive";            // whole archive from Drive (phones / tablets)
const GDON = GDRIVE || window.XGD_MODE === "merge";   // local archive + what was added from phones
const BLANK = "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";
const gdImg = f => GDON && !!f[F.th] && (GDRIVE || (f[9] === 1));
const thSrc = f => gdImg(f) ? `src="${BLANK}" data-gd="${f[F.th]}"` : `src="${thUrl(f)}"`;
const gdObs = "IntersectionObserver" in window ? new IntersectionObserver(es => {
  for (const e of es) if (e.isIntersecting) { gdObs.unobserve(e.target); gdLoad(e.target); }
}, {rootMargin: "400px"}) : null;
function gdLoad(im) {
  const id = im.dataset.gd; if (!id) return;
  delete im.dataset.gd;
  XGD.url(id, "t").then(u => { im.src = u; }).catch(() => { im.alt = "⚠"; im.classList.add("gderr"); });
}
function hydrate(box) { if (GDON) box.querySelectorAll("img[data-gd]").forEach(im => gdObs ? gdObs.observe(im) : gdLoad(im)); }

/* ---------- data prep ---------- */
let P = D.patients;
let byId = {};
let totalFiles = 0;
function ingest() {
  byId = {}; totalFiles = 0;
  for (const p of P) {
    byId[p.i] = p;
    totalFiles += p.f.length;
    p.nImg = p.f.filter(isPic).length;
    p.hay = norm([p.n, p.c, p.y, ...p.f.map(baseName)].join(" "));
    p.cover = p.f.find(f => f[F.th]) || null;
    p.last = p.f.reduce((m, f) => f[F.d] > m ? f[F.d] : m, "");
  }
}
ingest();

let serverOK = false;
const state = Object.assign({year: "all", q: "", sort: "name", origOn: true}, store.get("state", {}));
state.q = ""; // don't restore old search text
let shown = 60;
const PAGE = 60;

/* ---------- list view ---------- */
const el = {
  q: $("#q"), clr: $("#clr"), years: $("#years"), count: $("#count"), sort: $("#sort"),
  list: $("#list"), more: $("#more"), mode: $("#mode"), foot: $("#foot"),
};

function filtered(ignoreYear) {
  const toks = norm(state.q).split(" ").filter(Boolean);
  return P.filter(p => (ignoreYear || state.year === "all" || p.y === state.year) && toks.every(t => p.hay.includes(t)));
}

function sorted(arr) {
  const a = arr.slice();
  if (state.sort === "new") a.sort((x, y) => y.last.localeCompare(x.last));
  else if (state.sort === "old") a.sort((x, y) => x.last.localeCompare(y.last));
  else if (state.sort === "files") a.sort((x, y) => y.f.length - x.f.length);
  return a; // default order from build = year desc, name
}

function renderYears() {
  const base = filtered(true);
  const counts = {};
  for (const p of base) counts[p.y] = (counts[p.y] || 0) + 1;
  const mk = (key, label, n) => `<button type="button" data-y="${esc(key)}" class="${state.year === key ? "on" : ""}${n ? "" : " zero"}">${esc(label)}<small>${num(n)}</small></button>`;
  el.years.innerHTML = mk("all", "الكل", base.length) + D.years.map(y => mk(y, /^\d+$/.test(y) ? num(y) : y, counts[y] || 0)).join("");
}

function cardHTML(p) {
  const img = p.cover ? `<img loading="lazy" decoding="async" ${thSrc(p.cover)} alt="">` : `<span class="ph">${p.f[0] ? KIND[p.f[0][F.t]] : "🖼️"}</span>`;
  const parts = [/^\d+$/.test(p.y) ? num(p.y) : p.y];
  if (p.c) parts.push(p.c);
  const nImg = p.nImg ? `${num(p.nImg)} صورة` : "";
  const other = p.f.length - p.nImg;
  return `<button type="button" class="card" data-id="${p.i}">
    <div class="cover">${img}<span class="badge">${num(p.f.length)} ملف</span></div>
    <div class="meta"><div class="nm">${esc(p.n)}</div><div class="sm">${esc(parts.join(" · "))}${nImg ? " · " + nImg : ""}${other && p.nImg ? " + " + num(other) : ""}</div></div>
  </button>`;
}

let curList = [];
function renderList(reset) {
  if (reset) shown = PAGE;
  curList = sorted(filtered(false));
  renderYears();
  el.count.textContent = curList.length ? `${num(curList.length)} مريض/مجموعة` : "";
  if (!curList.length) {
    el.list.innerHTML = `<div class="empty">مفيش نتائج${state.q ? " للبحث «" + esc(state.q) + "»" : ""}</div>`;
    el.more.hidden = true;
    return;
  }
  const part = curList.slice(0, shown);
  el.list.innerHTML = part.map(cardHTML).join("");
  hydrate(el.list);
  el.more.hidden = shown >= curList.length;
}

el.q.addEventListener("input", () => {
  state.q = el.q.value;
  el.clr.hidden = !state.q;
  clearTimeout(el.q._t);
  el.q._t = setTimeout(() => renderList(true), 120);
});
el.clr.addEventListener("click", () => { el.q.value = ""; state.q = ""; el.clr.hidden = true; renderList(true); el.q.focus(); });
el.years.addEventListener("click", e => {
  const b = e.target.closest("button[data-y]"); if (!b) return;
  state.year = b.dataset.y; store.set("state", {year: state.year, sort: state.sort, origOn: state.origOn});
  renderList(true); window.scrollTo(0, 0);
});
el.sort.addEventListener("change", () => { state.sort = el.sort.value; store.set("state", {year: state.year, sort: state.sort, origOn: state.origOn}); renderList(true); });
el.list.addEventListener("click", e => {
  const c = e.target.closest(".card"); if (!c) return;
  location.hash = "#/p/" + c.dataset.id;
});
el.more.firstElementChild.addEventListener("click", () => { shown += PAGE; renderList(false); });
if ("IntersectionObserver" in window) {
  new IntersectionObserver(es => { if (es[0].isIntersecting && !el.more.hidden) { shown += PAGE; renderList(false); } }, {rootMargin: "600px"}).observe(el.more);
}

/* ---------- patient view ---------- */
const V = {list: $("#listView"), patient: $("#patientView"), viewer: $("#viewer")};
let curP = null, listScroll = 0;

function showList() {
  if (!V.list.hidden && V.patient.hidden) return;
  V.patient.hidden = true; V.list.hidden = false; curP = null;
  document.title = "أرشيف الأشعة";
  window.scrollTo(0, listScroll);
}

function showPatient(p) {
  if (curP === p && !V.patient.hidden) return;
  if (!V.list.hidden) listScroll = window.scrollY;
  curP = p;
  V.list.hidden = true; V.patient.hidden = false;
  document.title = p.n + " — أرشيف الأشعة";
  $("#pname").textContent = p.n;
  const bits = [/^\d+$/.test(p.y) ? num(p.y) : p.y];
  if (p.c) bits.push(p.c);
  bits.push(num(p.f.length) + " ملف");
  $("#pmeta").textContent = bits.join(" · ");
  let html = "", lastSub = null, open = false;
  p.f.forEach((f, i) => {
    const sub = f[F.sub];
    if (sub !== lastSub || i === 0) {
      if (open) html += "</div>";
      if (sub) html += `<div class="grp">📁 ${esc(sub)}</div>`;
      html += '<div class="tiles">'; open = true; lastSub = sub;
    }
    const t = f[F.t];
    const inner = f[F.th] ? `<img loading="lazy" decoding="async" ${thSrc(f)} alt="">` : `<span class="kind">${KIND[t] || "📎"}</span>`;
    html += `<button type="button" class="tile" data-i="${i}"><div class="cover">${inner}</div><div class="tn">${f[9] ? "📱 " : ""}${esc(baseName(f))}</div></button>`;
  });
  if (open) html += "</div>";
  $("#files").innerHTML = html;
  hydrate($("#files"));
  window.scrollTo(0, 0);
}
$("#files").addEventListener("click", e => {
  const t = e.target.closest(".tile"); if (!t || !curP) return;
  vPushed = true;
  location.hash = `#/p/${curP.i}/${t.dataset.i}`;
});
$("#back").addEventListener("click", () => {
  if (history.length > 1 && !fromDeepLink) history.back(); else location.hash = "#/";
});
let fromDeepLink = !!location.hash.match(/^#\/p\//);

/* ---------- viewer ---------- */
const stage = $("#stage"), vimg = $("#vimg"), vvid = $("#vvid"), vother = $("#vother");
const view = {s: 1, x: 0, y: 0, r: 0, inv: false, bri: 100, con: 100};
let vIdx = -1, vPushed = false, loadTok = 0;

function applyT() {
  vimg.style.transform = `translate(${view.x}px,${view.y}px) rotate(${view.r}deg) scale(${view.s})`;
  vimg.style.filter = `brightness(${view.bri}%) contrast(${view.con}%)${view.inv ? " invert(1)" : ""}`;
  $("#inv").classList.toggle("on", view.inv);
}
function resetView(keepFilters) {
  view.s = 1; view.x = 0; view.y = 0; view.r = 0;
  if (!keepFilters) { view.inv = false; view.bri = 100; view.con = 100; $("#bri").value = 100; $("#con").value = 100; }
  applyT();
}

function openViewer(p, i) {
  if (i < 0 || i >= p.f.length) return;
  V.viewer.hidden = false;
  document.body.style.overflow = "hidden";
  showFile(p, i);
}
function closeViewerUI() {
  if (V.viewer.hidden) return;
  V.viewer.hidden = true; document.body.style.overflow = "";
  vvid.pause(); vvid.removeAttribute("src"); vimg.removeAttribute("src"); vIdx = -1;
  if (pendingData) setTimeout(applyData, 0);
}

/* new X-rays arrived from Drive: refresh the lists, but never under the user's fingers in the viewer */
let pendingData = false;
function applyData() {
  if (!V.viewer.hidden) { pendingData = true; return; }
  pendingData = false;
  const nd = XGD.data(GDRIVE ? null : window.XLOCAL);
  D.years = nd.years; D.built = nd.built || D.built;
  P = D.patients = nd.patients;
  ingest();
  renderList(false);
  footText();
  if (curP && !V.patient.hidden) { const id = curP.i; curP = null; if (byId[id]) showPatient(byId[id]); else location.hash = "#/"; }
}
function setQuality(txt, cls) { const q = $("#vquality"); q.textContent = txt; q.className = "chip " + (cls || ""); }

function showFile(p, i) {
  vIdx = i;
  const f = p.f[i], t = f[F.t], tok = ++loadTok;
  $("#vname").textContent = p.n;
  $("#vinfo").textContent = `${num(i + 1)}/${num(p.f.length)} · ${f[F.d]} · ${fmtSize(f[F.s])}${f[F.w] ? ` · ${num(f[F.w])}×${num(f[F.h])}` : ""} · ${baseName(f)}`;
  $("#vprev").disabled = i === 0;
  $("#vnext").disabled = i === p.f.length - 1;
  vvid.hidden = true; vvid.pause(); vimg.hidden = true; vother.hidden = true;
  $("#vtools").style.visibility = (t === "i" || t === "g") ? "visible" : "hidden";
  $("#openOrig").hidden = true;
  const useOrig = serverOK && state.origOn && t === "i";
  $("#origBtn").classList.toggle("on", state.origOn);
  $("#origBtn").hidden = !serverOK || t === "g" || f[9] === 1;
  gdDel.hidden = f[9] !== 1;

  if ((t === "i" || t === "g") && gdImg(f)) {
    resetView(true);
    vimg.hidden = false;
    vimg.onerror = null;
    vimg.src = BLANK;
    setQuality("جاري التحميل…", "warn");
    let gotPv = false;
    XGD.url(f[F.th], "t").then(u => { if (tok === loadTok && !gotPv) vimg.src = u; }).catch(() => {});
    XGD.url(f[F.th], "p").then(u => { if (tok === loadTok) { gotPv = true; vimg.src = u; setQuality(t === "g" ? "صفحة PDF" : (f[9] ? "📱 نسخة العرض" : "معاينة"), "warn"); } })
      .catch(() => { if (tok === loadTok) setQuality(navigator.onLine ? "الصورة ما اتحملتش" : "مفيش إنترنت", "warn"); });
  } else if (t === "i" || t === "g") {
    resetView(true);
    vimg.hidden = false;
    const low = pvUrl(f) || thUrl(f);
    $("#openOrig").textContent = t === "g" ? "فتح الـPDF" : "فتح";
    vimg.onerror = () => {   // preview folder deleted (light version) -> fall back to thumbnail
      vimg.onerror = null;
      if (tok === loadTok && thUrl(f) && !vimg.src.includes("/thumbs/")) { vimg.src = thUrl(f); setQuality("مصغّرة", "warn"); }
    };
    vimg.src = low;
    setQuality(t === "g" ? "صفحة PDF" : (pvUrl(f) ? "معاينة" : "مصغّرة"), "warn");
    if (serverOK) {
      $("#openOrig").hidden = false; $("#openOrig").href = origUrl(f);
      if (useOrig) {
        setQuality("جاري تحميل الأصلية…", "");
        const im = new Image();
        im.onload = () => { if (tok === loadTok) { vimg.src = im.src; setQuality("الأصلية", "ok"); } };
        im.onerror = () => { if (tok === loadTok) setQuality(pvUrl(f) ? "معاينة" : "مصغّرة", "warn"); };
        im.src = origUrl(f);
      }
    } else if (!pvUrl(f)) {
      setQuality(EMB ? "مصغّرة (النسخة الخفيفة)" : "مصغّرة — شغّل البرنامج على الكمبيوتر للأصلية", "warn");
    }
  } else if (t === "v" && serverOK) {
    setQuality("", ""); vvid.hidden = false; vvid.src = origUrl(f);
  } else {
    setQuality("", "");
    vother.hidden = false;
    const link = serverOK
      ? (t === "p" ? `<a href="${origUrl(f)}" target="_blank" rel="noopener">فتح الـPDF</a>` : `<a href="${origUrl(f, true)}">تحميل الملف</a>`)
      : `<div class="muted" style="margin-top:12px">${EMB ? "الملف ده مش مضمّن في النسخة المستقلة (فيديو / ملف مضغوط / PDF متفتحش)." : "الملف الأصلي موجود على الكمبيوتر بس."}<br>هتلاقيه في فولدر الأشعة على الكمبيوتر الأساسي.</div>`;
    vother.innerHTML = `<div class="kind">${KIND[t] || "📎"}</div><div>${KIND_NAME[t] || "ملف"}</div><div class="muted" style="direction:ltr;word-break:break-all">${esc(f[F.rel])}</div>${link}`;
  }
  // preload next thumb/preview
  const nx = p.f[i + 1];
  if (nx && isPic(nx)) { if (gdImg(nx)) XGD.url(nx[F.th], "p").catch(() => {}); else { const im = new Image(); im.src = pvUrl(nx) || thUrl(nx); } }
}
const gdDel = document.createElement("button");
gdDel.type = "button"; gdDel.textContent = "🗑️ حذف"; gdDel.hidden = true; gdDel.title = "حذف الصورة دي (اتضافت من موبايل/تابلت)";
$("#vtools").appendChild(gdDel);
gdDel.addEventListener("click", async () => {
  const p = curP, f = p && p.f[vIdx];
  if (!f || f[9] !== 1 || !confirm("تحذف الصورة دي من الأرشيف؟ (هتتشال من كل الأجهزة)")) return;
  gdDel.disabled = true;
  try { await XGD.remove(f[F.th]); closeViewer(); await XGD.poll(); }
  catch (e) { alert("الحذف ما تمش: " + (e.message || e)); }
  gdDel.disabled = false;
});

function go(d) {
  if (!curP || vIdx < 0) return;
  const n = vIdx + d;
  if (n < 0 || n >= curP.f.length) return;
  history.replaceState(null, "", `#/p/${curP.i}/${n}`);
  showFile(curP, n);
}
function closeViewer() {
  if (vPushed) { vPushed = false; history.back(); }
  else if (curP) location.hash = "#/p/" + curP.i;
}
$("#vclose").addEventListener("click", closeViewer);
$("#vprev").addEventListener("click", () => go(-1));
$("#vnext").addEventListener("click", () => go(1));

/* zoom / pan / pinch */
function zoomAt(ns, cx, cy) {
  ns = Math.min(12, Math.max(1, ns));
  const r = stage.getBoundingClientRect();
  const px = cx - (r.left + r.width / 2), py = cy - (r.top + r.height / 2);
  const k = ns / view.s;
  view.x = px - (px - view.x) * k; view.y = py - (py - view.y) * k; view.s = ns;
  if (ns === 1) { view.x = 0; view.y = 0; }
  applyT();
}
function stageCenter() { const r = stage.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; }
$("#zin").addEventListener("click", () => zoomAt(view.s * 1.4, ...stageCenter()));
$("#zout").addEventListener("click", () => zoomAt(view.s / 1.4, ...stageCenter()));
$("#zfit").addEventListener("click", () => { view.s = 1; view.x = 0; view.y = 0; applyT(); });
$("#rot").addEventListener("click", () => { view.r = (view.r + 90) % 360; applyT(); });
$("#inv").addEventListener("click", () => { view.inv = !view.inv; applyT(); });
$("#bri").addEventListener("input", e => { view.bri = +e.target.value; applyT(); });
$("#con").addEventListener("input", e => { view.con = +e.target.value; applyT(); });
$("#rst").addEventListener("click", () => resetView(false));
$("#origBtn").addEventListener("click", () => {
  state.origOn = !state.origOn; store.set("state", {year: state.year, sort: state.sort, origOn: state.origOn});
  if (curP && vIdx >= 0) showFile(curP, vIdx);
});
stage.addEventListener("wheel", e => {
  if (vimg.hidden) return;
  e.preventDefault();
  zoomAt(view.s * (e.deltaY < 0 ? 1.15 : 1 / 1.15), e.clientX, e.clientY);
}, {passive: false});
stage.addEventListener("dblclick", e => { if (vimg.hidden) return; view.s > 1.05 ? zoomAt(1, e.clientX, e.clientY) : zoomAt(2.5, e.clientX, e.clientY); });

const pts = new Map();
let lastDist = 0, lastMid = null, travelX = 0, travelY = 0, t0 = 0, moved = false;
stage.addEventListener("pointerdown", e => {
  if (vimg.hidden || e.target.closest(".nav")) return;
  stage.setPointerCapture(e.pointerId);
  pts.set(e.pointerId, {x: e.clientX, y: e.clientY});
  if (pts.size === 1) { travelX = travelY = 0; t0 = Date.now(); moved = false; stage.classList.add("drag"); }
  if (pts.size === 2) { const [a, b] = [...pts.values()]; lastDist = Math.hypot(a.x - b.x, a.y - b.y); lastMid = {x: (a.x + b.x) / 2, y: (a.y + b.y) / 2}; }
});
stage.addEventListener("pointermove", e => {
  const p = pts.get(e.pointerId); if (!p) return;
  const dx = e.clientX - p.x, dy = e.clientY - p.y;
  p.x = e.clientX; p.y = e.clientY;
  if (pts.size === 1) {
    travelX += dx; travelY += dy;
    if (Math.abs(travelX) + Math.abs(travelY) > 6) moved = true;
    if (view.s > 1.02) { view.x += dx; view.y += dy; applyT(); }
  } else if (pts.size === 2) {
    const [a, b] = [...pts.values()];
    const dist = Math.hypot(a.x - b.x, a.y - b.y), mid = {x: (a.x + b.x) / 2, y: (a.y + b.y) / 2};
    if (lastDist) { view.x += mid.x - lastMid.x; view.y += mid.y - lastMid.y; zoomAt(view.s * dist / lastDist, mid.x, mid.y); }
    lastDist = dist; lastMid = mid; moved = true;
  }
});
function endPtr(e) {
  if (!pts.has(e.pointerId)) return;
  const was = pts.size;
  pts.delete(e.pointerId);
  if (was === 1) {
    stage.classList.remove("drag");
    // swipe to navigate (only when not zoomed)
    if (view.s <= 1.05 && Math.abs(travelX) > 60 && Math.abs(travelY) < 70 && Date.now() - t0 < 600) go(travelX < 0 ? 1 : -1);
  }
  if (pts.size < 2) lastDist = 0;
}
stage.addEventListener("pointerup", endPtr);
stage.addEventListener("pointercancel", endPtr);

document.addEventListener("keydown", e => {
  if (V.viewer.hidden) return;
  if (e.key === "Escape") closeViewer();
  else if (e.key === "ArrowLeft") go(1);
  else if (e.key === "ArrowRight") go(-1);
  else if (e.key === "+" || e.key === "=") zoomAt(view.s * 1.3, ...stageCenter());
  else if (e.key === "-") zoomAt(view.s / 1.3, ...stageCenter());
  else if (e.key === "0") { view.s = 1; view.x = view.y = 0; applyT(); }
  else if (e.key.toLowerCase() === "i") { view.inv = !view.inv; applyT(); }
  else if (e.key.toLowerCase() === "r") { view.r = (view.r + 90) % 360; applyT(); }
});

/* ---------- router ---------- */
function route() {
  const a = location.hash.match(/^#\/add(?:\/([a-z0-9]+))?/);   // back from a Google sign-in made just to add X-rays
  if (a) {
    history.replaceState(null, "", a[1] && byId[a[1]] ? "#/p/" + a[1] : "#/");
    route();
    setTimeout(() => openMAdd(a[1] ? byId[a[1]] : null), 300);
    return;
  }
  const m = location.hash.match(/^#\/p\/([a-z0-9]+)(?:\/(\d+))?/);
  if (!m) { closeViewerUI(); showList(); return; }
  const p = byId[m[1]];
  if (!p) { location.hash = "#/"; return; }
  showPatient(p);
  if (m[2] !== undefined) {
    if (V.viewer.hidden || curP !== p || vIdx !== +m[2]) openViewer(p, +m[2]);
  } else { vPushed = false; closeViewerUI(); }
}
window.addEventListener("hashchange", () => { if (location.hash.length > 3) fromDeepLink = false; route(); });

/* ---------- boot ---------- */
function updateMode() {
  if (GDRIVE) {
    const off = !navigator.onLine || XGD.stale();
    el.mode.textContent = off ? "بدون إنترنت · المحفوظ على الجهاز" : "جوجل درايف ✔";
    el.mode.className = "chip " + (off ? "warn" : "ok");
    el.mode.title = XGD.email();
    return;
  }
  if (EMB) { el.mode.textContent = window.XLITE ? "نسخة خفيفة · بدون إنترنت" : "نسخة مستقلة · بدون إنترنت"; el.mode.className = "chip ok"; el.mode.title = "الصور جوه الملف نفسه"; }
  else if (location.protocol === "file:") { el.mode.textContent = "بدون سيرفر · معاينات"; el.mode.className = "chip warn"; el.mode.title = "الأصلية متاحة لما تشغّل البرنامج على الكمبيوتر"; }
  else if (serverOK) { el.mode.textContent = "الأصلية متاحة ✔"; el.mode.className = "chip ok"; }
  else { el.mode.textContent = "معاينات فقط"; el.mode.className = "chip warn"; el.mode.title = "السيرفر مش شغّال — الأصلية مش متاحة"; }
}
async function ping() {
  if (GDRIVE || EMB || !/^https?:$/.test(location.protocol)) return updateMode();
  try {
    const r = await fetch("api/ping", {cache: "no-store"});
    const j = r.ok ? await r.json() : null;
    serverOK = !!(j && j.ok);
  } catch (e) { serverOK = false; }
  updateMode();
  if (curP && vIdx >= 0 && !V.viewer.hidden) showFile(curP, vIdx);
}

el.sort.value = state.sort;
const footInfo = document.createElement("span");
el.foot.textContent = "";
el.foot.appendChild(footInfo);
function footText() { footInfo.textContent = `${num(P.length)} مريض/مجموعة · ${num(totalFiles)} ملف · آخر تحديث للفهرس: ${D.built}`; }
footText();
updateMode();
renderList(true);
route();
ping();
setInterval(() => { if (document.visibilityState === "visible") { const was = serverOK; ping().then(() => { if (was !== serverOK) updateMode(); }); } }, 30000);

{ const b = document.getElementById("boot"); if (b) b.remove(); }

/* ---------- add new X-rays: works on the clinic PC, where the import tool (import-tool/add-xray.bat) runs ---------- */
const defaultImportBase = "http://127.0.0.1:8766";
let savedImportBase = store.get("importBase");
if (savedImportBase === "http://127.0.0.1:8765") savedImportBase = defaultImportBase;
const XI_BASE = savedImportBase || defaultImportBase;
let xiMode = "";   // "" = tool not running, "in" = opens inside the app, "tab" = opens the tool's own page
function openImport(p) {
  if (xiMode === "in" && window.XImport) window.XImport.open({name: p ? p.n : "", onRebuilt: () => location.reload()});
  else if (xiMode === "tab") window.open(XI_BASE + "/", "xray-import");
  else if (GDON) openMAdd(p);
  else if (GDCAN && confirm("عشان تضيف أشعة، لازم تدخل بحساب جوجل بتاع العيادة مرة واحدة.\nبعدها الأرشيف هيفتح من جوجل درايف والأشعة الجديدة توصل لوحدها.\n\nتدخل دلوقتي؟"))
    XGD.auth(true, "#/add" + (p ? "/" + p.i : ""));
}
// archive opened from a saved .xrpack file on a web address: the add button still shows, and signs in to Drive first
const GDCAN = !GDON && XGD.ready;
/* any device: the display copy goes to the clinic Google Drive, the original stays on the device */
let maddP = null;
async function openMAdd(p) {
  if (!GDON) return;
  if (!navigator.onLine) return alert("محتاج إنترنت عشان تضيف أشعة.");
  if (XGD.minutesLeft() < 15) return XGD.auth(false, "#/add" + (p ? "/" + p.i : ""));   // fresh sign-in first, then the dialog opens again
  try {
    if (!window.XMAdd) {
      maddP = maddP || new Promise((ok, bad) => {
        const s = document.createElement("script");
        s.src = "madd.js?v=" + (window.XAPP_V || "1"); s.onload = ok; s.onerror = () => { maddP = null; bad(new Error("madd")); };
        document.head.appendChild(s);
      });
      await maddP;
    }
  } catch (e) { return alert("شاشة الإضافة ما اتحملتش — اتأكد من النت وجرّب تاني."); }
  window.XMAdd.open({
    name: p ? p.n : "", year: p ? p.y : "", patients: P, ignore: XGD.ignore(), upload: XGD.upload,
    onDone: async (name, year) => {
      await XGD.poll();
      applyData();
      const k = norm(name), hit = P.find(q => q.y === year && norm(q.n) === k);
      if (hit) location.hash = "#/p/" + hit.i;
    }
  });
}
// the buttons are made here when this copy of index.html doesn't have them yet (so only app.js has to be replaced)
function addBtn(id, label, title, after) {
  let b = document.getElementById(id);
  if (!b) {
    b = document.createElement("button"); b.id = id; b.type = "button"; b.className = "addx"; b.hidden = true;
    b.textContent = label; if (title) b.title = title;
    if (after) after.insertAdjacentElement("afterend", b);
  }
  return b;
}
const addX = addBtn("addX", "＋ إضافة أشعة", "", document.querySelector("#listView .bar h1"));
const addXp = addBtn("addXp", "＋ أشعة", "إضافة أشعة جديدة للمريض ده", document.querySelector("#patientView .ptitle"));
if (!document.getElementById("xr-addx-css")) {
  const st = document.createElement("style"); st.id = "xr-addx-css";
  st.textContent = ".addx{border:0;background:#3b82f6;color:#fff;font-weight:600;border-radius:99px;padding:7px 14px;font-size:.92rem;white-space:nowrap;cursor:pointer}.addx:hover{background:#60a5fa}#listView .bar h1{flex:1}";
  document.head.appendChild(st);
}
addX.addEventListener("click", () => openImport(null));
addXp.addEventListener("click", () => openImport(curP));
addX.hidden = addXp.hidden = !GDON && !GDCAN;
async function probeImport() {
  // only the PC can have the tool; don't make phones knock on 127.0.0.1
  if (!/Windows|Macintosh|Linux x86/.test(navigator.userAgent) || /Android|iPhone|iPad/.test(navigator.userAgent)) return;
  try {
    const r = await fetch(XI_BASE + "/api/hello", {cache: "no-store"});
    if ((await r.json()).ok) xiMode = "in";
  } catch (e) {
    // running, but this page's address is not allowed to talk to it -> open the tool in its own tab
    try { await fetch(XI_BASE + "/api/hello", {mode: "no-cors", cache: "no-store"}); xiMode = "tab"; } catch (x) {}
  }
  if (xiMode === "in" && !window.XImport) {
    await new Promise((ok, bad) => {
      const s = document.createElement("script");
      s.src = XI_BASE + "/import.js?v=" + Date.now(); s.onload = ok; s.onerror = bad;
      document.head.appendChild(s);
    }).catch(() => { xiMode = "tab"; });
  }
  addX.hidden = addXp.hidden = !xiMode && !GDON && !GDCAN;
}
probeImport();
setInterval(() => { if (!xiMode && document.visibilityState === "visible") probeImport(); }, 60000);
/* ---------- Google Drive: keep up to date, links in the footer ---------- */
const footLink = (txt, fn) => {
  const a = document.createElement("a"); a.href = "#"; a.textContent = " · " + txt; a.style.color = "inherit";
  a.onclick = e => { e.preventDefault(); fn(); }; el.foot.appendChild(a); return a;
};
if (GDON) {
  XGD.onData = applyData;
  XGD.onAuthLost = () => {   // the 1-hour Google pass ran out while pictures were loading
    if (!V.viewer.hidden || document.getElementById("xma") || !navigator.onLine || !XGD.canTrySilent()) return updateMode();
    XGD.auth(false);
  };
  const tick = () => { if (document.visibilityState === "visible") XGD.poll().then(updateMode); };
  setInterval(tick, 60000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    if (XGD.minutesLeft() < 2 && navigator.onLine && V.viewer.hidden && !document.getElementById("xma") && XGD.canTrySilent()) return XGD.auth(false);
    tick();
  });
  window.addEventListener("online", tick);
  window.addEventListener("offline", updateMode);
  footLink("حساب جوجل: " + (XGD.email() || "…"), () => {
    if (confirm("تخرج من حساب جوجل على الجهاز ده؟ (هتحتاج تدخل تاني عشان تشوف الأرشيف)")) { XGD.signOut(); location.reload(); }
  });
  if (GDRIVE) navigator.storage && navigator.storage.getDirectory && navigator.storage.getDirectory()
    .then(r => r.getFileHandle("archive.xrpack")).then(h => h.getFile()).then(f => {
      footLink(`مسح ملف الأرشيف القديم من الجهاز (${Math.round(f.size / 1048576)} ميجا)`, async () => {
        if (!confirm("ملف الأرشيف القديم مبقاش له لازمة (الأرشيف بقى من جوجل درايف). تمسحه وتوفّر المساحة؟")) return;
        try { (await navigator.storage.getDirectory()).removeEntry("archive.xrpack"); } catch (x) {}
        location.reload();
      });
    }).catch(() => {});
} else if (XGD.ready && !EMB && !PK) {
  footLink("ربط بجوجل درايف (عشان تظهر الأشعة اللي اتضافت من الموبايل)", () => XGD.auth(true));
}
if (PK && window.XPACK.saved) {
  if (XGD.ready) footLink("استخدم جوجل درايف بدل الملف (الأشعة الجديدة توصل لوحدها)", () => XGD.auth(true, "#/"));
  const a = document.createElement("a"); a.href = "#"; a.textContent = " · تغيير ملف الأرشيف";
  a.style.color = "inherit";
  a.onclick = async e => { e.preventDefault(); if (!confirm("تشيل ملف الأرشيف المحفوظ وتختار واحد جديد؟")) return;
    try { (await navigator.storage.getDirectory()).removeEntry("archive.xrpack"); } catch (x) {} location.reload(); };
  el.foot.appendChild(a);
}
if ((!EMB || PK) && "serviceWorker" in navigator && /^https?:$/.test(location.protocol)) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
}

/* ---------- loader: embedded data, or an archive pack picked by the user ---------- */
window.XAPP_V = "5";
(async () => {
  const gret = XGD.ready ? XGD.takeReturn() : null;   // coming back from a Google sign-in?
  if (window.XDATA) {
    // the clinic PC's own archive: also show what was added from phones (when this PC is linked to Drive)
    if (XGD.on() || (gret && gret.ok)) {
      try {
        if (await XGD.boot(gret, true)) {
          window.XLOCAL = window.XDATA;
          window.XDATA = XGD.data(window.XLOCAL);
          window.XGD_MODE = "merge";
        }
      } catch (e) {}
    }
    return startApp();
  }
  const boot = document.getElementById("boot");
  const say = h => { if (boot) boot.innerHTML = `<div style="text-align:center;padding:24px;max-width:420px;line-height:1.9">${h}</div>`; };
  const gesc = s => String(s).replace(/[&<>]/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;"}[c]));
  const BTN = "display:block;width:100%;border:0;border-radius:14px;padding:15px;font-size:1.05rem;font-weight:700;cursor:pointer;margin-top:14px";
  /* ---- the archive from the clinic Google Drive (the normal way on phones / tablets) */
  if (XGD.ready && (XGD.on() || gret)) {
    say("جاري فتح الأرشيف من جوجل درايف…");
    try {
      if (await XGD.boot(gret, false)) {
        window.XDATA = XGD.data();
        window.XGD_MODE = "drive";
        return startApp();
      }
      return;
    } catch (e) {
      const why = e.noroot ? `الحساب ده (${gesc(XGD.email() || "اللي دخلت بيه")}) مفيهوش أرشيف الأشعة. ادخل بحساب العيادة.`
        : e.auth ? "محتاج تدخل بحساب جوجل بتاع العيادة."
        : navigator.onLine ? "الأرشيف ما اتفتحش (" + gesc(e.message || e) + ")." : "مفيش إنترنت، والأرشيف لسه ما اتحفظش على الجهاز ده.";
      say(`<div style="font-size:1.3rem;color:#e8edf7;margin-bottom:8px">أرشيف الأشعة</div>${why}
        <button id="gsign" type="button" style="${BTN};background:#3b82f6;color:#fff">دخول بحساب جوجل</button>
        <button id="gretry" type="button" style="${BTN};background:#1e293b;color:#cbd5e1">حاول تاني</button>`);
      document.getElementById("gsign").onclick = () => { if (e.noroot) XGD.signOut(); XGD.auth(true, "#/"); };
      document.getElementById("gretry").onclick = () => location.reload();
      return;
    }
  }
  async function openPack(file, saved) {
    const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
    if (new TextDecoder().decode(head.slice(0, 8)) !== "XRPACK1\n") throw new Error("bad");
    const n = new DataView(head.buffer).getUint32(8, true);
    const idx = JSON.parse(await file.slice(12, 12 + n).text());
    window.XDATA = idx.data;
    window.XPACK = {file, base: 12 + n, img: idx.img, saved: !!saved};
    startApp();
  }
  let root = null;
  try { root = await navigator.storage.getDirectory(); } catch (e) {}
  if (root) {
    try { const f = await (await root.getFileHandle("archive.xrpack")).getFile(); if (f.size > 12) return await openPack(f, true); } catch (e) {}
  }
  const pick = msg => {
    say(`<div style="font-size:1.3rem;color:#e8edf7;margin-bottom:8px">أرشيف الأشعة</div>${msg || (XGD.ready ? "ادخل بحساب جوجل بتاع العيادة، والأرشيف هيفتح ويتحدث لوحده." : "اختار ملف الأرشيف <b>XRay Archive.xrpack</b> من على الجهاز.")}
      ${XGD.ready ? `<button id="gsign" type="button" style="${BTN};background:#3b82f6;color:#fff">دخول بحساب جوجل</button>
      <div style="font-size:.85rem;margin-top:22px">أو اختار ملف أرشيف <b>.xrpack</b> من على الجهاز (من غير تحديث تلقائي):</div>` : ""}
      <div style="margin-top:${XGD.ready ? 8 : 18}px;background:${XGD.ready ? "#1e293b" : "#3b82f6"};border-radius:14px;padding:14px">
      <input id="pk" type="file" style="width:100%;color:#fff;font-size:1rem"></div>
      <div id="pkst" style="font-size:.9rem;margin-top:12px;min-height:1.5em"></div>
      ${root ? '<div style="font-size:.8rem;margin-top:6px">هيتحفظ على الجهاز، ومش هتحتاج تختاره تاني.</div>' : ""}`);
    const st = t => { const d = document.getElementById("pkst"); if (d) d.textContent = t; };
    const onFile = async file => {
      if (!file) return st("ما اتختارش ملف.");
      try {
        st("جاري قراءة الملف… (" + Math.round(file.size / 1048576) + " MB)");
        const head = new TextDecoder().decode(await file.slice(0, 8).arrayBuffer());
        if (head !== "XRPACK1\n") return pick('<span style="color:#fca5a5">ده مش ملف الأرشيف (' + esc(file.name) + '). اختار الملف اللي آخره xrpack.</span>');
        await openPack(file, false);          // show the archive right away
        if (root) saveCopy(file);             // then keep a private copy in the background
      } catch (x) { pick('<span style="color:#fca5a5">الملف ما اتفتحش: ' + esc((x && (x.name + " " + x.message)) || x) + '</span>'); }
    };
    const inp = document.getElementById("pk");
    inp.onchange = e => onFile(e.target.files[0]);
    const gs = document.getElementById("gsign");
    if (gs) gs.onclick = () => XGD.auth(true, "#/");
    boot.ondragover = e => e.preventDefault();
    boot.ondrop = e => { e.preventDefault(); onFile(e.dataTransfer.files[0]); };
  };
  const esc = s => String(s).replace(/[&<>]/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;"}[c]));
  async function saveCopy(file) {
    const t = document.createElement("div");
    t.style.cssText = "position:fixed;bottom:10px;left:10px;z-index:99;background:#1e293b;color:#cbd5e1;padding:6px 12px;border-radius:10px;font-size:.8rem;direction:rtl";
    document.body.appendChild(t);
    try {
      if (navigator.storage.persist) navigator.storage.persist();
      const h = await root.getFileHandle("archive.xrpack", {create: true});
      const w = await h.createWritable();
      const CH = 4 * 1048576;
      for (let o = 0; o < file.size; o += CH) {
        await w.write(file.slice(o, o + CH));
        t.textContent = "جاري حفظ الأرشيف على الجهاز… " + Math.round(Math.min(o + CH, file.size) / file.size * 100) + "٪";
      }
      await w.close();
      t.textContent = "الأرشيف اتحفظ ✔ المرة الجاية هيفتح لوحده";
    } catch (x) {
      try { await root.removeEntry("archive.xrpack"); } catch (y) {}
      t.textContent = "الأرشيف ما اتحفظش على الجهاز (" + ((x && x.name) || "خطأ") + ") — هتختاره كل مرة";
    }
    setTimeout(() => t.remove(), 6000);
  }
  pick();
})();
