/* «إضافة أشعة جديدة» — the add-X-ray window.
   Served by the import tool running on the clinic PC (add_xray.py) and opened from inside the archive app,
   or on its own at http://127.0.0.1:8765/ .  Usage: XImport.open({name, year, onRebuilt}) */
(() => {
"use strict";
if (window.XImport) return;
const BASE = new URL(document.currentScript.src).origin;
const STANDALONE = location.origin === BASE;

/* ---------------------------------------------------------------- helpers */
const AR = {"أ":"ا","إ":"ا","آ":"ا","ٱ":"ا","ى":"ي","ئ":"ي","ؤ":"و","ة":"ه"};
const key = s => (s || "").normalize("NFKC").toLowerCase()
  .replace(/[\u064B-\u065F\u0670\u0640]/g, "").replace(/[أإآٱىئؤة]/g, c => AR[c])
  .replace(/[٠-٩]/g, d => d.charCodeAt(0) - 1632)
  .replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const num = n => String(n).replace(/\d/g, d => "٠١٢٣٤٥٦٧٨٩"[d]);
const fmtSize = b => b > 1048576 ? (b / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(b / 1024)) + " KB";
const cleanName = s => {
  s = (s || "").normalize("NFKC").replace(/\^/g, " ").replace(/[<>:"/\\|?*\x00-\x1f]/g, " ").replace(/\s+/g, " ").replace(/^[ .\-_,]+|[ .\-_,]+$/g, "");
  if (s && (s.toUpperCase() === s || s.toLowerCase() === s) && /[A-Za-z]/.test(s)) s = s.split(" ").map(w => w[0] + w.slice(1).toLowerCase()).join(" ");
  return s;
};
const when = ms => {
  const d = new Date(ms), now = new Date(), t = d.toLocaleTimeString("ar-EG", {hour: "numeric", minute: "2-digit"});
  const days = Math.round((new Date(now.toDateString()) - new Date(d.toDateString())) / 864e5);
  return days === 0 ? "النهارده " + t : days === 1 ? "امبارح " + t : d.toLocaleDateString("ar-EG", {day: "numeric", month: "short"}) + " " + t;
};
const SRC = {dicom: "من بيانات الأشعة", label: "مكتوب جنب «الاسم»", patient: "مريض موجود في الأرشيف", ocr: "مكتوب على الأشعة",
             meta: "من بيانات الصورة", filename: "من اسم الملف"};

async function api(path, body, raw) {
  const opt = {method: body === undefined ? "GET" : "POST", headers: {"X-XRay": "1"}, cache: "no-store"};
  if (body !== undefined) {
    if (raw) { opt.body = body.data; Object.assign(opt.headers, body.headers); }
    else { opt.body = JSON.stringify(body); opt.headers["Content-Type"] = "application/json"; }
  }
  let r;
  try { r = await fetch(BASE + path, opt); }
  catch (e) { throw new Error("أداة الإضافة مش شغالة على الكمبيوتر — شغّل add-xray.bat"); }
  const j = await r.json().catch(() => ({error: "رد غير مفهوم من الأداة"}));
  if (!r.ok) throw new Error(j.error || ("خطأ " + r.status));
  return j;
}

/* ---------------------------------------------------------------- styles */
const CSS = `
.xi{position:fixed;inset:0;z-index:60;background:var(--bg,#0b1220);color:var(--text,#e8edf7);overflow:auto;
  font-family:"Segoe UI",Tahoma,"Noto Sans Arabic",system-ui,sans-serif;line-height:1.5;direction:rtl;-webkit-overflow-scrolling:touch}
.xi *{box-sizing:border-box}.xi [hidden]{display:none!important}
.xi button,.xi input,.xi select{font:inherit;color:inherit}.xi button{cursor:pointer}
.xi .w{max-width:1000px;margin:0 auto;padding:12px 16px 110px}
.xi .top{position:sticky;top:0;z-index:2;background:var(--bg,#0b1220);display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:10px 0 10px}
.xi h2{font-size:1.3rem;margin:0;flex:1}.xi h3{font-size:1.02rem;margin:0}
.xi .ico{width:40px;height:40px;border-radius:50%;border:1px solid var(--line,#243252);background:var(--panel,#111a2e);font-size:1.1rem}
.xi .chip{font-size:.78rem;padding:3px 10px;border-radius:99px;background:var(--panel2,#18233d);color:var(--muted,#93a1bd);white-space:nowrap}
.xi .chip.ok{background:#0f3a24;color:#86efac}.xi .chip.warn{background:#3d2d0a;color:#fcd34d}
.xi .btn{border:1px solid var(--line,#243252);background:var(--panel,#111a2e);border-radius:12px;padding:8px 14px}
.xi .btn:hover{border-color:var(--accent2,#60a5fa)}.xi .btn:disabled{opacity:.5;cursor:default}
.xi .btn.pri{background:var(--accent,#3b82f6);border-color:var(--accent,#3b82f6);color:#fff;font-weight:600}
.xi .btn.sm{padding:4px 10px;font-size:.85rem;border-radius:9px}
.xi .muted{color:var(--muted,#93a1bd);font-size:.88rem}.xi .ltr{direction:ltr;unicode-bidi:embed}
.xi .in{background:var(--bg,#0b1220);border:1px solid var(--line,#243252);border-radius:10px;padding:8px 10px;min-width:0}
.xi .in:focus{outline:none;border-color:var(--accent,#3b82f6)}
.xi .box{background:var(--panel,#111a2e);border:1px solid var(--line,#243252);border-radius:16px;padding:14px;margin-bottom:12px}
.xi .row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:8px 0}.xi .row .in{flex:1;min-width:200px}
.xi .row>label{min-width:150px}
.xi .preset{background:#16305e;border:1px solid var(--accent,#3b82f6);border-radius:14px;padding:10px 14px;margin-bottom:12px;display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.xi .ways{display:grid;grid-template-columns:1.1fr 1fr;gap:12px;margin-bottom:12px}
.xi .drop{border:2px dashed var(--line,#243252);border-radius:16px;background:var(--panel,#111a2e);padding:22px 14px;text-align:center;cursor:pointer;transition:border-color .15s,background .15s}
.xi .drop .big{font-size:1.15rem;font-weight:600;margin:4px 0}
.xi.over .drop{border-color:var(--accent2,#60a5fa);background:#13213f}
.xi .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:8px;margin-top:10px}
.xi .tile{border:2px solid transparent;background:var(--panel2,#18233d);border-radius:12px;padding:0;overflow:hidden;text-align:start;position:relative}
.xi .tile.sel{border-color:var(--accent,#3b82f6)}.xi .tile.busy{opacity:.45;pointer-events:none}
.xi .tile .im{aspect-ratio:4/3;background:#05080f;display:grid;place-items:center;font-size:1.6rem}
.xi .tile img{width:100%;height:100%;object-fit:cover;display:block}
.xi .tile .cap{padding:5px 7px;font-size:.75rem;color:var(--muted,#93a1bd);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.xi .tile .ck{position:absolute;top:6px;inset-inline-start:6px;width:24px;height:24px;border-radius:50%;background:#0009;border:2px solid #fff8;display:grid;place-items:center;font-size:.8rem}
.xi .tile.sel .ck{background:var(--accent,#3b82f6);border-color:#fff}
.xi .tile .wa{position:absolute;bottom:52px;inset-inline-end:6px;font-size:.7rem;background:#0b5d3b;color:#d1fae5;border-radius:99px;padding:1px 7px}
.xi .tile .done{position:absolute;top:6px;inset-inline-end:6px;font-size:.7rem;background:#0f3a24;color:#86efac;border-radius:99px;padding:1px 7px}
.xi .q{display:flex;flex-direction:column;gap:12px;margin-top:12px}
.xi .item{display:grid;grid-template-columns:170px 1fr;gap:14px;background:var(--panel,#111a2e);border:1px solid var(--line,#243252);border-radius:16px;padding:12px;position:relative;overflow:hidden}
.xi .item .th{aspect-ratio:4/3;background:#05080f;border-radius:10px;display:grid;place-items:center;overflow:hidden;font-size:2rem}
.xi .item .th img{width:100%;height:100%;object-fit:contain;display:block}
.xi .fn{font-size:.82rem;color:var(--muted,#93a1bd);direction:ltr;text-align:right;word-break:break-all}
.xi .st{font-size:.92rem;margin:2px 0 8px}
.xi .fields{display:flex;gap:8px;flex-wrap:wrap}.xi .fields .nm{flex:1;min-width:190px;font-size:1.08rem;font-weight:600;padding:9px 12px}
.xi .cands{display:flex;gap:6px;flex-wrap:wrap;margin:8px 0 2px}
.xi .cand{border:1px solid var(--line,#243252);background:var(--panel2,#18233d);border-radius:99px;padding:3px 4px 3px 12px;font-size:.88rem;display:inline-flex;gap:6px;align-items:center;cursor:pointer}
.xi .cand.on{border-color:var(--accent,#3b82f6);background:#16305e}.xi .cand small{color:var(--muted,#93a1bd)}
.xi .cand .x{border:0;background:transparent;color:var(--muted,#93a1bd);padding:0 6px;font-size:.8rem}
.xi .dest{font-size:.88rem;color:var(--muted,#93a1bd);margin-top:8px}.xi .dest b{color:var(--text,#e8edf7);font-weight:600}
.xi .tag{font-size:.75rem;padding:1px 8px;border-radius:99px;margin-inline-start:6px;white-space:nowrap}
.xi .tag.new{background:#3d2d0a;color:#fcd34d}.xi .tag.old{background:#0f3a24;color:#86efac}
.xi .acts{display:flex;gap:8px;margin-top:10px;align-items:center;flex-wrap:wrap}
.xi .bar{position:absolute;bottom:0;right:0;height:4px;background:var(--accent,#3b82f6);width:0;transition:width linear}
.xi .item.saved{grid-template-columns:70px 1fr;border-color:#1f5a37}.xi .item.saved .th{font-size:1.3rem}
.xi .item.err{border-color:#6b2121}
.xi details{margin-top:6px}.xi summary{cursor:pointer;color:var(--muted,#93a1bd);font-size:.8rem}
.xi pre{white-space:pre-wrap;font-size:.8rem;color:var(--muted,#93a1bd);max-height:160px;overflow:auto;background:var(--bg,#0b1220);padding:8px;border-radius:8px;direction:ltr;text-align:left}
.xi .foot{position:fixed;bottom:0;inset-inline:0;z-index:3;background:#0d1628f2;border-top:1px solid var(--line,#243252);padding:10px 16px;display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.xi .foot .grow{flex:1}
.xi .spin{display:inline-block;width:14px;height:14px;border:2px solid var(--muted,#93a1bd);border-top-color:transparent;border-radius:50%;animation:xisp 1s linear infinite;vertical-align:-2px}
@keyframes xisp{to{transform:rotate(360deg)}}
.xi .sw{display:inline-flex;gap:6px;align-items:center;font-size:.88rem;color:var(--muted,#93a1bd)}
.xi .err-t{color:#fca5a5}.xi .ok-t{color:#86efac}.xi .warn-t{color:#fcd34d}
@media (max-width:720px){.xi .ways{grid-template-columns:1fr}.xi .item{grid-template-columns:1fr}.xi .row>label{min-width:0}}
`;

/* ---------------------------------------------------------------- layout */
const HTML = `
<div class="w">
  <div class="top">
    ${STANDALONE ? "" : '<button type="button" class="ico" data-a="close" aria-label="رجوع">→</button>'}
    <h2>＋ إضافة أشعة جديدة</h2>
    <span class="chip" data-r="ocr"></span>
    <label class="sw"><input type="checkbox" data-r="auto"> حفظ تلقائي لما الاسم يكون واضح</label>
    <button class="btn sm" type="button" data-a="openRoot">📂 فولدر الأشعة</button>
    <button class="btn sm" type="button" data-a="settings">⚙️ الإعدادات</button>
  </div>

  <div class="preset" data-r="preset" hidden>👤 الأشعة هتتضاف للمريض: <b data-r="presetName"></b>
    <button class="btn sm" type="button" data-a="unpreset">مريض تاني</button></div>

  <section class="box" data-r="setup" hidden>
    <h3>الإعدادات</h3>
    <div class="row"><label>فولدر الأشعة الأساسي</label><input class="in ltr" data-c="xray_root" placeholder="D:\\X-Ray">
      <button class="btn sm" type="button" data-pick="folder" data-for="xray_root">اختار…</button></div>
    <div class="muted" data-r="rootInfo"></div>
    <div class="row"><label>ملف تحديث الأرشيف</label><input class="in ltr" data-c="rebuild_cmd" placeholder="rebuild.bat">
      <button class="btn sm" type="button" data-pick="file" data-for="rebuild_cmd">اختار…</button></div>
    <div class="row"><label>كلام مكتوب على كل الأشعة<br><span class="muted">(اسم العيادة / الدكتور)</span></label>
      <input class="in" data-c="ignore_words" placeholder="افصل بينهم بـ ،"></div>
    <div class="row"><label>فولدرات تانية أدوّر فيها<br><span class="muted">(غير التنزيلات وواتساب)</span></label>
      <input class="in ltr" data-c="watch_folders" placeholder="E:\\Scans ; F:\\From centers">
      <button class="btn sm" type="button" data-pick="source" data-for="watch_folders" data-append="1">ضيف فولدر…</button></div>
    <div class="row"><label>الحفظ التلقائي بعد</label><input class="in" type="number" min="1" max="30" style="max-width:90px;flex:none" data-c="auto_save_seconds"> ثانية</div>
    <div class="row" data-r="autoRow"><label class="sw"><input type="checkbox" data-c="autostart"> شغّل الأداة لوحدها مع تشغيل الكمبيوتر (عشان زرار الإضافة يبقى موجود على طول)</label></div>
    <div class="row"><button class="btn pri" type="button" data-a="saveCfg">حفظ الإعدادات</button><span class="muted" data-r="cfgMsg"></span></div>
  </section>

  <div class="row" style="margin-top:0">
    <label style="min-width:0">📨 الأشعة جاية منين؟ <span class="muted">(اختياري)</span></label>
    <input class="in" data-r="source" list="xi-srcs" placeholder="مثلاً: مركز الفا — واتساب" style="max-width:420px">
  </div>

  <div class="ways">
    <div class="drop" data-r="drop" tabindex="0">
      <div style="font-size:2rem">🦷</div>
      <div class="big">اسحب الأشعة وحطها هنا</div>
      <div class="muted">أو دوس هنا وأختار الملفات · أو الصق صورة (Ctrl+V)</div>
      <input type="file" data-r="pick" multiple hidden>
    </div>
    <div class="box" style="margin:0">
      <h3>📍 الأشعة موجودة فين على الكمبيوتر؟</h3>
      <div class="muted">اكتب مكان الملف أو الفولدر، والبرنامج يدخل يجيبها.</div>
      <div class="row"><input class="in ltr" data-r="path" placeholder="D:\\Scans\\2026\\patient.jpg  أو  D:\\Scans">
        <button class="btn pri" type="button" data-a="go">هاتها</button></div>
      <div class="row" style="margin:0"><button class="btn sm" type="button" data-a="pickFile">اختار ملف…</button>
        <button class="btn sm" type="button" data-a="pickDir">اختار فولدر…</button></div>
    </div>
  </div>

  <section class="box" data-r="browse" hidden>
    <div class="row" style="margin:0"><h3 style="flex:1" data-r="browseTitle"></h3>
      <button class="btn pri sm" type="button" data-a="addBrowse">ضيف المختار</button>
      <button class="btn sm" type="button" data-a="closeBrowse">✕</button></div>
    <div class="grid" data-r="browseGrid"></div>
  </section>

  <section class="box">
    <div class="row" style="margin:0">
      <h3 style="flex:1">🕘 أشعة جديدة على الكمبيوتر <span class="muted" data-r="recentCount"></span></h3>
      <select class="in" data-r="days" style="flex:none">
        <option value="1">النهارده</option><option value="3">آخر ٣ أيام</option><option value="7">آخر أسبوع</option><option value="30">آخر شهر</option></select>
      <button class="btn sm" type="button" data-a="recent">↻</button>
      <button class="btn pri sm" type="button" data-a="addRecent">ضيف المختار</button>
    </div>
    <div class="muted" data-r="recentWhere"></div>
    <div class="grid" data-r="recentGrid"></div>
    <label class="sw" style="margin-top:8px"><input type="checkbox" data-r="showDone"> اعرض كمان اللي اتضافوا قبل كده</label>
  </section>

  <div class="q" data-r="queue"></div>
</div>
<div class="foot"><span data-r="rbIcon"></span><span class="grow muted" data-r="rbMsg"></span>
  <button class="btn sm pri" type="button" data-a="reload" hidden>اعرض الأرشيف الجديد</button>
  <button class="btn sm" type="button" data-a="rebuild">تحديث الأرشيف دلوقتي</button></div>
<datalist id="xi-plist"></datalist><datalist id="xi-srcs"></datalist>`;

let root = null, S = null, byKey = new Map(), lastName = "", opts = {}, recent = [], browse = [];
const items = new Map();
let seq = 0, chain = Promise.resolve();
const R = n => root.querySelector(`[data-r="${n}"]`);

function build() {
  const st = document.createElement("style"); st.textContent = CSS; document.head.appendChild(st);
  root = document.createElement("div"); root.className = "xi"; root.hidden = true; root.innerHTML = HTML;
  document.body.appendChild(root);
  root.addEventListener("click", onClick);
  R("auto").onchange = e => api("/api/config", {auto_save: e.target.checked}).then(setState).catch(() => {});
  R("days").onchange = () => { api("/api/config", {recent_days: +R("days").value}).catch(() => {}); loadRecent(); };
  R("showDone").onchange = () => renderGrid(R("recentGrid"), recent);
  R("pick").onchange = e => { addFiles([...e.target.files]); e.target.value = ""; };
  R("path").onkeydown = e => { if (e.key === "Enter") goPath(R("path").value); };
  R("drop").onkeydown = e => { if (e.key === "Enter" || e.key === " ") R("pick").click(); };
  let depth = 0;
  root.addEventListener("dragenter", e => { e.preventDefault(); depth++; root.classList.add("over"); });
  root.addEventListener("dragleave", () => { if (--depth <= 0) { depth = 0; root.classList.remove("over"); } });
  root.addEventListener("dragover", e => e.preventDefault());
  root.addEventListener("drop", e => { e.preventDefault(); depth = 0; root.classList.remove("over"); addFiles([...(e.dataTransfer.files || [])]); });
  document.addEventListener("paste", e => {
    if (root.hidden || (e.target.closest && e.target.closest("input"))) return;
    const fs = [...(e.clipboardData?.files || [])];
    if (fs.length) addFiles(fs.map((f, i) => f.name && f.name !== "image.png" ? f :
      new File([f], `xray-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-")}${i ? "-" + i : ""}.png`, {type: f.type, lastModified: Date.now()})));
  });
  document.addEventListener("keydown", e => { if (!root.hidden && e.key === "Escape" && !STANDALONE && !e.target.closest("input")) close(); });
  addEventListener("beforeunload", e => { if (pending()) { e.preventDefault(); e.returnValue = ""; } });
}

const pending = () => [...items.values()].some(it => !it.done && !it.removed);

async function onClick(e) {
  const b = e.target.closest("[data-a],[data-pick]");
  if (!b) return;
  const a = b.dataset.a;
  if (b.dataset.pick) {
    b.disabled = true;
    try {
      const r = await api("/api/pick", {kind: b.dataset.pick});
      if (r.path) { const inp = root.querySelector(`[data-c="${b.dataset.for}"]`); inp.value = b.dataset.append && inp.value ? inp.value + " ; " + r.path : r.path; }
    } catch (x) {} finally { b.disabled = false; }
    return;
  }
  if (a === "close") close();
  else if (a === "settings") R("setup").hidden = !R("setup").hidden;
  else if (a === "openRoot") api("/api/open", {}).catch(() => {});
  else if (a === "saveCfg") saveCfg();
  else if (a === "unpreset") { opts.name = ""; R("preset").hidden = true; }
  else if (a === "go") goPath(R("path").value);
  else if (a === "pickFile" || a === "pickDir") {
    b.disabled = true;
    try { const r = await api("/api/pick", {kind: a === "pickFile" ? "xray" : "source"}); if (r.path) { R("path").value = r.path; goPath(r.path); } }
    catch (x) {} finally { b.disabled = false; }
  }
  else if (a === "recent") loadRecent();
  else if (a === "addRecent") addSelected(R("recentGrid"), recent);
  else if (a === "addBrowse") addSelected(R("browseGrid"), browse);
  else if (a === "closeBrowse") R("browse").hidden = true;
  else if (a === "rebuild") api("/api/rebuild", {}).then(rb => { showRebuild(rb); pollRebuild(); }).catch(() => {});
  else if (a === "reload") { if (opts.onRebuilt) opts.onRebuilt(); else location.reload(); }
}

/* ---------------------------------------------------------------- state & settings */
function setState(s) {
  S = s;
  byKey = new Map();
  for (const p of s.patients) {
    const k = key(p.n); let e = byKey.get(k);
    if (!e) byKey.set(k, e = {n: p.n, years: [], count: 0});
    e.years.push(p.y); e.count += p.c;
    if (p.y >= e.years.reduce((m, y) => y > m ? y : m, "")) e.n = p.n;
  }
  const names = [...new Set([...byKey.values()].map(e => e.n))].sort((a, b) => a.localeCompare(b, "ar"));
  document.getElementById("xi-plist").innerHTML = names.map(n => `<option value="${esc(n)}">`).join("");
  document.getElementById("xi-srcs").innerHTML = (s.sources || []).map(n => `<option value="${esc(n)}">`).join("");
  R("auto").checked = !!s.auto_save;
  const oc = R("ocr");
  if (s.ocr) { oc.textContent = "قراءة الأسماء: " + s.ocr; oc.className = "chip ok"; }
  else { oc.textContent = "قراءة الأسماء مش متاحة — اكتب الاسم بإيدك"; oc.className = "chip warn"; }
  const c = n => root.querySelector(`[data-c="${n}"]`);
  c("xray_root").value = s.xray_root || ""; c("rebuild_cmd").value = s.rebuild_cmd || "";
  c("ignore_words").value = (s.ignore_words || []).join("، "); c("auto_save_seconds").value = s.auto_save_seconds || 5;
  c("watch_folders").value = (s.watch_folders || []).join(" ; "); c("autostart").checked = !!s.autostart;
  R("autoRow").hidden = !s.windows;
  R("days").value = String([1, 3, 7, 30].includes(+s.recent_days) ? s.recent_days : 7);
  const ny = Object.keys(s.year_folders || {}).length;
  R("rootInfo").textContent = s.configured ? `لقيت ${num(ny)} فولدر سنة و ${num(s.patients.length)} فولدر مريض.` : "لسه ما اتحددش فولدر الأشعة.";
  if (!s.configured) R("setup").hidden = false;
  for (const it of items.values()) if (!it.done) refreshDest(it);
  showRebuild(s.rebuild);
}

async function saveCfg() {
  const c = n => root.querySelector(`[data-c="${n}"]`), m = R("cfgMsg");
  m.textContent = ""; m.className = "muted";
  try {
    const s = await api("/api/config", {
      xray_root: c("xray_root").value, rebuild_cmd: c("rebuild_cmd").value,
      ignore_words: c("ignore_words").value.split(/[،,\n]/).map(x => x.trim()).filter(Boolean),
      watch_folders: c("watch_folders").value.split(/[;\n]/).map(x => x.trim()).filter(Boolean),
      auto_save_seconds: +c("auto_save_seconds").value || 5,
      ...(S.windows && c("autostart").checked !== S.autostart ? {autostart: c("autostart").checked} : {})});
    setState(s);
    m.textContent = "اتحفظ ✔"; m.className = "ok-t";
    if (s.configured) setTimeout(() => { R("setup").hidden = true; m.textContent = ""; }, 900);
    loadRecent();
  } catch (e) { m.textContent = e.message; m.className = "err-t"; }
}

/* ---------------------------------------------------------------- files already on the PC (recent / folder) */
async function loadRecent() {
  R("recentGrid").innerHTML = '<div class="muted"><span class="spin"></span> بدوّر…</div>';
  try {
    const r = await api("/api/recent", {days: +R("days").value});
    recent = r.files;
    R("recentWhere").innerHTML = (r.folders.length ? "بدوّر في: " + [...new Set(r.folders.map(f => f.name))].map(esc).join("، ") + ". " : "") +
      "الأشعة اللي جاتلك على <b>واتساب</b>: افتحها في واتساب على الكمبيوتر واعملها <b>تنزيل</b> — هتظهر هنا على طول.";
    renderGrid(R("recentGrid"), recent);
  } catch (e) { R("recentGrid").innerHTML = `<div class="err-t">${esc(e.message)}</div>`; }
}

function renderGrid(grid, files) {
  const showDone = grid === R("recentGrid") ? R("showDone").checked : true;
  const list = files.filter(f => showDone || !f.done);
  if (grid === R("recentGrid")) {
    const nDone = files.length - files.filter(f => !f.done).length;
    R("recentCount").textContent = files.length ? `(${num(files.length - nDone)} جديدة${nDone ? " · " + num(nDone) + " اتضافت قبل كده" : ""})` : "";
  }
  if (!list.length) { grid.innerHTML = '<div class="muted">مفيش صور جديدة هنا.</div>'; return; }
  grid.innerHTML = list.map(f => `<button type="button" class="tile${f.sel ? " sel" : ""}${f.busy ? " busy" : ""}" data-t="${f.t}" title="${esc(f.path)}">
    <div class="im"><img loading="lazy" src="${BASE}/api/thumb?t=${f.t}" alt="" onerror="this.replaceWith('🩻')"></div>
    <span class="ck">${f.sel ? "✓" : ""}</span>${f.done ? '<span class="done">اتضافت</span>' : ""}
    ${/واتساب/.test(f.where) ? '<span class="wa">واتساب</span>' : ""}<div class="cap">${esc(when(f.mtime))}</div><div class="cap ltr">${esc(f.name)}</div></button>`).join("");
  grid.onclick = e => {
    const t = e.target.closest(".tile"); if (!t) return;
    const f = files.find(x => x.t === t.dataset.t); if (!f || f.busy) return;
    f.sel = !f.sel; t.classList.toggle("sel", f.sel); t.querySelector(".ck").textContent = f.sel ? "✓" : "";
  };
}

function addSelected(grid, files) {
  const sel = files.filter(f => f.sel && !f.busy);
  if (!sel.length) { alert("اختار الأشعة الأول (دوس عليها)."); return; }
  for (const f of sel) { f.sel = false; f.busy = true; addPath({t: f.t, name: f.name, size: f.size}); }
  renderGrid(grid, files);
}

async function goPath(path) {
  path = (path || "").trim().replace(/^"|"$/g, "");
  if (!path) { R("path").focus(); return; }
  try {
    const r = await api("/api/browse", {path});
    if (r.file) { addPath({t: r.files[0].t, name: r.files[0].name, size: r.files[0].size}); R("path").value = ""; return; }
    browse = r.files;
    R("browse").hidden = false;
    R("browseTitle").textContent = `الأشعة اللي في «${path}» (${num(browse.length)}) — دوس على اللي عايزه`;
    renderGrid(R("browseGrid"), browse);
  } catch (e) { alert(e.message); }
}

/* ---------------------------------------------------------------- the queue */
function addFiles(list) {
  for (const f of list) {
    if (!f || !f.size) continue;
    const it = {local: ++seq, file: f, name: f.name, size: f.size};
    it.thumb = /^image\/(jpeg|png|gif|webp|bmp)/.test(f.type) ? URL.createObjectURL(f) : "";
    enqueue(it, () => api("/api/analyze", {data: f, headers: {
      "X-File-Name": encodeURIComponent(f.name || "xray.jpg"), "X-Last-Modified": String(f.lastModified || 0),
      "Content-Type": "application/octet-stream"}}, true));
  }
}
function addPath(f) {
  const it = {local: ++seq, name: f.name, size: f.size, thumb: f.t ? `${BASE}/api/thumb?t=${f.t}` : ""};
  enqueue(it, () => api("/api/import-path", f.t ? {t: f.t} : {path: f.path}));
}
function enqueue(it, job) {
  items.set(it.local, it);
  const el = document.createElement("div");
  el.className = "item"; it.el = el;
  el.innerHTML = `<div class="th">${it.thumb ? `<img src="${it.thumb}" alt="">` : "🩻"}</div>
    <div class="body"><div class="fn">${esc(it.name)}${it.size ? " · " + fmtSize(it.size) : ""}</div>
    <div class="st"><span class="spin"></span> جاري قراءة اسم المريض من على الأشعة…</div></div>`;
  R("queue").prepend(el);
  el.scrollIntoView({behavior: "smooth", block: "nearest"});
  chain = chain.then(async () => {
    try {
      const r = await job();
      if (it.removed) { api("/api/discard", {id: r.id}).catch(() => {}); return; }
      it.r = r; it.id = r.id; renderForm(it);
    } catch (e) {
      el.classList.add("err");
      el.querySelector(".st").innerHTML = `<span class="err-t">ما قدرتش أفتح الملف: ${esc(e.message)}</span> <button class="btn sm" type="button">شيل</button>`;
      el.querySelector(".st button").onclick = () => { el.remove(); items.delete(it.local); };
    }
  });
}

function renderForm(it) {
  const r = it.r, el = it.el;
  if (r.preview && !it.thumb) el.querySelector(".th").innerHTML = `<img src="${r.preview}" alt="">`;
  const preset = opts.name || "";
  let name = r.best, confident = r.confident, status;
  if (preset) {
    const clash = r.best && r.confident && key(r.best) !== key(preset);
    name = preset; confident = !clash;
    status = clash ? `<span class="warn-t">⚠ المكتوب على الأشعة «${esc(r.best)}» — مش نفس المريض! اتأكد</span>` : `<span class="ok-t">✔ للمريض ${esc(preset)}</span>`;
  } else if (r.best && r.confident) status = `<span class="ok-t">✔ لقيت الاسم</span>`;
  else if (r.best) status = `<span class="warn-t">⚠ ده اللي قدرت أقراه — اتأكد من الاسم</span>`;
  else status = `<span class="warn-t">✎ ما لقيتش اسم مكتوب — اكتب اسم المريض</span>`;
  if (r.note) status += ` <span class="muted">(${esc(r.note)})</span>`;
  const years = [...new Set([r.year, ...S.years])].sort().reverse();
  const cands = r.candidates.map((c, i) => `<span class="cand" data-i="${i}" title="${esc(SRC[c.source] || "")}${c.read_as ? " — اتقرا: " + esc(c.read_as) : ""}">
      <span class="pc">${esc(c.name)}</span><small>${esc(SRC[c.source] || "")}</small>
      ${c.source === "ocr" || c.source === "label" ? '<button class="x" type="button" title="ده مش اسم مريض — تجاهله دايماً">✕</button>' : ""}</span>`).join("");
  const same = lastName && !preset && !r.candidates.some(c => key(c.name) === key(lastName))
    ? `<span class="cand" data-same="1"><span class="pc">${esc(lastName)}</span><small>نفس المريض اللي قبله</small></span>` : "";
  el.querySelector(".body").innerHTML = `
    <div class="fn">${esc(r.filename)} · ${fmtSize(r.size)}</div>
    <div class="st">${status}</div>
    <div class="fields">
      <input type="text" class="in nm" list="xi-plist" placeholder="اسم المريض" value="${esc(name)}" autocomplete="off">
      <select class="in yr" title="السنة">${years.map(y => `<option value="${y}"${y === r.year ? " selected" : ""}>${num(y)}</option>`).join("")}<option value="other">سنة تانية…</option></select>
    </div>
    <div class="muted" style="margin-top:4px">السنة: ${esc(r.year_source || "")}</div>
    ${cands || same ? `<div class="cands">${cands}${same}</div>` : ""}
    <div class="dest"></div>
    <div class="acts"><button class="btn pri save" type="button">💾 حفظ في الأرشيف</button>
      <button class="btn rm" type="button">شيل</button><span class="cd muted"></span></div>
    ${r.ocr_text && r.ocr_text.length ? `<details><summary>الكلام اللي اتقرا من على الأشعة</summary><pre>${esc(r.ocr_text.join("\n"))}</pre></details>` : ""}`;
  el.insertAdjacentHTML("beforeend", '<div class="bar"></div>');
  const nm = el.querySelector(".nm"), yr = el.querySelector(".yr");
  nm.addEventListener("input", () => { stopCd(it); refreshDest(it); });
  nm.addEventListener("keydown", e => { if (e.key === "Enter") save(it); });
  nm.addEventListener("focus", () => stopCd(it));
  yr.addEventListener("change", () => {
    stopCd(it);
    if (yr.value === "other") {
      const y = (prompt("اكتب السنة (مثلاً 2019):") || "").replace(/[٠-٩]/g, d => d.charCodeAt(0) - 1632).trim();
      if (/^(19|20)\d\d$/.test(y)) { yr.insertAdjacentHTML("afterbegin", `<option value="${y}">${num(y)}</option>`); yr.value = y; }
      else yr.value = r.year;
    }
    refreshDest(it);
  });
  el.querySelectorAll(".cand").forEach(c => c.addEventListener("click", async e => {
    stopCd(it);
    if (e.target.closest(".x")) {
      const cand = r.candidates[+c.dataset.i];
      if (!confirm(`«${cand.name}» مش اسم مريض (مكتوب على كل الأشعة)؟\nالبرنامج هيتجاهله بعد كده.`)) return;
      await api("/api/ignore", {text: cand.read_as || cand.name}).catch(() => {});
      if (key(nm.value) === key(cand.name)) nm.value = "";
      c.remove(); refreshDest(it); return;
    }
    nm.value = c.dataset.same ? lastName : r.candidates[+c.dataset.i].name;
    refreshDest(it);
  }));
  el.querySelector(".save").onclick = () => save(it);
  el.querySelector(".rm").onclick = () => remove(it);
  refreshDest(it);
  if (confident && name && S.auto_save) startCd(it);
  else if (!name) nm.focus();
}

function refreshDest(it) {
  if (!it.el || !it.r || it.done) return;
  const nm = it.el.querySelector(".nm"), yr = it.el.querySelector(".yr"), d = it.el.querySelector(".dest");
  if (!nm) return;
  const name = cleanName(nm.value), y = yr.value;
  it.el.querySelectorAll(".cand").forEach(c => c.classList.toggle("on", key(c.querySelector(".pc").textContent) === key(name)));
  it.el.querySelector(".save").disabled = !name || !S.configured;
  if (!S.configured) { d.innerHTML = '<span class="err-t">حدد فولدر الأشعة الأساسي من الإعدادات الأول.</span>'; return; }
  if (!name) { d.textContent = ""; return; }
  const e = byKey.get(key(name)), sep = S.sep || "\\", yf = (S.year_folders || {})[y] || y;
  let tag;
  if (e && e.years.includes(y)) tag = `<span class="tag old">مريض موجود · ${num(e.count)} ملف</span>`;
  else if (e) tag = `<span class="tag old">مريض موجود في ${e.years.map(num).join("، ")}</span><span class="tag new">أول أشعة له في ${num(y)}</span>`;
  else tag = '<span class="tag new">مريض جديد</span>';
  const src = cleanName(R("source").value);
  d.innerHTML = `هتتحفظ في: <b class="ltr">${esc(yf)}${sep}${esc(e ? e.n : name)}${sep}${src ? esc(src) + " - " : ""}${esc(it.r.filename)}</b>${tag}`;
}

function startCd(it) {
  const secs = Math.max(1, S.auto_save_seconds || 5), bar = it.el.querySelector(".bar"), cd = it.el.querySelector(".cd");
  let left = secs;
  cd.innerHTML = `<span>هتتحفظ لوحدها خلال ${num(left)} ث</span> — <a href="#" style="color:var(--accent2,#60a5fa)">استنى</a>`;
  cd.querySelector("a").onclick = e => { e.preventDefault(); stopCd(it); };
  requestAnimationFrame(() => { bar.style.transitionDuration = secs + "s"; bar.style.width = "100%"; });
  it.timer = setInterval(() => {
    if (--left <= 0) { stopCd(it); save(it); return; }
    cd.firstChild.textContent = `هتتحفظ لوحدها خلال ${num(left)} ث`;
  }, 1000);
}
function stopCd(it) {
  if (!it.timer) return;
  clearInterval(it.timer); it.timer = null;
  const bar = it.el.querySelector(".bar"); if (bar) { bar.style.transitionDuration = "0s"; bar.style.width = "0"; }
  const cd = it.el.querySelector(".cd"); if (cd) cd.textContent = "";
}

async function save(it) {
  if (it.saving || it.done) return;
  stopCd(it);
  const nm = it.el.querySelector(".nm"), y = it.el.querySelector(".yr").value, name = cleanName(nm.value);
  if (!name) { nm.focus(); return; }
  it.saving = true;
  const btn = it.el.querySelector(".save"); btn.disabled = true; btn.innerHTML = '<span class="spin"></span> جاري الحفظ…';
  try {
    const r = await api("/api/save", {id: it.id, name, year: y, source: R("source").value});
    it.done = true; lastName = r.folder || name;
    if (it.thumb && it.thumb.startsWith("blob:")) URL.revokeObjectURL(it.thumb);
    it.el.className = "item saved";
    it.el.innerHTML = `<div class="th">${r.duplicate ? "♻️" : "✅"}</div><div class="body">
      <div><b>${esc(r.folder || name)}</b> · ${num(y)} ${r.new_patient ? '<span class="tag new">مريض جديد</span>' : ""}</div>
      <div class="muted">${r.duplicate ? "الأشعة دي موجودة أصلاً عند المريض — ما اتنسختش تاني:" : "اتحفظت في:"} <span class="ltr">${esc(r.rel)}</span>
      <a href="#" style="color:var(--accent2,#60a5fa)">وريني</a></div></div>`;
    it.el.querySelector("a").onclick = e => { e.preventDefault(); api("/api/open", {path: r.path}).catch(() => {}); };
    api("/api/state").then(setState).catch(() => {});
    if (r.rebuild) showRebuild(r.rebuild);
    pollRebuild();
    for (const f of recent) if (f.busy && f.name === it.r.filename) f.done = true;
  } catch (e) {
    it.saving = false; btn.disabled = false; btn.textContent = "💾 حفظ في الأرشيف";
    it.el.querySelector(".cd").innerHTML = `<span class="err-t">${esc(e.message)}</span>`;
  }
}

function remove(it) {
  stopCd(it); it.removed = true;
  if (it.id) api("/api/discard", {id: it.id}).catch(() => {});
  if (it.thumb && it.thumb.startsWith("blob:")) URL.revokeObjectURL(it.thumb);
  it.el.remove(); items.delete(it.local);
}

/* ---------------------------------------------------------------- archive rebuild */
let pollT = null, sawWork = false;
function showRebuild(rb) {
  if (!rb || !root) return;
  const busy = rb.state === "running" || rb.state === "waiting";
  if (busy) sawWork = true;
  R("rbIcon").innerHTML = busy ? '<span class="spin"></span>' : rb.state === "done" ? "✅" : rb.state === "error" ? "⚠️" : "🗂️";
  R("rbMsg").textContent = rb.state === "running" ? "جاري تحديث الأرشيف… (ممكن ياخد شوية)" :
    rb.state === "waiting" ? "هيتم تحديث الأرشيف بعد ثواني…" :
    rb.state === "done" ? `الأرشيف اتحدث ✔ (${rb.finished || ""})` :
    rb.state === "error" ? (rb.msg || "حصل خطأ في تحديث الأرشيف") :
    !rb.configured ? "تحديث الأرشيف مش متظبط — حدد ملف rebuild.bat من الإعدادات" : "الأرشيف جاهز";
  R("rbMsg").title = rb.log || "";
  root.querySelector('[data-a="rebuild"]').disabled = !rb.configured || busy;
  root.querySelector('[data-a="reload"]').hidden = !(sawWork && rb.state === "done") || STANDALONE;
}
function pollRebuild() {
  clearTimeout(pollT);
  pollT = setTimeout(async () => {
    try {
      const rb = await api("/api/rebuild"); showRebuild(rb);
      if (rb.state === "running" || rb.state === "waiting") pollRebuild();
      else if (rb.state === "done") api("/api/state").then(setState).catch(() => {});
    } catch (e) { pollRebuild(); }
  }, 1500);
}

/* ---------------------------------------------------------------- open / close */
async function open(o) {
  opts = o || {};
  if (!root) build();
  root.hidden = false;
  if (!STANDALONE) document.body.style.overflow = "hidden";
  R("source").value = "";
  R("preset").hidden = !opts.name;
  R("presetName").textContent = opts.name || "";
  try {
    setState(await api("/api/state"));
    if (S.rebuild && (S.rebuild.state === "running" || S.rebuild.state === "waiting")) pollRebuild();
    loadRecent();
  } catch (e) {
    R("queue").innerHTML = `<div class="box err-t">${esc(e.message)}</div>`;
  }
}
function close() {
  if (pending() && !confirm("فيه أشعة لسه ما اتحفظتش. تقفل برضه؟")) return;
  for (const it of [...items.values()]) if (!it.done) remove(it);
  root.hidden = true;
  document.body.style.overflow = "";
  if (opts.onClose) opts.onClose();
}

window.XImport = {open, close, base: BASE, get isOpen() { return !!root && !root.hidden; }};
if (STANDALONE) open({});
})();
