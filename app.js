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

/* ---------- data prep ---------- */
const P = D.patients;
const byId = {};
let totalFiles = 0;
for (const p of P) {
  byId[p.i] = p;
  totalFiles += p.f.length;
  p.nImg = p.f.filter(isPic).length;
  p.hay = norm([p.n, p.c, p.y, ...p.f.map(baseName)].join(" "));
  p.cover = p.f.find(f => f[F.th]) || null;
  p.last = p.f.reduce((m, f) => f[F.d] > m ? f[F.d] : m, "");
}

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
  const img = p.cover ? `<img loading="lazy" decoding="async" src="${thUrl(p.cover)}" alt="">` : `<span class="ph">${p.f[0] ? KIND[p.f[0][F.t]] : "🖼️"}</span>`;
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
    const inner = f[F.th] ? `<img loading="lazy" decoding="async" src="${thUrl(f)}" alt="">` : `<span class="kind">${KIND[t] || "📎"}</span>`;
    html += `<button type="button" class="tile" data-i="${i}"><div class="cover">${inner}</div><div class="tn">${esc(baseName(f))}</div></button>`;
  });
  if (open) html += "</div>";
  $("#files").innerHTML = html;
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
  $("#origBtn").hidden = !serverOK || t === "g";

  if (t === "i" || t === "g") {
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
  const nx = p.f[i + 1]; if (nx && isPic(nx)) { const im = new Image(); im.src = pvUrl(nx) || thUrl(nx); }
}

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
  if (EMB) { el.mode.textContent = window.XLITE ? "نسخة خفيفة · بدون إنترنت" : "نسخة مستقلة · بدون إنترنت"; el.mode.className = "chip ok"; el.mode.title = "الصور جوه الملف نفسه"; }
  else if (location.protocol === "file:") { el.mode.textContent = "بدون سيرفر · معاينات"; el.mode.className = "chip warn"; el.mode.title = "الأصلية متاحة لما تشغّل البرنامج على الكمبيوتر"; }
  else if (serverOK) { el.mode.textContent = "الأصلية متاحة ✔"; el.mode.className = "chip ok"; }
  else { el.mode.textContent = "معاينات فقط"; el.mode.className = "chip warn"; el.mode.title = "السيرفر مش شغّال — الأصلية مش متاحة"; }
}
async function ping() {
  if (EMB || !/^https?:$/.test(location.protocol)) return updateMode();
  try {
    const r = await fetch("api/ping", {cache: "no-store"});
    const j = r.ok ? await r.json() : null;
    serverOK = !!(j && j.ok);
  } catch (e) { serverOK = false; }
  updateMode();
  if (curP && vIdx >= 0 && !V.viewer.hidden) showFile(curP, vIdx);
}

el.sort.value = state.sort;
el.foot.textContent = `${num(P.length)} مريض/مجموعة · ${num(totalFiles)} ملف · آخر تحديث للفهرس: ${D.built}`;
updateMode();
renderList(true);
route();
ping();
setInterval(() => { if (document.visibilityState === "visible") { const was = serverOK; ping().then(() => { if (was !== serverOK) updateMode(); }); } }, 30000);

{ const b = document.getElementById("boot"); if (b) b.remove(); }
if (PK && window.XPACK.saved) {
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
(async () => {
  if (window.XDATA) return startApp();
  const boot = document.getElementById("boot");
  const say = h => { if (boot) boot.innerHTML = `<div style="text-align:center;padding:24px;max-width:420px;line-height:1.9">${h}</div>`; };
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
    say(`<div style="font-size:1.3rem;color:#e8edf7;margin-bottom:8px">أرشيف الأشعة</div>${msg || "اختار ملف الأرشيف <b>XRay Archive.xrpack</b> من على الجهاز."}
      <div style="margin-top:18px;background:#3b82f6;border-radius:14px;padding:14px">
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
