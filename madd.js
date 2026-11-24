/* Add X-rays from any device (phone / tablet / PC without the import tool).
   Only the DISPLAY COPY (preview + thumbnail) goes to the clinic Google Drive; the original stays on the device.
   The patient name is read from the picture on the device itself (Tesseract OCR, Arabic + English)
   and matched to the archive the same way the PC import tool does. */
(function () {
"use strict";
if (window.XMAdd) return;

/* ================================================================ text helpers (same rules as add_xray.py) */
const AR_MAP = {"أ": "ا", "إ": "ا", "آ": "ا", "ٱ": "ا", "ى": "ي", "ئ": "ي", "ؤ": "و", "ة": "ه"};
const TASHKEEL = /[ً-ٰٟـ]/g;
const digits = s => (s || "").replace(/[٠-٩]/g, d => d.charCodeAt(0) - 1632).replace(/[۰-۹]/g, d => d.charCodeAt(0) - 1776);
function key(s) {
  s = digits((s || "").normalize("NFKC").toLowerCase());
  s = s.replace(TASHKEEL, "").replace(/[أإآٱىئؤة]/g, c => AR_MAP[c]);
  return s.replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
}
function cleanName(s) {
  s = (s || "").normalize("NFKC").replace(/\^/g, " ").replace(/[<>:"/\\|?*\x00-\x1f]/g, " ");
  s = s.split(/\s+/).join(" ").replace(/^[ .\-_,]+|[ .\-_,]+$/g, "");
  if (s && (s.toUpperCase() === s || s.toLowerCase() === s) && /[A-Za-z]/.test(s))
    s = s.split(" ").map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(" ");
  return s.slice(0, 80).replace(/^[ .]+|[ .]+$/g, "");
}
const WORD_RE = /[\p{L}\p{M}]+(?:['’][\p{L}\p{M}]+)?/gu;
const words = s => (s || "").match(WORD_RE) || [];
const ARABIC_RE = /[؀-ۿ]/, LATIN_RE = /[A-Za-z]/;

/* difflib.SequenceMatcher(None, a, b).ratio() */
function lcs(a, b, a0, a1, b0, b1) {
  let best = 0, bi = a0, bj = b0, prev = new Array(b1 - b0 + 1).fill(0);
  for (let i = a0; i < a1; i++) {
    const cur = new Array(b1 - b0 + 1).fill(0);
    for (let j = b0; j < b1; j++) {
      if (a[i] === b[j]) {
        const v = prev[j - b0] + 1; cur[j - b0 + 1] = v;
        if (v > best) { best = v; bi = i - v + 1; bj = j - v + 1; }
      }
    }
    prev = cur;
  }
  return [bi, bj, best];
}
function matches(a, b, a0, a1, b0, b1) {
  if (a0 >= a1 || b0 >= b1) return 0;
  const [i, j, k] = lcs(a, b, a0, a1, b0, b1);
  if (!k) return 0;
  return k + matches(a, b, a0, i, b0, j) + matches(a, b, i + k, a1, j + k, b1);
}
function sm(a, b) {
  const t = a.length + b.length;
  return t ? 2 * matches(a, b, 0, a.length, 0, b.length) / t : 1;
}
function ratio(a, b) {
  if (!a || !b) return 0;
  const r1 = sm(a, b);
  const ta = a.split(" ").sort().join(" "), tb = b.split(" ").sort().join(" ");
  return Math.max(r1, ta !== a || tb !== b ? sm(ta, tb) : r1);
}

const STOP = new Set(`dental dent dentist dentistry clinic clinics clinique center centre centr hospital medical medicine dr doctor prof
panoramic pano panorama ceph cephalometric cephalo cbct periapical bitewing bite wing occlusal tmj sinus
xray x ray rays radiograph radiography radiology image images img scan photo picture
left right upper lower up down front back lat lateral pa ap mandible maxilla jaw teeth tooth molar
date time id no number code file age sex gender male female m f dob birth birthday born years year yrs y
kv kvp ma mas sec s ms mm cm scale exposure exp dose program prog mode adult child children kid standard normal
patient pt name names surname first last family report page of and the by for with at on in to
planmeca carestream kodak sirona dentsply vatech sidexis romexis ezdent newtom owandy myray durr dürr acteon
soredex instrumentarium gendex villa cs orthophos promax ortho pantomograph hdr vistascan digora apixia
quickvision trophy rvg schick cdr suni dexis xios fona satelec castellini air techniques
morning evening am pm mon tue wed thu fri sat sun jan feb mar apr may jun jul aug sep oct nov dec
عياده عيادات عيادة مركز مستشفي مستشفى د دكتور الدكتور دكتوره طبيب لطب طب الاسنان اسنان الأسنان
اشعه أشعة الاشعه بانوراما بانوراميك التاريخ تاريخ السن العمر سن ذكر انثي أنثى المريض مريض الاسم اسم
رقم الملف ملف كود يمين يسار علوي سفلي فك ضرس سنه سنة`.split(/\s+/).map(key));

const LABEL_RE = /(?:patient\s*'?s?\s*name|pat\.?\s*name|pt\.?\s*name|patient|name|nom|اسم\s*المريض|اسم\s*المريضه|الاسم|اسم|المريض|المريضه)\s*[:：=\-–]\s*(.+)/i;
const LABEL_START_RE = /^\s*(?:patient\s*name|patient|name|الاسم|اسم\s*المريض)\s+(.{3,})$/i;
const CUT_RE = /(?:\b(?:id|dob|d\.o\.b|birth|born|date|age|sex|gender|tel|phone|mob|mobile|doctor|dr|file|no|code|ref|ex|kv|ma)\b|تاريخ|السن|العمر|النوع|رقم|موبايل|تليفون|الطبيب|دكتور|كود|\d)/i;

function nameFromValue(v) {
  v = v.replace(/\^/g, " ");
  const m = v.match(CUT_RE);
  if (m) v = v.slice(0, m.index);
  let w = words(v);
  const all = w.length;
  w = w.filter(x => !STOP.has(key(x)) || all <= 2);
  return w.slice(0, 6).join(" ").trim();
}
function isNameLike(s) {
  const w = words(s);
  if (w.length < 2 || w.length > 6) return false;
  if (w.some(x => x.length < 2)) return false;
  if (w.some(x => STOP.has(key(x)))) return false;
  const letters = w.reduce((n, x) => n + x.length, 0);
  return letters >= 0.7 * s.replace(/\s/g, "").length;
}

/* ---- sound-alike matching: English name on the X-ray <-> Arabic folder name */
const LAT_DI = [["kh", "X"], ["sh", "S"], ["ch", "S"], ["gh", "G"], ["ph", "F"], ["th", "T"], ["dh", "Z"], ["ck", "K"]];
const LAT_UP = {X: "x", S: "S", G: "g", F: "f", T: "t", Z: "z", K: "k"};
const LAT_1 = {b: "b", p: "b", t: "t", d: "d", k: "k", c: "k", q: "k", g: "g", j: "g", s: "s", z: "z", f: "f", v: "f", l: "l", m: "m", n: "n", r: "r", x: "ks", h: "H",
  a: "a", e: "i", i: "i", o: "u", u: "u", w: "u", y: "i"};
const AR_1 = {"ب": "b", "ت": "t", "ط": "t", "ث": "t", "د": "d", "ض": "d", "ذ": "z", "ز": "z", "ظ": "z", "س": "s", "ص": "s", "ش": "S", "ج": "g", "غ": "g", "ق": "k", "ك": "k", "خ": "x",
  "ف": "f", "ل": "l", "م": "m", "ن": "n", "ر": "r", "ح": "H", "ه": "H", "ع": "E", "ء": "E", "ئ": "E", "ؤ": "E",
  "ا": "a", "أ": "a", "آ": "a", "ى": "a", "ة": "a", "ٱ": "a", "إ": "i", "ي": "i", "و": "u"};
function phon(tok) {
  let t = (tok || "").normalize("NFKC").replace(TASHKEEL, "").toLowerCase();
  let codes;
  if (LATIN_RE.test(t)) {
    t = t.replace(/t(?=[aeiou]?l+ah?$)/, "");
    for (const [a, b] of LAT_DI) t = t.split(a).join(b);
    codes = [...t].map(c => LAT_UP[c] !== undefined ? LAT_UP[c] : (LAT_1[c] || ""));
  } else codes = [...t].map(c => AR_1[c] || "");
  const out = [];
  for (const c of codes) if (c && (!out.length || c !== out[out.length - 1])) out.push(c);
  let s = out.join("");
  s = (s.startsWith("H") ? "h" : "") + s.replace(/^H+/, "");
  s = s.replace(/[HE]/g, "");
  return s.replace(/([aiu])\1+/g, "$1");
}
const cons = p => p.replace(/[aiu]/g, "");
const nameWords = s => (s || "").split(/[\s\-_.]+/).filter(Boolean);

const BUILTIN_AR = {};
`محمد=mohamed,mohammed,mohammad,muhammad,mohamad|أحمد=ahmed,ahmad|محمود=mahmoud,mahmud,mahmood|مصطفى=mostafa,moustafa,mustafa
علي=ali,aly|حسن=hassan,hasan|حسين=hussein,hussien,hosein,hossein,husein|إبراهيم=ibrahim,ebrahim|إسماعيل=ismail,esmail,ismael,esmaeil
عمر=omar,omer|عمرو=amr|خالد=khaled,khalid|طارق=tarek,tareq,tarik|يوسف=youssef,yousef,yousif,yusuf,joseph|كريم=karim,kareem
السيد=elsayed,alsayed,sayed,elsaid|سيد=sayyed|سعيد=said,saeed,saied|سعد=saad|عبدالله=abdallah,abdullah,abdalla
عبد=abd,abdel,abdul,abdo|عبده=abdou|جمال=gamal,jamal|سمير=samir,sameer|سامي=samy,sami|سامح=sameh|فتحي=fathy,fathi
مجدي=magdy,magdi|هاني=hany,hani|حمدي=hamdy,hamdi|رامي=ramy,rami|وائل=wael|وليد=walid,waleed|أسامة=osama,usama|أيمن=ayman
أشرف=ashraf|عادل=adel|عماد=emad,imad|عصام=essam,esam|هشام=hesham,hisham|شريف=sherif,sherief,sharif|تامر=tamer
مينا=mina,mena|جرجس=girgis,gerges|جورج=george|بيتر=peter|مارك=mark|مارينا=marina|ماري=mary|إسلام=islam,eslam
مهاب=mohab|زياد=ziad,zeyad|مازن=mazen|حازم=hazem|حسام=hossam,hosam|حمادة=hamada|رضا=reda|ممدوح=mamdouh|ناصر=nasser,naser
صلاح=salah|فؤاد=fouad,fuad|نبيل=nabil,nabeel|رأفت=raafat,rafat|رفعت=refaat|شعبان=shaaban,shaban|رمضان=ramadan
عزت=ezzat|جلال=galal|كمال=kamal|منير=mounir,monir|منصور=mansour|حامد=hamed|حمد=hamad|زكريا=zakaria,zakariya|نادر=nader
فاطمة=fatma,fatima,fatmah|منى=mona|سارة=sara,sarah|نور=nour,noor|آية=aya,ayah|إسراء=esraa,israa|أسماء=asmaa,asma
دعاء=doaa,duaa|علاء=alaa|هبة=heba,hiba|هند=hend,hind|مروة=marwa|رنا=rana|ريم=reem,rim|مي=mai,may|ياسمين=yasmin,yasmeen
ندى=nada|سلمى=salma|مريم=mariam,maryam,miriam|هنا=hana|تقى=toka,tuqa,taqwa,toqa|شيماء=shaimaa,shimaa,shaimaa|زينب=zeinab,zainab,zaynab
إيمان=eman,iman|أميرة=amira,ameera|سمر=samar|نسمة=nesma|نهى=noha|دينا=dina|رضوى=radwa|رانيا=rania|غادة=ghada|هدى=hoda,huda
سعاد=soad,suad|نادية=nadia|صباح=sabah|عبير=abeer,abir|عزة=azza|ليلى=laila,leila,layla|نجلاء=naglaa|رحاب=rehab|سحر=sahar
أمل=amal|حنان=hanan|وفاء=wafaa|ولاء=walaa|بسمة=basma|جنى=gana,jana|ملك=malak|حبيبة=habiba|جميلة=gamila|خديجة=khadiga,khadija
عائشة=aisha,aesha|مها=maha|منة=menna,mennah|روان=rawan|يارا=yara|لمياء=lamiaa|نرمين=nermin,nermeen|شيرين=sherin,shereen
ريهام=reham|سهير=soheir|ماجدة=magda|عفاف=afaf|سناء=sanaa|ثناء=thanaa|صفاء=safaa|رشا=rasha|داليا=dalia|إنجي=engy
الرحمن=elrahman,alrahman|رحمن=rahman|العزيز=elaziz,alaziz|عزيز=aziz|الحميد=elhamid|حميد=hamid|المنعم=elmoneim|منعم=moneim
الفتاح=elfattah|فتاح=fattah|الله=allah|الحليم=elhalim|حليم=halim|الكريم=elkarim|الوهاب=elwahab|وهاب=wahab|الجواد=elgawad
الرازق=elrazek|رازق=razek|القادر=elkader|قادر=kader|اللطيف=ellatif|لطيف=latif|الباسط=elbaset|المقصود=elmaksoud|الغني=elghany
الشافعي=elshafei|الشربيني=elsherbiny|المصري=elmasry|حجازي=hegazy,hegazi|عثمان=osman,othman|سليمان=soliman,sulaiman,suleiman
عيسى=eissa,essa,issa|موسى=moussa,mousa,musa|يحيى=yehia,yahia,yahya|زكي=zaki,zaky|شوقي=shawky,shawki|بكر=bakr|بدوي=badawy
نورهان=nourhan,norhan|هاجر=hagar,hager,hajar|وجدي=wagdy,wagdi|مروان=marwan|رضوان=radwan|حنين=hanin,haneen|جهاد=gehad,gihad
جيهان=gihan,gehan|شهد=shahd|رحمة=rahma|رقية=rokaya,roqaya|سندس=sondos|فرح=farah|جنة=ganna,janna|رتاج=retaj|لجين=logain,lojain
سيف=seif,saif|أدهم=adham|بلال=belal,bilal|حمزة=hamza|أنس=anas|معاذ=moaz,muaz|ياسين=yassin,yasin,yassine|ياسر=yasser,yaser
وسام=wessam,wesam|إيهاب=ehab,ihab|مدحت=medhat|صبحي=sobhy,sobhi|رجب=ragab|صابر=saber|فوزي=fawzy,fawzi|حلمي=helmy,helmi
لطفي=lotfy,lotfi|رمزي=ramzy,ramzi|صبري=sabry,sabri|شكري=shokry,shokri|ناجي=nagy,nagi|نجيب=naguib,nagib|رؤوف=raouf
عاطف=atef|حاتم=hatem|ماهر=maher|نصر=nasr|جابر=gaber|حسنين=hassanein|وجيه=wagih,wageeh|صفوت=safwat|ثروت=tharwat,sarwat
نهلة=nahla|نشوى=nashwa|علا=ola|ألفت=olfat|إيناس=inas,enas|عبلة=abla|هويدا=howayda,howaida|هيام=hayam|سماح=samah|هالة=hala
ميرفت=mervat,mervet|نيفين=nevin,nevine,nevein|نوال=nawal|كوثر=kawthar,kawsar|سلوى=salwa|فايزة=fayza,faiza|عزيزة=aziza
حميدة=hamida|كريمة=karima|لطيفة=latifa|نبيلة=nabila|سيدة=sayeda,sayda|يمنى=yomna,yumna|رؤى=roaa|علياء=alyaa,aliaa
هدير=hadeer,hadir|منة_الله=mennatallah,mennatullah|رويدا=rowida|نورا=noura,nora|نوران=nouran,noran|لميس=lamis,lamees
لمى=lama|تسنيم=tasneem,tasnim|بسنت=bassant,basant|سلسبيل=salsabil|روضة=rawda|رغدة=raghda|إسماعيل=smail|عاصم=asem,assem
أنور=anwar|أمير=amir,ameer|أمين=amin,ameen|أنطونيوس=antonios|أبانوب=abanoub|كيرلس=kirollos,kerolos|مرقص=morcos,marcos
ماريان=marian,mariane|ميرنا=mirna|كاترين=catherine,katrin|فيبي=phoebe,febi|إيريني=irini,ereny|مادونا=madonna|نانسي=nancy`
  .split(/\s+/).forEach(line => line.split("|").forEach(pair => {
    const [ar, lat] = pair.split("=");
    if (lat) lat.split(",").forEach(l => { l = l.trim(); if (l && !(l in BUILTIN_AR)) BUILTIN_AR[l] = ar.replace(/_/g, " "); });
  }));

/* ================================================================ the archive's patient index */
let ARCH = null;   // {byKey: Map(key -> [{n,y,count}]), index: [...], tokdict, arabic}
function buildArch(patients) {
  const byKey = new Map();
  for (const p of patients) {
    const k = key(p.n); if (!k) continue;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push({n: p.n, y: p.y, count: p.f.length});
  }
  const index = [];
  for (const [k, ps] of byKey) {
    const latest = ps.reduce((a, b) => (b.y > a.y ? b : a));
    const e = {k, toks: k.split(" "), n: latest.n, years: [...new Set(ps.map(p => p.y))].sort().reverse(), count: ps.reduce((n, p) => n + p.count, 0)};
    if (ARABIC_RE.test(latest.n)) {
      const ph = nameWords(latest.n).map(phon);
      e.pc = ph.map((_, j) => ph.slice(0, j + 1).map(cons).join(""));
      e.pf = ph.map((_, j) => ph.slice(0, j + 1).join(""));
      e.pw = ph.map(cons);   // each word on its own (for names printed without the middle name)
    }
    index.push(e);
  }
  const tokdict = new Map();
  let ar = 0;
  for (const p of patients) {
    if (!ARABIC_RE.test(p.n)) continue;
    ar++;
    for (const w of nameWords(p.n)) {
      const c = cons(phon(w)); if (!c) continue;
      if (!tokdict.has(c)) tokdict.set(c, new Map());
      const d = tokdict.get(c); d.set(w, (d.get(w) || 0) + 1);
    }
  }
  ARCH = {byKey, index, tokdict, arabic: !patients.length || ar * 2 >= patients.length};
}

function bestPatient(text, min = 0.86) {
  const k = key(text);
  if (!k) return [null, 0];
  if (ARCH.byKey.has(k)) return [ARCH.index.find(p => p.k === k), 1];
  let best = null, br = 0;
  for (const p of ARCH.index) {
    if (Math.abs(p.k.length - k.length) > Math.max(4, k.length * 0.35)) continue;
    const r = ratio(k, p.k);
    if (r > br) { best = p; br = r; }
  }
  return br >= min ? [best, br] : [null, br];
}
function patientsInText(all) {
  const toks = new Set(key(all).split(" ").filter(Boolean));
  if (!toks.size) return [];
  const byFirst = {};
  for (const t of toks) (byFirst[t[0]] = byFirst[t[0]] || []).push(t);
  const out = [];
  for (const p of ARCH.index) {
    const pt = p.toks;
    if (pt.length < 2) continue;
    const missing = pt.filter(t => !toks.has(t));
    if (missing.length > 1 || (missing.length && pt.length < 3)) continue;
    let score = 0.97;
    if (missing.length) {
      const m = missing[0];
      if (m.length < 4 || !(byFirst[m[0]] || []).some(t => sm(m, t) >= 0.8)) continue;
      score = 0.9;
    }
    out.push([score + 0.005 * pt.length, p]);
  }
  return out.sort((a, b) => b[0] - a[0]).slice(0, 5);
}
function localSpelling(ar) {
  let best = ar, bn = 0;
  const d = ARCH.tokdict.get(cons(phon(ar)));
  if (d) for (const [w, n] of d) if (key(w) === key(ar) && n > bn) { best = w; bn = n; }
  return best;
}
function ruleTranslit(t) {
  t = t.toLowerCase();
  const out = [];
  const di = {kh: "خ", sh: "ش", ch: "ش", gh: "غ", th: "ث", ph: "ف", ou: "و", oo: "و", ee: "ي", ei: "ي", ai: "ي", aa: "ا"};
  const one = {b: "ب", p: "ب", t: "ت", d: "د", r: "ر", z: "ز", s: "س", f: "ف", v: "ف", k: "ك", c: "ك", q: "ق", l: "ل", m: "م", n: "ن", h: "ه", g: "ج", j: "ج", x: "كس", w: "و", y: "ي",
    i: "ي", o: "و", u: "و", a: "", e: ""};
  let i = 0;
  while (i < t.length) {
    const two = t.slice(i, i + 2);
    if (i === 0 && "aeiou".includes(t[0]) && !(two in di)) { out.push("ei".includes(t[0]) ? "إ" : "أ"); i++; continue; }
    if (two in di) { out.push(di[two]); i += 2; continue; }
    const ch = t[i];
    if ((t.slice(i) === "an" || t.slice(i) === "ar") && i > 1 && !"aeiou".includes(t[i - 1])) { out.push("ا" + one[t[i + 1]]); break; }
    if (i === t.length - 1 && ch === "a") {
      if ((t.slice(-2) === "ia" || t.slice(-2) === "ya") && out.length && out[out.length - 1] === "ي") { out.pop(); out.push("ية"); } else out.push("ة");
    } else if (i === t.length - 1 && "iy".includes(ch)) out.push("ي");
    else if (ch in one) { if (!(out.length && out[out.length - 1] === one[ch] && one[ch])) out.push(one[ch]); }
    i++;
  }
  return out.join("");
}
function translitWord(w) {
  const lw = w.toLowerCase();
  if (BUILTIN_AR[lw]) return [localSpelling(BUILTIN_AR[lw]), true];
  const m = lw.match(/^(?:abd|abdel|abdul|abdal)[\s\-]?(?:el|al)?(.+)$/);
  if (m && m[1].length > 2) {
    let [rest] = BUILTIN_AR["el" + m[1]] ? translitWord("el" + m[1]) : translitWord(m[1]);
    if (!rest.startsWith("ال") && rest !== "الله") rest = "ال" + rest;
    return [localSpelling("عبد") + " " + rest, true];
  }
  if ((lw.startsWith("el") || lw.startsWith("al")) && lw.length > 4 && !/^(ela|ali|alaa)/.test(lw)) {
    const withAl = ARCH.tokdict.get(cons(phon(lw)));   // the archive already has it written with ال (الخياط)
    if (withAl) {
      const p = phon(lw); let best = null, bs = -1;
      for (const [aw, n] of withAl) if (aw.startsWith("ال")) { const s = sm(p, phon(aw)) + 0.02 * Math.min(n, 10); if (s > bs) { bs = s; best = aw; } }
      if (best) return [best, true];
    }
    const [w2, ok] = translitWord(lw.slice(2));
    return ["ال" + w2, ok];
  }
  const p = phon(w), c = cons(p), opts = ARCH.tokdict.get(c);
  if (opts && opts.size) {
    let best = null, bs = -1;
    for (const [aw, n] of opts) { const s = sm(p, phon(aw)) + 0.02 * Math.min(n, 10); if (s > bs) { bs = s; best = aw; } }
    return [best, true];
  }
  return [ruleTranslit(w), false];
}
function transliterate(name) {
  const ws = nameWords(name).filter(w => LATIN_RE.test(w));
  const out = [];
  for (let i = 0; i < ws.length; i++) {
    const lw = ws[i].toLowerCase();
    if ((lw === "el" || lw === "al") && i + 1 < ws.length) {
      const [nx] = translitWord(ws[++i]); out.push(nx.startsWith("ال") ? nx : "ال" + nx); continue;
    }
    if ((lw === "abd" || lw === "abdel" || lw === "abdul") && i + 1 < ws.length) {
      const [nx] = translitWord(ws[++i]);
      out.push(localSpelling("عبد") + " " + (nx.startsWith("ال") || nx === "الله" ? nx : "ال" + nx)); continue;
    }
    out.push(translitWord(ws[i])[0]);
  }
  return out.filter(Boolean).join(" ");
}
function crossMatch(latin) {
  const lt = nameWords(latin).filter(w => LATIN_RE.test(w)).map(phon);
  const lc = lt.map(cons).join(""), lf = lt.join("");
  if (lc.length < 3) return [];
  // "Ebtehal Elkhayat" -> words ["btl", "lxt"] ("El Khayat" is joined first)
  const lw = [];
  nameWords(latin).filter(w => LATIN_RE.test(w)).forEach((w, i, a) => {
    const l = w.toLowerCase();
    if ((l === "el" || l === "al") && i + 1 < a.length) a[i + 1] = l + a[i + 1];
    else lw.push(cons(phon(w)));
  });
  const out = [];
  for (const e of ARCH.index) {
    if (!e.pc) continue;
    let best = 0;
    // first name + later names in the same order, middle name(s) left out
    if (lw.length >= 2 && e.pw.length > lw.length && lw[0] === e.pw[0] && lw.every(c => c.length >= 2)) {
      let ok = true, j = 1;
      for (const c of lw.slice(1)) { while (j < e.pw.length && e.pw[j] !== c) j++; if (j >= e.pw.length) { ok = false; break; } j++; }
      if (ok) best = 0.95;
    }
    for (let j = 0; j < e.pc.length; j++) {
      const ac = e.pc[j];
      if (ac.length > lc.length + 2) break;
      let s = 0;
      if (ac === lc) s = 0.95 + 0.04 * sm(lf, e.pf[j]) + (j === e.pc.length - 1 ? 0.005 : 0);
      else if (lc.length >= 5 && Math.abs(ac.length - lc.length) <= 1) { const r = sm(lc, ac); s = r >= 0.85 ? 0.8 * r : 0; }
      best = Math.max(best, s);
    }
    if (best) out.push([best, e]);
  }
  return out.sort((a, b) => b[0] - a[0]).slice(0, 6);
}
function crossScript(cands) {
  const extra = [];
  for (const c of cands) {
    if (c.source === "patient" || c.source === "translit" || ARCH.byKey.has(key(c.name)) || ARABIC_RE.test(c.name) || !LATIN_RE.test(c.name)) continue;
    const ms = crossMatch(c.name), exact = ms.filter(m => m[0] >= 0.95);
    if (exact.length) {
      exact.slice(0, 4).forEach(([, e], i) => {
        const sure = i === 0 && exact.length === 1;
        extra.push({name: e.n, source: "patient", read_as: c.name, score: sure ? Math.min(c.score + 0.04, 0.97) : 0.86 - 0.01 * i});
      });
      c.score = Math.min(c.score, 0.5);
      continue;
    }
    ms.slice(0, 3).forEach(([, e], i) => extra.push({name: e.n, source: "patient", read_as: c.name, score: 0.7 - 0.01 * i}));
    if (ARCH.arabic) {
      const tr = transliterate(c.name);
      if (tr && ARABIC_RE.test(tr)) { extra.push({name: tr, source: "translit", read_as: c.name, score: Math.min(c.score, 0.88)}); c.score = Math.min(c.score, 0.5); }
    }
  }
  return cands.concat(extra);
}
function candidates(lines, filename, ignore) {
  const ign = new Set((ignore || []).map(key).filter(Boolean));
  let cands = [];
  const add = (name, source, score) => {
    name = cleanName(name);
    const k = key(name);
    if (!k || k.length < 3 || [...ign].some(i => k.includes(i) || (i.length > 4 && i.includes(k)))) return;
    const old = cands.find(c => key(c.name) === k);
    if (old) { if (score > old.score) { old.score = score; old.source = source; } return; }
    cands.push({name, source, score});
  };
  const all = [];
  for (const raw of lines) {
    const line = String(raw).split(/\s+/).join(" ").trim();
    if (!line) continue;
    all.push(line);
    const m = line.match(LABEL_RE) || line.match(LABEL_START_RE);
    if (m) {
      const v = nameFromValue(m[1]);
      if (words(v).length >= 1) { add(v, "label", v.split(" ").length >= 2 ? 0.93 : 0.7); continue; }
    }
    if (isNameLike(line) && !ign.has(key(line))) add(line, "ocr", 0.55 + 0.03 * Math.min(words(line).length, 4));
  }
  if (ARCH.index.length && all.length) for (const [sc, p] of patientsInText(all.join(" "))) add(p.n, "patient", sc);
  const stem = (filename || "").replace(/\.[^.]+$/, "").replace(/[_\-.+]+/g, " ");
  const sw = words(stem).filter(w => !STOP.has(key(w)) && w.length > 1 && !/^(img|dsc|dcim|pxl|whatsapp|screenshot|scan|image|copy|نسخه)$/i.test(w));
  if (sw.length >= 2) add(sw.slice(0, 5).join(" "), "filename", 0.6);
  for (const c of cands) {
    if (c.source === "patient") continue;
    const [p, r] = bestPatient(c.name);
    if (p && r >= 0.86) { c.read_as = c.name; c.name = p.n; c.score = Math.max(c.score, 0.9 + 0.09 * (r - 0.86) / 0.14); }
  }
  if (cands.some(c => ["label", "patient"].includes(c.source) && c.score >= 0.9)) cands = cands.filter(c => c.source !== "ocr" || c.score >= 0.9);
  cands = crossScript(cands);
  const seen = new Set(), out = [];
  for (const c of cands.sort((a, b) => b.score - a.score)) { const k = key(c.name); if (seen.has(k)) continue; seen.add(k); out.push(c); }
  if (out.length && out[0].source === "patient") {
    const pk = new Set(key(out[0].name).split(" "));
    for (const c of out.slice(1)) {
      const ck = new Set(key(c.name).split(" "));
      if (c.source === "label" && [...pk].every(t => ck.has(t)) && ck.size > pk.size) { c.score = out[0].score + 0.01; out.sort((a, b) => b.score - a.score); break; }
    }
  }
  for (const c of out) {
    const e = ARCH.byKey.get(key(c.name));
    if (e) c.name = e.reduce((a, b) => (b.y > a.y ? b : a)).n;
    c.existing = e ? {years: [...new Set(e.map(p => p.y))].sort().reverse(), count: e.reduce((n, p) => n + p.count, 0)} : null;
  }
  return out.slice(0, 8);
}

/* ---- the X-ray date printed on it (never the birth date) */
const DATE_RES = [
  /(?<!\d)((?:19|20)\d\d)\s*[/.\-]\s*(\d{1,2})\s*[/.\-]\s*(\d{1,2})(?!\d)/g,
  /(?<!\d)(\d{1,2})\s*[/.\-]\s*(\d{1,2})\s*[/.\-]\s*((?:19|20)\d\d)(?!\d)/g,
  /(?<!\d)((?:19|20)\d\d)(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])(?!\d)/g];
function iso(y, m, d) {
  const dt = new Date(Date.UTC(+y, +m - 1, +d));
  return dt.getUTCFullYear() === +y && dt.getUTCMonth() === +m - 1 && dt.getUTCDate() === +d ? dt.toISOString().slice(0, 10) : null;
}
function dateFromOcr(lines) {
  const today = new Date().toISOString().slice(0, 10);
  const ranked = [];
  for (const line of lines) {
    const l = digits(line);
    if (/birth|dob|d\.o\.b|ميلاد|born/i.test(l)) continue;
    const ds = [];
    DATE_RES.forEach((rx, i) => { for (const m of l.matchAll(rx)) { const [, a, b, c] = m; ds.push(i !== 1 ? iso(a, b, c) : (iso(c, b, a) || iso(c, a, b))); } });
    const ok = ds.filter(d => d && d >= "1990-01-01" && d <= today);
    if (!ok.length) continue;
    const rank = /(?:\bdate\b|\bstudy\b|\bexam\b|تاريخ\s*(?:الاشعه|الأشعة|الفحص)?)(?!\s*of\s*birth)/i.test(l) ? 0 : /^[\d\s/.\-:]+$/.test(l.trim()) ? 1 : 2;
    ranked.push([rank, ok[0]]);
  }
  ranked.sort((a, b) => a[0] - b[0]);
  return ranked.length ? ranked[0][1] : null;
}

/* ================================================================ OCR (on the device, nothing is sent anywhere) */
const TESS = "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js";
let workerP = null;
function loadScript(src) {
  return new Promise((ok, bad) => { const s = document.createElement("script"); s.src = src; s.onload = ok; s.onerror = () => bad(new Error("script")); document.head.appendChild(s); });
}
function ocrWorker() {
  if (!workerP) workerP = (async () => {
    if (!window.Tesseract) await loadScript(TESS);
    return Tesseract.createWorker(["eng", "ara"], 1);
  })().catch(e => { workerP = null; throw e; });
  return workerP;
}
function grayCanvas(img, sx, sy, sw, sh, maxSide) {
  const s = Math.min(maxSide / Math.max(sw, sh), 3);
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(sw * s)); c.height = Math.max(1, Math.round(sh * s));
  const g = c.getContext("2d", {willReadFrequently: true});
  g.drawImage(img, sx, sy, sw, sh, 0, 0, c.width, c.height);
  const d = g.getImageData(0, 0, c.width, c.height), a = d.data;
  let lo = 255, hi = 0;
  for (let i = 0; i < a.length; i += 4) { const v = (a[i] * 299 + a[i + 1] * 587 + a[i + 2] * 114) / 1000; a[i] = v; if (v < lo) lo = v; if (v > hi) hi = v; }
  const k = hi > lo ? 255 / (hi - lo) : 1;
  for (let i = 0; i < a.length; i += 4) { const v = (a[i] - lo) * k; a[i] = a[i + 1] = a[i + 2] = v; }
  g.putImageData(d, 0, 0);
  return c;
}
async function readText(img) {
  const w = await ocrWorker();
  const W = img.naturalWidth || img.width, H = img.naturalHeight || img.height;
  const parts = [grayCanvas(img, 0, 0, W, H, 2000)];
  if (H > 300) { const st = Math.max(80, Math.floor(H / 4)); parts.push(grayCanvas(img, 0, 0, W, st, 2000), grayCanvas(img, 0, H - st, W, st, 2000)); }
  const lines = [];
  for (const c of parts) {
    const r = await w.recognize(c);
    for (const l of (r.data.text || "").split("\n")) { const t = l.trim(); if (t && !lines.includes(t)) lines.push(t); }
  }
  return lines;
}

/* ================================================================ display copies */
function loadImg(file) {
  return new Promise((ok, bad) => { const u = URL.createObjectURL(file); const im = new Image(); im.onload = () => ok(im); im.onerror = () => { URL.revokeObjectURL(u); bad(new Error("img")); }; im.src = u; });
}
let webpOK = null;
function canWebp() {
  if (webpOK === null) { const c = document.createElement("canvas"); c.width = c.height = 1; webpOK = c.toDataURL("image/webp").startsWith("data:image/webp"); }
  return webpOK;
}
function shrink(img, side, q) {
  const W = img.naturalWidth, H = img.naturalHeight, s = Math.min(1, side / Math.max(W, H));
  const c = document.createElement("canvas"); c.width = Math.max(1, Math.round(W * s)); c.height = Math.max(1, Math.round(H * s));
  const g = c.getContext("2d"); g.fillStyle = "#000"; g.fillRect(0, 0, c.width, c.height); g.imageSmoothingQuality = "high";
  g.drawImage(img, 0, 0, c.width, c.height);
  const type = canWebp() ? "image/webp" : "image/jpeg";
  return new Promise(ok => c.toBlob(b => ok(b), type, q));
}

/* ================================================================ the dialog */
const esc = s => String(s).replace(/[&<>"]/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;"}[c]));
const num = n => String(n).replace(/\d/g, d => "٠١٢٣٤٥٦٧٨٩"[d]);
const CSS = `
#xma{position:fixed;inset:0;z-index:60;background:rgba(5,10,20,.82);display:flex;align-items:flex-start;justify-content:center;overflow:auto;padding:max(10px,env(safe-area-inset-top)) 10px 30px}
#xma .bx{background:#111a2e;color:#e8edf7;width:min(560px,100%);border-radius:18px;padding:16px;box-shadow:0 10px 40px #0008;font-size:1rem}
#xma h3{margin:0 0 12px;font-size:1.15rem;display:flex;align-items:center;gap:8px}#xma h3 span{flex:1}
#xma .x{background:#1e293b;border:0;color:#cbd5e1;border-radius:99px;width:36px;height:36px;font-size:1.1rem}
#xma .pk{display:flex;gap:8px;flex-wrap:wrap}#xma .pk label{flex:1;min-width:140px;background:#3b82f6;color:#fff;text-align:center;border-radius:12px;padding:13px 8px;font-weight:600;cursor:pointer}
#xma .pk label.b{background:#1e293b;color:#cbd5e1}#xma input[type=file]{display:none}
#xma .ims{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0}#xma .ims div{position:relative}
#xma .ims img{width:96px;height:96px;object-fit:cover;border-radius:10px;background:#000;display:block}
#xma .ims button{position:absolute;top:-6px;left:-6px;border:0;border-radius:99px;width:24px;height:24px;background:#ef4444;color:#fff;font-size:.8rem}
#xma .lbl{font-size:.85rem;color:#93a1bd;margin:12px 0 5px}
#xma input.t,#xma select{width:100%;box-sizing:border-box;background:#0b1220;color:#e8edf7;border:1px solid #2a3654;border-radius:10px;padding:11px;font-size:1rem}
#xma .row{display:flex;gap:8px}#xma .row>*{flex:1}
#xma .sug{display:flex;flex-direction:column;gap:6px;margin-top:6px}
#xma .sug button{text-align:right;background:#16213a;border:1px solid #2a3654;color:#e8edf7;border-radius:10px;padding:9px 11px;font-size:.95rem}
#xma .sug button.on{border-color:#3b82f6;background:#1d2d50}#xma .sug small{color:#93a1bd;margin-inline-start:6px}
#xma .st{font-size:.88rem;color:#93a1bd;min-height:1.4em;margin-top:10px}
#xma .go{width:100%;margin-top:14px;border:0;border-radius:12px;padding:14px;font-size:1.05rem;font-weight:700;background:#22c55e;color:#06210f}
#xma .go:disabled{opacity:.45}
#xma .note{font-size:.78rem;color:#7c8aa8;margin-top:10px;line-height:1.6}`;

function open(opt) {
  /* opt: {name, year, patients, ignore, upload(meta, blob) -> Promise, onDone(name, year)} */
  buildArch(opt.patients || []);
  if (!document.getElementById("xma-css")) { const s = document.createElement("style"); s.id = "xma-css"; s.textContent = CSS; document.head.appendChild(s); }
  const ov = document.createElement("div"); ov.id = "xma";
  const thisYear = String(new Date().getFullYear());
  ov.innerHTML = `<div class="bx">
    <h3><span>＋ إضافة أشعة</span><button type="button" class="x" aria-label="إغلاق">✕</button></h3>
    <div class="pk"><label>📷 تصوير<input type="file" accept="image/*" capture="environment" multiple></label>
      <label class="b">🖼️ من الصور / الملفات<input type="file" accept="image/*" multiple></label></div>
    <div class="ims"></div>
    <div class="lbl">اسم المريض</div>
    <input class="t nm" type="text" autocomplete="off" placeholder="اكتب الاسم أو استنى البرنامج يقراه من الصورة">
    <div class="sug"></div>
    <div class="row"><div><div class="lbl">السنة</div><select class="yr"></select></div>
      <div><div class="lbl">تاريخ الأشعة</div><input class="t dt" type="date"></div></div>
    <div class="st"></div>
    <button type="button" class="go" disabled>حفظ</button>
    <div class="note">اللي بيترفع على جوجل درايف هو نسخة العرض بس. الصورة الأصلية بتفضل على الجهاز ده.</div></div>`;
  document.body.appendChild(ov);
  document.body.style.overflow = "hidden";
  const q = s => ov.querySelector(s);
  const nm = q(".nm"), sug = q(".sug"), yr = q(".yr"), dt = q(".dt"), st = q(".st"), go = q(".go"), ims = q(".ims");
  const years = new Set([thisYear]);
  for (const e of ARCH.index) e.years.forEach(y => /^\d{4}$/.test(y) && years.add(y));
  [...years].sort().reverse().forEach(y => { const o = document.createElement("option"); o.value = o.textContent = y; yr.appendChild(o); });
  yr.value = opt.year && /^\d{4}$/.test(opt.year) ? opt.year : thisYear;
  dt.value = new Date().toISOString().slice(0, 10);
  let items = [], busy = false, typed = !!opt.name, yearTouched = !!opt.year, closed = false;
  if (opt.name) nm.value = opt.name;

  const close = () => { if (busy) return; closed = true; ov.remove(); document.body.style.overflow = ""; items.forEach(i => URL.revokeObjectURL(i.url)); };
  q(".x").onclick = close;
  ov.addEventListener("click", e => { if (e.target === ov) close(); });
  const refresh = () => { go.disabled = busy || !items.length || !cleanName(nm.value); };

  function showSug(list, title) {
    sug.innerHTML = (title ? `<div class="lbl" style="margin:4px 0 0">${title}</div>` : "") + list.map((c, i) =>
      `<button type="button" data-i="${i}" class="${key(c.name) === key(nm.value) ? "on" : ""}">${esc(c.name)}<small>${c.existing ? "موجود · " + num(c.existing.count) + " ملف · " + c.existing.years.map(num).join("، ") : "مريض جديد"}${c.read_as && c.read_as !== c.name ? " · اتقرا: " + esc(c.read_as) : ""}</small></button>`).join("");
    sug.onclick = e => {
      const b = e.target.closest("button[data-i]"); if (!b) return;
      const c = list[+b.dataset.i]; nm.value = c.name; typed = true;
      if (c.existing && !yearTouched && !c.existing.years.includes(yr.value) && dateYear() !== yr.value) {/* keep the X-ray year */}
      showSug(list, title); refresh();
    };
  }
  const dateYear = () => (dt.value || "").slice(0, 4);
  let ocrCands = [];
  nm.addEventListener("input", () => {
    typed = true; refresh();
    const k = key(nm.value);
    if (!k) return showSug(ocrCands, ocrCands.length ? "اللي اتقرا من الصورة" : "");
    const toks = k.split(" ");
    const list = ARCH.index.filter(e => toks.every(t => e.k.includes(t))).sort((a, b) => b.years[0].localeCompare(a.years[0])).slice(0, 7)
      .map(e => ({name: e.n, existing: {years: e.years, count: e.count}}));
    showSug(list, list.length ? "مرضى موجودين" : "");
  });
  yr.onchange = () => { yearTouched = true; };
  dt.onchange = () => { const y = dateYear(); if (/^\d{4}$/.test(y) && !yearTouched) { if (![...yr.options].some(o => o.value === y)) { const o = document.createElement("option"); o.value = o.textContent = y; yr.appendChild(o); } yr.value = y; } };

  async function addFiles(files) {
    const first = !items.length;
    for (const f of files) {
      if (!/^image\//.test(f.type) && !/\.(jpe?g|png|webp|bmp|gif|heic|heif)$/i.test(f.name)) continue;
      const it = {file: f, url: URL.createObjectURL(f)};
      items.push(it);
      const d = document.createElement("div");
      d.innerHTML = `<img src="${it.url}" alt=""><button type="button" aria-label="شيل">✕</button>`;
      d.querySelector("button").onclick = () => { if (busy) return; items = items.filter(x => x !== it); d.remove(); URL.revokeObjectURL(it.url); refresh(); };
      ims.appendChild(d);
    }
    refresh();
    if (first && items.length && !opt.name) runOcr(items[0]);
  }
  ov.querySelectorAll("input[type=file]").forEach(inp => inp.onchange = () => { addFiles([...inp.files]); inp.value = ""; });

  async function runOcr(it) {
    st.textContent = "جاري قراءة الاسم من الصورة… (أول مرة بياخد وقت عشان بيحمّل القارئ)";
    try {
      const img = await loadImg(it.file);
      const lines = await readText(img);
      if (closed) return;
      ocrCands = candidates(lines, it.file.name, opt.ignore);
      const d = dateFromOcr(lines);
      if (d) {   // same name in two years: the patient who already has X-rays in this X-ray's year comes first
        const y = d.slice(0, 4), b = c => c.score + (c.existing && c.existing.years.includes(y) ? 0.02 : 0);
        ocrCands.sort((a, c) => b(c) - b(a));
      }
      if (d) { dt.value = d; if (!yearTouched) dt.onchange(); }
      if (ocrCands.length && !typed) { nm.value = ocrCands[0].name; }
      showSug(ocrCands, ocrCands.length ? "اللي اتقرا من الصورة" : "");
      st.textContent = ocrCands.length ? "اتأكد من الاسم قبل الحفظ." : "ما لقيتش اسم واضح على الصورة — اكتبه.";
      refresh();
    } catch (e) {
      if (!closed) st.textContent = "قراءة الاسم ما اشتغلتش (" + (navigator.onLine ? "خطأ" : "مفيش إنترنت") + ") — اكتب الاسم.";
    }
  }

  go.onclick = async () => {
    const name = cleanName(nm.value), year = yr.value;
    if (!name || !items.length) return;
    const ex = ARCH.byKey.get(key(name));
    const finalName = ex ? (ex.find(p => p.y === year) || ex.reduce((a, b) => (b.y > a.y ? b : a))).n : name;
    busy = true; refresh();
    try {
      for (let i = 0; i < items.length; i++) {
        st.textContent = `جاري الرفع ${num(i + 1)} من ${num(items.length)}…`;
        const it = items[i];
        const img = await loadImg(it.file);
        const [pv, th] = [await shrink(img, 1600, 0.8), await shrink(img, 360, 0.7)];
        const id = "m" + Array.from(crypto.getRandomValues(new Uint8Array(7)), b => b.toString(16).padStart(2, "0")).join("");
        const ext = pv.type === "image/webp" ? "" : ".jpg";
        const rec = {n: finalName, y: year, d: dt.value || new Date().toISOString().slice(0, 10), w: img.naturalWidth, h: img.naturalHeight,
          s: it.file.size, fn: it.file.name || "صورة.jpg", at: new Date().toISOString(), by: navigator.userAgent.match(/Android|iPhone|iPad|Windows|Mac/)?.[0] || ""};
        await opt.upload({name: id + ".t" + ext, appProperties: {xr: "t", o: "m"}}, th);
        await opt.upload({name: id + ".p" + ext, appProperties: {xr: "p", o: "m"}, description: JSON.stringify(rec)}, pv);
      }
      st.textContent = "اتحفظ ✔";
      busy = false;
      close();
      opt.onDone && opt.onDone(finalName, year);
    } catch (e) {
      busy = false; refresh();
      st.textContent = "الرفع ما تمش: " + ((e && e.message) || e) + " — جرّب تاني.";
    }
  };
  if (opt.name) { typed = true; refresh(); }
  if (!opt.name) setTimeout(() => nm.focus(), 50);
}

window.XMAdd = {open, candidates, buildArch, dateFromOcr, key};
})();
