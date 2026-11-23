# -*- coding: utf-8 -*-
"""
Add X-Ray tool (أداة إضافة الأشعة)
----------------------------------
Drag a new X-ray into the page -> the tool reads the patient's name from the image
(text printed on the X-ray, DICOM tags, image metadata or the file name),
copies it into   <X-Ray folder>\\<year>\\<patient name>\\<file>
and then runs the archive rebuild (rebuild.bat) so it shows up in the archive app.

Runs locally only (127.0.0.1). Standard Python 3 only; Pillow is optional (better OCR + previews).
"""
import base64
import difflib
import hashlib
import io
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import threading
import time
import unicodedata
import urllib.parse
import uuid
import webbrowser
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

try:
    from PIL import Image, ImageOps
    try:
        Image.MAX_IMAGE_PIXELS = None
    except Exception:
        pass
except Exception:  # Pillow not installed -> still works, just weaker OCR / no TIFF previews
    Image = None
    ImageOps = None

TOOL_DIR = Path(__file__).resolve().parent          # ...\import-tool\files
HOME_DIR = TOOL_DIR.parent                           # ...\import-tool  (the folder the user sees)
LOG_FILE = TOOL_DIR / "log.txt"
SETTINGS_FILE = TOOL_DIR / "settings.json"
STAGING = TOOL_DIR / "_staging"
PAGE_FILE = TOOL_DIR / "add_xray.html"
PS_OCR = TOOL_DIR / "ocr_windows.ps1"
IS_WIN = os.name == "nt"

DEFAULTS = {
    "xray_root": "",          # the main X-ray folder (contains the year folders)
    "rebuild_cmd": "",        # e.g. C:\\...\\rebuild.bat  (runs after saving)
    "port": 8765,
    "auto_save": True,        # save by itself when the name is read with high confidence
    "auto_save_seconds": 5,
    "rebuild_timeout_min": 60,
    "ignore_words": [],       # texts printed on every X-ray (clinic name, doctor...) that are not patient names
    "sources": [],            # centers the X-rays come from (remembered for the "came from" box)
    "watch_folders": [],      # extra folders to look for new X-rays in (Downloads / Desktop / WhatsApp are automatic)
    "recent_days": 7,
    # web addresses of the archive app that may use this tool (localhost / 127.0.0.1 are always allowed)
    "allowed_origins": ["https://drkhalidalghannamdentalclinic-sudo.github.io"],
}

IMG_EXT = {".jpg", ".jpeg", ".png", ".bmp", ".gif", ".tif", ".tiff", ".webp", ".jfif"}
BROWSER_IMG = {".jpg", ".jpeg", ".png", ".bmp", ".gif", ".webp", ".jfif"}
DICOM_EXT = {".dcm", ".dicom", ".dic"}

lock = threading.RLock()
items = {}  # staged uploads: id -> dict


# ---------------------------------------------------------------- settings
def load_settings():
    s = dict(DEFAULTS)
    try:
        s.update(json.loads(SETTINGS_FILE.read_text(encoding="utf-8")))
    except Exception:
        pass
    return s


def save_settings(s):
    SETTINGS_FILE.write_text(json.dumps(s, ensure_ascii=False, indent=1), encoding="utf-8")


CFG = load_settings()


# ---------------------------------------------------------------- text helpers
AR_MAP = str.maketrans({"أ": "ا", "إ": "ا", "آ": "ا", "ٱ": "ا", "ى": "ي", "ئ": "ي", "ؤ": "و", "ة": "ه"})
DIGITS = str.maketrans("٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹", "01234567890123456789")
TASHKEEL = re.compile("[\u064B-\u065F\u0670\u0640]")


def key(s):
    """normalized form used to compare names (same idea as the archive app search)"""
    s = unicodedata.normalize("NFKC", s or "").lower().translate(DIGITS)
    s = TASHKEEL.sub("", s).translate(AR_MAP)
    s = re.sub(r"[\W_]+", " ", s)
    return " ".join(s.split())


def ascii_digits(s):
    return (s or "").translate(DIGITS)


BAD_CHARS = re.compile(r'[<>:"/\\|?*\x00-\x1f]')


def clean_name(s):
    s = unicodedata.normalize("NFKC", s or "")
    s = s.replace("^", " ")
    s = BAD_CHARS.sub(" ", s)
    s = " ".join(s.split()).strip(" .-_,")
    if s and (s.upper() == s or s.lower() == s) and re.search(r"[A-Za-z]", s):
        s = " ".join(w.capitalize() for w in s.split())  # AHMED ALI / ahmed ali -> Ahmed Ali
    return s[:80].strip(" .")


YEAR_RE = re.compile(r"(?<!\d)((?:19|20)\d\d)(?!\d)")


def find_year(s):
    m = YEAR_RE.search(ascii_digits(s))
    return m.group(1) if m else None


# ---------------------------------------------------------------- archive folder scan
class Archive:
    def __init__(self):
        self.root = None
        self.years = {}      # "2024" -> folder name
        self.patients = []   # {n, y, folder, count}
        self.by_key = {}     # name key -> [patients]
        self.scanned = 0

    def scan(self):
        root = CFG.get("xray_root") or ""
        years, patients = {}, []
        if root and os.path.isdir(root):
            for d in os.scandir(root):
                if not d.is_dir() or d.name.startswith((".", "_")):
                    continue
                y = find_year(d.name)
                if not y:
                    continue
                # prefer a folder that is exactly the year (e.g. "2024") when several match
                if y not in years or d.name.strip() == y:
                    years[y] = d.name
            for y, folder in years.items():
                try:
                    for p in os.scandir(os.path.join(root, folder)):
                        if p.is_dir() and not p.name.startswith("."):
                            try:
                                count = sum(1 for _ in os.scandir(p.path))
                            except OSError:
                                count = 0
                            patients.append({"n": p.name, "y": y, "count": count})
                except OSError:
                    pass
        by_key = {}
        for p in patients:
            by_key.setdefault(key(p["n"]), []).append(p)
        with lock:
            self.root, self.years, self.patients, self.by_key = root, years, patients, by_key
            self.scanned = time.time()
            self._index = None

    def index(self):
        """unique names (latest spelling) with their tokens, for matching"""
        with lock:
            if getattr(self, "_index", None) is None:
                idx = []
                for k, ps in self.by_key.items():
                    if not k:
                        continue
                    latest = max(ps, key=lambda p: p["y"])
                    e = {"k": k, "toks": k.split(), "n": latest["n"],
                         "years": sorted({p["y"] for p in ps}, reverse=True),
                         "count": sum(p["count"] for p in ps)}
                    if ARABIC_RE.search(latest["n"]):   # sound-alike prefixes, to match English names on X-rays
                        ph = [phon(w) for w in name_words(latest["n"])]
                        e["pc"] = ["".join(cons(x) for x in ph[:j]) for j in range(1, len(ph) + 1)]
                        e["pf"] = ["".join(ph[:j]) for j in range(1, len(ph) + 1)]
                    idx.append(e)
                self._index = idx
            return self._index

    def year_folder(self, year, create=False):
        root = self.root
        if year in self.years:
            return os.path.join(root, self.years[year])
        # new year: copy the naming style of the latest existing year folder ("2025" -> "2026", "X 2025" -> "X 2026")
        name = year
        if self.years:
            last = self.years[max(self.years)]
            name = YEAR_RE.sub(year, ascii_digits(last), count=1) if find_year(last) else year
        path = os.path.join(root, name)
        if create:
            os.makedirs(path, exist_ok=True)
            with lock:
                self.years[year] = name
        return path


ARCH = Archive()


# ---------------------------------------------------------------- reading the name
STOP = set(key(w) for w in """
dental dent dentist dentistry clinic clinics clinique center centre centr hospital medical medicine dr doctor prof
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
رقم الملف ملف كود يمين يسار علوي سفلي فك ضرس سنه سنة
""".split())

LABEL_RE = re.compile(
    r"(?:patient\s*'?s?\s*name|pat\.?\s*name|pt\.?\s*name|patient|name|nom|"
    r"اسم\s*المريض|اسم\s*المريضه|الاسم|اسم|المريض|المريضه)\s*[:：=\-–]\s*(.+)", re.I)
LABEL_START_RE = re.compile(r"^\s*(?:patient\s*name|patient|name|الاسم|اسم\s*المريض)\s+(.{3,})$", re.I)
CUT_RE = re.compile(
    r"(?:\b(?:id|dob|d\.o\.b|birth|born|date|age|sex|gender|tel|phone|mob|mobile|doctor|dr|file|no|code|ref|ex|kv|ma)\b"
    r"|تاريخ|السن|العمر|النوع|رقم|موبايل|تليفون|الطبيب|دكتور|كود|\d)", re.I)
WORD_RE = re.compile(r"[^\W\d_]+(?:['’][^\W\d_]+)?", re.U)


def ignore_keys():
    return {key(w) for w in CFG.get("ignore_words") or [] if key(w)}


def name_from_value(v):
    """'AHMED ALI  ID: 123' -> 'AHMED ALI'"""
    v = v.replace("^", " ")
    m = CUT_RE.search(v)
    if m:
        v = v[:m.start()]
    words = WORD_RE.findall(v)
    words = [w for w in words if key(w) not in STOP or len(words) <= 2]
    return " ".join(words[:6]).strip()


def is_name_like(s):
    words = WORD_RE.findall(s)
    if not 2 <= len(words) <= 6:
        return False
    if any(len(w) < 2 for w in words):
        return False
    ks = [key(w) for w in words]
    if sum(1 for k in ks if k in STOP) > 0:
        return False
    letters = sum(len(w) for w in words)
    return letters >= 0.7 * len(re.sub(r"\s", "", s))


def ratio(a, b):
    if not a or not b:
        return 0.0
    r1 = difflib.SequenceMatcher(None, a, b).ratio()
    ta, tb = " ".join(sorted(a.split())), " ".join(sorted(b.split()))
    r2 = difflib.SequenceMatcher(None, ta, tb).ratio() if ta != a or tb != b else r1
    return max(r1, r2)


def best_patient(text, min_ratio=0.86):
    """closest existing patient folder for a name text"""
    k = key(text)
    if not k:
        return None, 0
    exact = ARCH.by_key.get(k)
    if exact:
        e = next(p for p in ARCH.index() if p["k"] == k)
        return e, 1.0
    best, br = None, 0.0
    for p in ARCH.index():
        if abs(len(p["k"]) - len(k)) > max(4, len(k) * 0.35):
            continue
        sm = difflib.SequenceMatcher(None, k, p["k"])
        if sm.real_quick_ratio() < min_ratio - 0.15 or sm.quick_ratio() < min_ratio - 0.15:
            continue
        r = ratio(k, p["k"])
        if r > br:
            best, br = p, r
    return (best, br) if br >= min_ratio else (None, br)


def patients_in_text(all_text):
    """existing patients whose every name word appears in the OCR text (handles any word order)"""
    toks = set(key(all_text).split())
    if not toks:
        return []
    by_first = {}
    for t in toks:
        by_first.setdefault(t[:1], []).append(t)
    out = []
    for p in ARCH.index():
        pt = p["toks"]
        if len(pt) < 2:
            continue
        missing = [t for t in pt if t not in toks]
        if len(missing) > 1 or (missing and len(pt) < 3):
            continue
        score = 0.97
        if missing:  # one word read slightly wrong by the OCR
            m = missing[0]
            if len(m) < 4 or not any(difflib.SequenceMatcher(None, m, t).ratio() >= 0.8 for t in by_first.get(m[:1], [])):
                continue
            score = 0.9
        out.append((score + 0.005 * len(pt), p))
    out.sort(key=lambda x: -x[0])
    return out[:5]


# ---------------------------------------------------------------- English name on the X-ray  <->  Arabic folder names
# Names are compared by how they sound: both scripts are turned into the same simple letters
# (vowels a/i/u, h-sounds and ع dropped from the skeleton), e.g. "TOKA ESMAIL" and "تقى إسماعيل" -> "tk" + "sml".
ARABIC_RE = re.compile("[؀-ۿ]")
LATIN_RE = re.compile("[A-Za-z]")
LAT_DI = (("kh", "X"), ("sh", "S"), ("ch", "S"), ("gh", "G"), ("ph", "F"), ("th", "T"), ("dh", "Z"), ("ck", "K"))
LAT_UP = {"X": "x", "S": "S", "G": "g", "F": "f", "T": "t", "Z": "z", "K": "k"}
LAT_1 = {"b": "b", "p": "b", "t": "t", "d": "d", "k": "k", "c": "k", "q": "k", "g": "g", "j": "g", "s": "s", "z": "z",
         "f": "f", "v": "f", "l": "l", "m": "m", "n": "n", "r": "r", "x": "ks", "h": "H",
         "a": "a", "e": "i", "i": "i", "o": "u", "u": "u", "w": "u", "y": "i"}
AR_1 = {"ب": "b", "ت": "t", "ط": "t", "ث": "t", "د": "d", "ض": "d", "ذ": "z", "ز": "z", "ظ": "z", "س": "s", "ص": "s",
        "ش": "S", "ج": "g", "غ": "g", "ق": "k", "ك": "k", "خ": "x", "ف": "f", "ل": "l", "م": "m", "ن": "n", "ر": "r",
        "ح": "H", "ه": "H", "ع": "E", "ء": "E", "ئ": "E", "ؤ": "E",
        "ا": "a", "أ": "a", "آ": "a", "ى": "a", "ة": "a", "ٱ": "a", "إ": "i", "ي": "i", "و": "u"}
VOW = set("aiu")


def phon(token):
    """sound-alike form of one name word, in either script"""
    t = TASHKEEL.sub("", unicodedata.normalize("NFKC", token or "")).lower()
    if LATIN_RE.search(t):
        t = re.sub(r"t(?=[aeiou]?l+ah?$)", "", t)   # Mennatallah / Nematullah: the t is not written in Arabic
        for a, b in LAT_DI:
            t = t.replace(a, b)
        codes = [LAT_UP[c] if c in LAT_UP else LAT_1.get(c, "") for c in t]
    else:
        codes = [AR_1.get(c, "") for c in t]
    out = []
    for c in codes:
        if c and (not out or c != out[-1]):   # double letters count once (Mohammed = Mohamed)
            out.append(c)
    s = "".join(out)
    s = ("h" if s.startswith("H") else "") + s.lstrip("H")   # a starting H counts (Hamdy is not Ahmed)
    s = s.replace("H", "").replace("E", "")
    return re.sub(r"([aiu])\1+", r"\1", s)


def cons(p):
    return "".join(c for c in p if c not in VOW)


def name_words(s):
    return [w for w in re.split(r"[\s\-_.]+", s or "") if w]


# common names, used when the archive itself has no example of the word yet
BUILTIN_AR = {}
for _line in """
محمد=mohamed,mohammed,mohammad,muhammad,mohamad|أحمد=ahmed,ahmad|محمود=mahmoud,mahmud,mahmood|مصطفى=mostafa,moustafa,mustafa
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
مها=maha|ريهام=reham|سهير=soheir|ماجدة=magda|عفاف=afaf|سناء=sanaa|ثناء=thanaa|صفاء=safaa|رشا=rasha|داليا=dalia|إنجي=engy
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
ماريان=marian,mariane|ميرنا=mirna|كاترين=catherine,katrin|فيبي=phoebe,febi|إيريني=irini,ereny|مادونا=madonna|نانسي=nancy
""".split():
    for _pair in _line.split("|"):
        if "=" in _pair:
            _ar, _lat = _pair.split("=")
            for _l in _lat.split(","):
                BUILTIN_AR.setdefault(_l.strip(), _ar.replace("_", " "))


def archive_is_arabic():
    with lock:
        ps = ARCH.patients
        if not ps:
            return True   # unknown yet: the clinic writes folders in Arabic
        n = sum(1 for p in ps[:3000] if ARABIC_RE.search(p["n"]))
        return n * 2 >= min(len(ps), 3000)


def token_dict():
    """sound skeleton -> {Arabic word as written in this archive: how often}"""
    with lock:
        td = getattr(ARCH, "_tokdict", None)
        if td is None or ARCH._tokdict_n != len(ARCH.patients):
            td = {}
            for p in ARCH.patients:
                if ARABIC_RE.search(p["n"]):
                    for w in name_words(p["n"]):
                        c = cons(phon(w))
                        if c:
                            d = td.setdefault(c, {})
                            d[w] = d.get(w, 0) + 1
            ARCH._tokdict, ARCH._tokdict_n = td, len(ARCH.patients)
        return td


def local_spelling(ar):
    """the archive's own way of writing this word (إسماعيل / اسماعيل, تقى / تقي ...)"""
    best, bn = ar, 0
    for w, n in token_dict().get(cons(phon(ar)), {}).items():
        if key(w) == key(ar) and n > bn:
            best, bn = w, n
    return best


def rule_translit(t):
    """last resort for a word we have never seen: letter by letter"""
    t = t.lower()
    out, i = [], 0
    di = {"kh": "خ", "sh": "ش", "ch": "ش", "gh": "غ", "th": "ث", "ph": "ف", "ou": "و", "oo": "و", "ee": "ي", "ei": "ي",
          "ai": "ي", "aa": "ا"}
    one = {"b": "ب", "p": "ب", "t": "ت", "d": "د", "r": "ر", "z": "ز", "s": "س", "f": "ف", "v": "ف", "k": "ك", "c": "ك",
           "q": "ق", "l": "ل", "m": "م", "n": "ن", "h": "ه", "g": "ج", "j": "ج", "x": "كس", "w": "و", "y": "ي",
           "i": "ي", "o": "و", "u": "و", "a": "", "e": ""}
    while i < len(t):
        two = t[i:i + 2]
        if i == 0 and t[0] in "aeiou" and two not in di:
            out.append("إ" if t[0] in "ei" else "أ")
            i += 1
            continue
        if two in di:
            out.append(di[two])
            i += 2
            continue
        ch = t[i]
        if t[i:] in ("an", "ar") and i > 1 and t[i-1] not in "aeiou":   # Nourhan, Hagar -> long a
            out.append("ا" + one[t[i+1]])
            break
        if i == len(t) - 1 and ch == "a":
            out.append("ية" if t[-2:] in ("ia", "ya") and out and out[-1] == "ي" and out.pop() is not None else "ة")
        elif i == len(t) - 1 and ch in "iy":
            out.append("ي")
        elif ch in one:
            if not (out and out[-1] == one[ch] and one[ch]):   # double letters once
                out.append(one[ch])
        i += 1
    return "".join(out)


def translit_word(w):
    lw = w.lower()
    if lw in BUILTIN_AR:
        return local_spelling(BUILTIN_AR[lw]), True
    m = re.fullmatch(r"(?:abd|abdel|abdul|abdal)[\s\-]?(?:el|al)?(.+)", lw)
    if m and len(m.group(1)) > 2:   # Abdelrahman -> عبد الرحمن
        rest, _ = translit_word("el" + m.group(1)) if ("el" + m.group(1)) in BUILTIN_AR else translit_word(m.group(1))
        if not rest.startswith("ال") and rest != "الله":
            rest = "ال" + rest
        return local_spelling("عبد") + " " + rest, True
    if lw.startswith(("el", "al")) and len(lw) > 4 and not lw.startswith(("ela", "ali", "alaa")):   # Elsayed -> السيد
        w2, ok = translit_word(lw[2:])
        return "ال" + w2, ok
    p = phon(w)
    c = cons(p)
    opts = token_dict().get(c, {})
    if opts:   # learn the spelling from the archive (most similar sound, then the most used)
        best = max(opts.items(), key=lambda kv: difflib.SequenceMatcher(None, p, phon(kv[0])).ratio() + 0.02 * min(kv[1], 10))
        return best[0], True
    return rule_translit(w), False


def transliterate(name):
    words = [w for w in name_words(name) if LATIN_RE.search(w)]
    out, i = [], 0
    while i < len(words):
        w = words[i]
        lw = w.lower()
        if lw in ("el", "al") and i + 1 < len(words):   # "El Sayed" -> السيد
            nxt, _ = translit_word(words[i + 1])
            out.append(nxt if nxt.startswith("ال") else "ال" + nxt)
            i += 2
            continue
        if lw in ("abd", "abdel", "abdul") and i + 1 < len(words):   # "Abdel Rahman" -> عبد الرحمن
            nxt, _ = translit_word(words[i + 1])
            out.append(local_spelling("عبد") + " " + (nxt if nxt.startswith("ال") or nxt == "الله" else "ال" + nxt))
            i += 2
            continue
        out.append(translit_word(w)[0])
        i += 1
    return " ".join(x for x in out if x)


def cross_match(latin):
    """Arabic patient folders that sound like an English name. Returns [(score, entry)], 0.95+ = same sound"""
    lt = [phon(w) for w in name_words(latin) if LATIN_RE.search(w)]
    lc, lf = "".join(cons(p) for p in lt), "".join(lt)
    if len(lc) < 3:
        return []
    out = []
    for e in ARCH.index():
        pcs = e.get("pc")
        if not pcs:
            continue
        best = 0.0
        for j, ac in enumerate(pcs):
            if len(ac) > len(lc) + 2:
                break
            if ac == lc:
                s = 0.95 + 0.04 * difflib.SequenceMatcher(None, lf, e["pf"][j]).ratio() + (0.005 if j == len(pcs) - 1 else 0)
            elif len(lc) >= 5 and abs(len(ac) - len(lc)) <= 1:
                r = difflib.SequenceMatcher(None, lc, ac).ratio()
                s = 0.8 * r if r >= 0.85 else 0
            else:
                s = 0
            best = max(best, s)
        if best:
            out.append((best, e))
    out.sort(key=lambda x: -x[0])
    return out[:6]


def cross_script(cands):
    """English names read from the X-ray -> the patient's Arabic folder, or the name written in Arabic for a new one"""
    if not cands:
        return cands
    extra = []
    for c in cands:
        if c["source"] in ("patient", "translit") or ARCH.by_key.get(key(c["name"])) or ARABIC_RE.search(c["name"]) \
                or not LATIN_RE.search(c["name"]):
            continue
        ms = cross_match(c["name"])
        exact = [m for m in ms if m[0] >= 0.95]
        if exact:
            for i, (sc, e) in enumerate(exact[:4]):
                sure = i == 0 and len(exact) == 1
                extra.append({"name": e["n"], "source": "patient", "read_as": c["name"],
                              "score": round(min(c["score"] + 0.04, 0.97) if sure else 0.86 - 0.01 * i, 3)})
            c["score"] = min(c["score"], 0.5)
            continue
        for i, (sc, e) in enumerate(ms[:3]):   # only close: offer them, but the new-patient spelling comes first
            extra.append({"name": e["n"], "source": "patient", "read_as": c["name"], "score": round(0.7 - 0.01 * i, 3)})
        if archive_is_arabic():
            tr = transliterate(c["name"])
            if tr and ARABIC_RE.search(tr):
                extra.append({"name": tr, "source": "translit", "read_as": c["name"], "score": round(min(c["score"], 0.88), 3)})
                c["score"] = min(c["score"], 0.5)
    return cands + extra


def candidates_from(texts_by_source, filename):
    """texts_by_source: list of (source, [lines]) -> ranked candidate list"""
    ign = ignore_keys()
    cands = []

    def add(name, source, score):
        name = clean_name(name)
        k = key(name)
        if not k or len(k) < 3 or any(k in i or (len(i) > 4 and i in k) for i in ign):
            return  # clinic / doctor name printed on every X-ray
        if any(k == key(c["name"]) for c in cands):
            for c in cands:
                if key(c["name"]) == k and score > c["score"]:
                    c["score"], c["source"] = score, source
            return
        cands.append({"name": name, "source": source, "score": round(score, 3)})

    all_ocr = []
    for source, lines in texts_by_source:
        for raw in lines:
            line = " ".join(str(raw).split())
            if not line:
                continue
            if source == "dicom":
                add(line, "dicom", 0.99)
                continue
            all_ocr.append(line)
            m = LABEL_RE.search(line) or LABEL_START_RE.search(line)
            if m:
                v = name_from_value(m.group(1))
                if len(WORD_RE.findall(v)) >= 1:
                    add(v, "label" if source != "meta" else "meta", 0.93 if len(v.split()) >= 2 else 0.7)
                    continue
            if is_name_like(line) and key(line) not in ign:
                add(line, source, 0.55 + 0.03 * min(len(WORD_RE.findall(line)), 4))

    # existing patients found in the text (strongest signal for returning patients)
    if ARCH.patients and all_ocr:
        for score, p in patients_in_text(" ".join(all_ocr)):
            add(p["n"], "patient", score)

    # file name: "Ahmed_Ali_2024-05-01.jpg"
    stem = re.sub(r"[_\-.+]+", " ", Path(filename).stem)
    stem_words = [w for w in WORD_RE.findall(stem) if key(w) not in STOP and len(w) > 1
                  and not re.fullmatch(r"(?i)img|dsc|dcim|pxl|whatsapp|screenshot|scan|image|copy|نسخه", w)]
    if len(stem_words) >= 2:
        add(" ".join(stem_words[:5]), "filename", 0.6)

    # snap each candidate to the spelling of an existing patient when it is clearly the same person
    for c in cands:
        if c["source"] == "patient":
            continue
        p, r = best_patient(c["name"])
        if p is not None:
            c["match"] = round(r, 3)
            if r >= 0.86:
                c["read_as"] = c["name"]
                c["name"] = p["n"]
                c["score"] = max(c["score"], 0.9 + 0.09 * (r - 0.86) / 0.14)

    # a clear name was found -> drop random words the OCR picked up from inside the picture
    if any(c["source"] in ("label", "dicom", "patient", "meta") and c["score"] >= 0.9 for c in cands):
        cands = [c for c in cands if c["source"] != "ocr" or c["score"] >= 0.9]

    # English name on the X-ray, Arabic folders in the archive
    cands = cross_script(cands)

    # merge duplicates produced by snapping
    seen, out = set(), []
    for c in sorted(cands, key=lambda c: -c["score"]):
        k = key(c["name"])
        if k in seen:
            continue
        seen.add(k)
        out.append(c)

    # a labeled name that is longer than (and contains) a matched existing patient is probably a new patient
    if out and out[0]["source"] == "patient":
        pk = set(key(out[0]["name"]).split())
        for c in out[1:]:
            ck = set(key(c["name"]).split())
            if c["source"] in ("label", "dicom") and pk < ck:
                c["score"] = out[0]["score"] + 0.01
                out.sort(key=lambda c: -c["score"])
                break

    for c in out:
        e = ARCH.by_key.get(key(c["name"]))
        if e:  # use the exact spelling of the existing folder
            c["name"] = max(e, key=lambda p: p["y"])["n"]
        c["existing"] = {"years": sorted({p["y"] for p in e}, reverse=True), "count": sum(p["count"] for p in e)} if e else None
    return out[:8]


# ---------------------------------------------------------------- dates
DATE_LINE_RE = re.compile(r"(?i)(?:\bdate\b|\bstudy\b|\bexam\b|تاريخ\s*(?:الاشعه|الأشعة|الفحص)?)(?!\s*of\s*birth)")
BIRTH_RE = re.compile(r"(?i)birth|dob|d\.o\.b|ميلاد|born")


DATE_RES = (
    re.compile(r"(?<!\d)((?:19|20)\d\d)\s*[/.\-]\s*(\d{1,2})\s*[/.\-]\s*(\d{1,2})(?!\d)"),          # 2026/09/13
    re.compile(r"(?<!\d)(\d{1,2})\s*[/.\-]\s*(\d{1,2})\s*[/.\-]\s*((?:19|20)\d\d)(?!\d)"),          # 13/09/2026
    re.compile(r"(?<!\d)((?:19|20)\d\d)(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])(?!\d)"),                     # 20260913 (chart no.)
)


def iso_date(y, m, d):
    try:
        return datetime(int(y), int(m), int(d)).strftime("%Y-%m-%d")
    except ValueError:
        return None


def dates_in(text):
    out = []
    t = ascii_digits(text)
    for i, rx in enumerate(DATE_RES):
        for m in rx.finditer(t):
            a, b, c = m.groups()
            out.append(iso_date(a, b, c) if i != 1 else (iso_date(c, b, a) or iso_date(c, a, b)))
    return [d for d in out if d]


def date_from_ocr(lines):
    """the X-ray date printed on it (never the birth date). Best: a 'Date:' line, then a line that is only a date,
    then a date hidden in the chart number (20260913_153830)"""
    today = datetime.now().strftime("%Y-%m-%d")
    ranked = []
    for line in lines:
        l = ascii_digits(line)
        if BIRTH_RE.search(l):
            continue
        ds = [d for d in dates_in(l) if "1990-01-01" <= d <= today]
        if not ds:
            continue
        if DATE_LINE_RE.search(l):
            rank = 0
        elif re.fullmatch(r"[\d\s/.\-:]+", l.strip()):
            rank = 1
        else:
            rank = 2
        ranked.append((rank, ds[0]))
    return min(ranked)[1] if ranked else None


# ---------------------------------------------------------------- DICOM (pydicom if installed, else a tiny reader)
def read_dicom(path):
    info = {}
    try:
        import pydicom  # optional
        ds = pydicom.dcmread(path, stop_before_pixels=True, force=True)
        if getattr(ds, "PatientName", None):
            info["name"] = str(ds.PatientName)
        for t in ("StudyDate", "AcquisitionDate", "SeriesDate", "ContentDate"):
            v = getattr(ds, t, "")
            if v:
                info["date"] = str(v)
                break
        return info
    except Exception:
        pass
    try:
        with open(path, "rb") as f:
            data = f.read(1 << 20)
    except OSError:
        return info

    def get(tag):
        g, e = tag
        tb = g.to_bytes(2, "little") + e.to_bytes(2, "little")
        i = data.find(tb)
        while i >= 0:
            vr = data[i + 4:i + 6]
            if vr.isalpha() and vr.isupper():          # explicit VR
                n = int.from_bytes(data[i + 6:i + 8], "little")
                val = data[i + 8:i + 8 + n]
            else:                                        # implicit VR
                n = int.from_bytes(data[i + 4:i + 8], "little")
                val = data[i + 8:i + 8 + n] if n < 256 else b""
            if val:
                for enc in ("utf-8", "cp1256", "latin-1"):
                    try:
                        return val.decode(enc).strip("\x00 ")
                    except UnicodeDecodeError:
                        pass
            i = data.find(tb, i + 1)
        return ""

    if data[128:132] == b"DICM" or path.lower().endswith(tuple(DICOM_EXT)):
        n = get((0x0010, 0x0010))
        if n:
            info["name"] = n
        for t in ((0x0008, 0x0020), (0x0008, 0x0022), (0x0008, 0x0021), (0x0008, 0x0023)):
            d = get(t)
            if re.fullmatch(r"\d{8}", d or ""):
                info["date"] = d
                break
    return info


def dicom_name(raw):
    parts = [p.strip() for p in raw.split("^") if p.strip()]
    if len(parts) >= 2:  # LAST^FIRST^MIDDLE -> FIRST MIDDLE LAST
        parts = parts[1:] + parts[:1]
    return " ".join(parts)


# ---------------------------------------------------------------- image metadata / previews
def exif_info(path):
    out = {"texts": [], "date": None}
    if Image is None:
        return out
    try:
        with Image.open(path) as im:
            ex = im.getexif()
            for tag in (270, 315, 0x9C9C, 0x9C9F, 0x9C9B):  # description, artist, XP comment/subject/title
                v = ex.get(tag)
                if isinstance(v, bytes):
                    try:
                        v = v.decode("utf-16-le").strip("\x00")
                    except Exception:
                        v = ""
                if v and isinstance(v, str) and len(v) < 200:
                    out["texts"].append(v)
            sub = ex.get_ifd(0x8769) if hasattr(ex, "get_ifd") else {}
            d = (sub or {}).get(36867) or (sub or {}).get(36868) or ex.get(306)
            if d:
                out["date"] = str(d)
    except Exception:
        pass
    return out


def to_gray(im):
    if im.mode in ("I;16", "I;16B", "I;16L", "I", "F"):
        im = im.convert("I") if im.mode != "F" else im
        lo, hi = im.getextrema()
        scale = 255.0 / max(1, hi - lo)
        im = im.point(lambda v: (v - lo) * scale).convert("L")
    return ImageOps.exif_transpose(im).convert("L") if im.mode != "L" else im


def preview_data_url(path):
    if Image is None:
        return None
    try:
        with Image.open(path) as im:
            g = to_gray(im)
            g.thumbnail((640, 640))
            b = io.BytesIO()
            g.save(b, "JPEG", quality=80)
            return "data:image/jpeg;base64," + base64.b64encode(b.getvalue()).decode()
    except Exception:
        return None


def ocr_variants(path, workdir):
    """images given to the OCR engine: whole image + top and bottom strips enlarged (text is usually there)"""
    if Image is None:
        return [path]
    out = []
    try:
        with Image.open(path) as im:
            g = to_gray(im)
        W, H = g.size
        MAX = 2400

        def put(img, name):
            w, h = img.size
            s = min(MAX / max(w, h), 3.0)
            if abs(s - 1) > 0.05:
                img = img.resize((max(1, int(w * s)), max(1, int(h * s))), Image.LANCZOS)
            p = os.path.join(workdir, name)
            img.save(p, "PNG")
            out.append(p)

        put(ImageOps.autocontrast(g), "ocr_full.png")
        if H > 300:
            strip = max(80, H // 4)
            put(ImageOps.autocontrast(g.crop((0, 0, W, strip))), "ocr_top.png")
            put(ImageOps.autocontrast(g.crop((0, H - strip, W, H))), "ocr_bottom.png")
    except Exception:
        return [path]
    return out


# ---------------------------------------------------------------- OCR engines
def find_tesseract():
    t = shutil.which("tesseract")
    if t:
        return t
    for p in (r"C:\Program Files\Tesseract-OCR\tesseract.exe", r"C:\Program Files (x86)\Tesseract-OCR\tesseract.exe"):
        if os.path.exists(p):
            return p
    return None


_engine = None


def ocr_engine():
    global _engine
    if _engine is None:
        if IS_WIN and PS_OCR.exists():
            _engine = "windows"
        elif find_tesseract():
            _engine = "tesseract"
        else:
            _engine = ""
    return _engine


NOWIN = 0x08000000 if IS_WIN else 0


def ocr_windows(files, workdir):
    out_file = os.path.join(workdir, "ocr.txt")
    cmd = ["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
           "-File", str(PS_OCR), "-Out", out_file] + [os.path.abspath(f) for f in files]
    r = subprocess.run(cmd, capture_output=True, timeout=90, creationflags=NOWIN, stdin=subprocess.DEVNULL)
    lines, err = [], ""
    if os.path.exists(out_file):
        with open(out_file, encoding="utf-8-sig", errors="replace") as f:
            for l in f:
                l = l.rstrip("\r\n")
                if l.startswith("error\t"):
                    err = l[6:]
                    continue
                if "\t" in l:
                    l = l.split("\t", 1)[1]
                if l.strip():
                    lines.append(l)
    if not lines and (err or r.returncode not in (0, None)):
        raise RuntimeError(err or (r.stderr or b"").decode("utf-8", "replace")[-400:])
    return lines


_tess_langs = None


def ocr_tesseract(files, workdir):
    global _tess_langs
    exe = find_tesseract()
    if _tess_langs is None:
        try:
            r = subprocess.run([exe, "--list-langs"], capture_output=True, timeout=20, creationflags=NOWIN)
            have = set((r.stdout or b"").decode("utf-8", "replace").split())
            _tess_langs = "+".join(l for l in ("eng", "ara") if l in have) or "eng"
        except Exception:
            _tess_langs = "eng"
    lines = []
    for f in files:
        src = f
        if Image is not None:  # tesseract prefers dark text on light background
            try:
                with Image.open(f) as im:
                    g = im.convert("L")
                    if sum(g.resize((64, 64)).getdata()) / 4096 < 128:
                        src = os.path.join(workdir, "inv_" + os.path.basename(f) + ".png")
                        ImageOps.invert(g).save(src)
            except Exception:
                pass
        r = subprocess.run([exe, src, "stdout", "-l", _tess_langs, "--psm", "11"],
                           capture_output=True, timeout=120, creationflags=NOWIN)
        lines += [l for l in (r.stdout or b"").decode("utf-8", "replace").splitlines() if l.strip()]
        r = subprocess.run([exe, src, "stdout", "-l", _tess_langs, "--psm", "3"],
                           capture_output=True, timeout=120, creationflags=NOWIN)
        lines += [l for l in (r.stdout or b"").decode("utf-8", "replace").splitlines() if l.strip()]
    return lines


def run_ocr(path, workdir):
    eng = ocr_engine()
    if not eng:
        return [], "مفيش برنامج قراءة نصوص (OCR) على الجهاز"
    files = ocr_variants(path, workdir)
    try:
        lines = ocr_windows(files, workdir) if eng == "windows" else ocr_tesseract(files, workdir)
    except Exception as e:
        return [], "القراءة فشلت: %s" % e
    seen, out = set(), []
    for l in lines:
        k = " ".join(l.split())
        if k and k not in seen:
            seen.add(k)
            out.append(k)
    return out, None


# ---------------------------------------------------------------- analyze one uploaded file
def analyze(item):
    path, fname = item["path"], item["filename"]
    ext = Path(fname).suffix.lower()
    sources, year, year_src, note = [], None, None, None

    xdate = None   # the date the X-ray was taken, when we can tell
    dicom = read_dicom(path) if (ext in DICOM_EXT or ext == "") else {}
    if dicom.get("name"):
        sources.append(("dicom", [dicom_name(dicom["name"])]))
    if dicom.get("date"):
        year, year_src = find_year(dicom["date"]), "تاريخ الأشعة (DICOM)"
        xdate = (dates_in(dicom["date"]) or [None])[0]

    ocr_lines = []
    if ext in IMG_EXT:
        ex = exif_info(path)
        if ex["texts"]:
            sources.append(("meta", ex["texts"]))
        if not year and ex["date"] and find_year(ex["date"]):
            year, year_src = find_year(ex["date"]), "تاريخ التصوير"
            xdate = (dates_in(ex["date"].replace(":", "-", 2)) or [None])[0]
        if not dicom.get("name"):
            ocr_lines, note = run_ocr(path, item["dir"])
            sources.append(("ocr", ocr_lines))
            if not year:
                d = date_from_ocr(ocr_lines)
                if d:
                    year, year_src, xdate = d[:4], "التاريخ المكتوب على الأشعة", d
    elif ext not in DICOM_EXT:
        note = "نوع الملف ده مش صورة — اكتب الاسم بإيدك"

    # the year is "sure" only when it comes from the X-ray itself; a file date can be the day it was sent / downloaded
    year_sure = bool(year)
    if not year and item.get("mtime"):
        year, year_src = str(datetime.fromtimestamp(item["mtime"]).year), "تاريخ الملف"
    this_year = str(datetime.now().year)
    if not year or not (1990 <= int(year) <= int(this_year) + 1):
        year, year_src, year_sure = this_year, "السنة الحالية", False

    item["xdate"] = xdate if xdate and xdate[:4] == year else None
    cands = candidates_from(sources, fname)
    best = cands[0] if cands else None
    confident = bool(best and best["score"] >= 0.9 and (len(cands) < 2 or cands[1]["score"] < best["score"] - 0.02 or
                                                      key(cands[1]["name"]) == key(best["name"])))
    preview = None
    if ext in IMG_EXT and ext not in BROWSER_IMG:
        preview = preview_data_url(path)
    return {
        "id": item["id"], "filename": fname, "size": item["size"],
        "candidates": cands, "best": best["name"] if best else "", "confident": confident,
        "year": year, "year_source": year_src, "year_sure": year_sure, "date": item["xdate"], "ocr_text": ocr_lines[:40], "note": note, "preview": preview,
    }


# ---------------------------------------------------------------- saving
def file_hash(p):
    h = hashlib.sha1()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


REG_FILE = TOOL_DIR / "imported.json"
_reg = None


def reg_key(name, size, mtime):
    """identity of a source file, so files already added are not offered again"""
    return "%s|%d|%d" % (os.path.basename(name or "").lower(), int(size or 0), int(mtime or 0))


def registry():
    global _reg
    if _reg is None:
        try:
            _reg = json.loads(REG_FILE.read_text(encoding="utf-8"))
        except Exception:
            _reg = {}
    return _reg


def reg_add(k, dest):
    with lock:
        r = registry()
        r[k] = dest
        if len(r) > 30000:
            for old in list(r)[:5000]:
                r.pop(old, None)
        try:
            REG_FILE.write_text(json.dumps(r, ensure_ascii=False), encoding="utf-8")
        except OSError:
            pass


def save_item(item, name, year, source=""):
    name = clean_name(name)
    if not name:
        raise ValueError("اكتب اسم المريض")
    year = ascii_digits(str(year)).strip()
    if not re.fullmatch(r"(19|20)\d\d", year):
        raise ValueError("السنة مش مظبوطة")
    if not ARCH.root or not os.path.isdir(ARCH.root):
        raise ValueError("فولدر الأشعة الأساسي مش متحدد أو مش موجود — افتح الإعدادات")

    ydir = ARCH.year_folder(year)   # the year comes from the X-ray, never from the patient's older folders
    folder = None
    try:  # same patient already has a folder in this year? (spelling may differ slightly in letters like ة/ه)
        for d in os.scandir(ydir):
            if d.is_dir() and key(d.name) == key(name):
                folder = d.name
                break
    except OSError:
        pass
    prev = ARCH.by_key.get(key(name))
    new_patient = folder is None and not prev
    if folder is None:
        folder = max(prev, key=lambda p: p["y"])["n"] if prev else name   # keep the same spelling as older years
    pdir = os.path.join(ydir, folder)

    src = item["path"]
    fname = BAD_CHARS.sub("_", item["filename"]).strip() or ("xray" + Path(src).suffix)
    source = clean_name(source)
    if source and not key(fname).startswith(key(source)):
        fname = "%s - %s" % (source, fname)   # where it came from, e.g. "مركز الفا - WhatsApp Image ....jpeg"
        if source not in CFG["sources"]:
            CFG["sources"] = ([source] + CFG["sources"])[:30]
            save_settings(CFG)
    size = os.path.getsize(src)
    h = None
    # same X-ray already saved for this patient (in this year or any other year)? then don't copy it again
    dirs = [pdir] + [os.path.join(ARCH.root, ARCH.years.get(p["y"], p["y"]), p["n"]) for p in (prev or []) if p["y"] != year]
    for dd in dirs:
        try:
            ents = list(os.scandir(dd))
        except OSError:
            continue
        for d in ents:
            if d.is_file() and d.stat().st_size == size:
                h = h or file_hash(src)
                if file_hash(d.path) == h:
                    reg_add(item.get("reg", ""), d.path)
                    return {"duplicate": True, "path": d.path, "rel": os.path.relpath(d.path, ARCH.root), "new_patient": False,
                            "folder": folder}
    ARCH.year_folder(year, create=True)
    os.makedirs(pdir, exist_ok=True)
    stem, ext = os.path.splitext(fname)
    dest, n = os.path.join(pdir, fname), 2
    while os.path.exists(dest):
        dest = os.path.join(pdir, "%s (%d)%s" % (stem, n, ext))
        n += 1
    shutil.copy2(src, dest)
    if os.path.getsize(dest) != size:
        raise IOError("النسخ ما كملش — جرّب تاني")
    xd = item.get("xdate")
    if xd and xd[:4] == year:   # file date = the X-ray date (not the day it was downloaded from WhatsApp)
        try:
            t = datetime.strptime(xd, "%Y-%m-%d").replace(hour=12).timestamp()
            os.utime(dest, (t, t))
        except (ValueError, OSError):
            pass

    reg_add(item.get("reg", ""), dest)
    with lock:  # update the in-memory list right away
        found = [p for p in ARCH.patients if p["y"] == year and p["n"] == folder]
        if found:
            found[0]["count"] += 1
        else:
            p = {"n": folder, "y": year, "count": 1}
            ARCH.patients.append(p)
            ARCH.by_key.setdefault(key(folder), []).append(p)
        ARCH._index = None
    return {"duplicate": False, "path": dest, "rel": os.path.relpath(dest, ARCH.root), "new_patient": new_patient, "folder": folder}


# ---------------------------------------------------------------- archive rebuild (runs rebuild.bat after saves)
class Rebuilder:
    def __init__(self):
        self.state = "idle"     # idle | waiting | running | done | error | off
        self.pending = False
        self.due = 0
        self.msg = ""
        self.log = ""
        self.finished = None
        threading.Thread(target=self._loop, daemon=True).start()

    def request(self, delay=4):
        with lock:
            if not CFG.get("rebuild_cmd"):
                self.state, self.msg = "off", "أمر تحديث الأرشيف مش متحدد في الإعدادات"
                return
            self.pending = True
            self.due = time.time() + delay
            if self.state != "running":
                self.state = "waiting"

    def _loop(self):
        while True:
            time.sleep(0.5)
            with lock:
                go = self.pending and self.state != "running" and time.time() >= self.due
                if go:
                    self.pending, self.state, self.msg = False, "running", ""
            if go:
                self._run()

    def _run(self):
        cmd = CFG.get("rebuild_cmd", "").strip().strip('"')
        try:
            if not os.path.exists(cmd):
                raise FileNotFoundError("مش لاقي: " + cmd)
            cwd = os.path.dirname(os.path.abspath(cmd))
            if cmd.lower().endswith((".bat", ".cmd")):
                args = ["cmd.exe", "/c", cmd]
            elif cmd.lower().endswith(".py"):
                args = [sys.executable, cmd]
            elif cmd.lower().endswith(".ps1"):
                args = ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", cmd]
            else:
                args = [cmd]
            env = dict(os.environ, XRAY_IMPORT="1")
            r = subprocess.run(args, cwd=cwd, stdin=subprocess.DEVNULL, capture_output=True, env=env,
                               timeout=max(1, float(CFG.get("rebuild_timeout_min") or 60)) * 60, creationflags=NOWIN)
            out = (r.stdout or b"") + b"\n" + (r.stderr or b"")
            for enc in ("utf-8", "cp1256", "cp720", "latin-1"):
                try:
                    txt = out.decode(enc)
                    break
                except UnicodeDecodeError:
                    continue
            with lock:
                self.log = txt[-3000:]
                if r.returncode == 0:
                    self.state, self.msg = "done", "الأرشيف اتحدث ✔"
                else:
                    self.state, self.msg = "error", "التحديث خلص بخطأ (كود %s)" % r.returncode
        except subprocess.TimeoutExpired:
            with lock:
                self.state, self.msg = "error", "التحديث أخد وقت أطول من اللازم واتوقف"
        except Exception as e:
            with lock:
                self.state, self.msg = "error", str(e)
        with lock:
            self.finished = datetime.now().strftime("%H:%M")
            if self.pending:
                self.state = "waiting"
        ARCH.scan()

    def status(self):
        with lock:
            return {"state": self.state, "msg": self.msg, "log": self.log[-1500:], "finished": self.finished,
                    "configured": bool(CFG.get("rebuild_cmd"))}


REB = None


# ---------------------------------------------------------------- auto-detect settings on first run
def autodetect():
    changed = False
    places = [HOME_DIR, HOME_DIR.parent, HOME_DIR.parent.parent]
    if not CFG.get("rebuild_cmd"):
        for d in places:
            for n in ("rebuild.bat", "Rebuild.bat", "rebuild.cmd"):
                p = d / n
                if p.exists():
                    CFG["rebuild_cmd"] = str(p)
                    changed = True
                    break
            if CFG.get("rebuild_cmd"):
                break
    if not CFG.get("xray_root") or not os.path.isdir(CFG["xray_root"]):
        # look for a folder path written inside the archive's own scripts / settings
        best, best_n = None, 0
        for d in places:
            try:
                files = [f for f in d.iterdir() if f.is_file() and f.suffix.lower() in
                         (".bat", ".cmd", ".py", ".ps1", ".json", ".ini", ".txt", ".cfg") and f.stat().st_size < 400000
                         and f.parent not in (TOOL_DIR, HOME_DIR)]
            except OSError:
                continue
            for f in files:
                try:
                    raw = f.read_bytes()
                    txt = raw.decode("utf-8") if raw[:3] != b"\xef\xbb\xbf" else raw[3:].decode("utf-8")
                except Exception:
                    txt = f.read_bytes().decode("cp1256", "replace")
                for m in re.finditer(r'[A-Za-z]:[\\/][^"\'\r\n<>|*?=]*', txt.replace("\\\\", "\\")):
                    p = m.group(0).strip().rstrip("\\/ ;,")
                    for cand in (p, os.path.dirname(p)):
                        if cand and os.path.isdir(cand):
                            try:
                                n = sum(1 for e in os.scandir(cand) if e.is_dir() and find_year(e.name))
                            except OSError:
                                n = 0
                            if n > best_n:
                                best, best_n = cand, n
        if best:
            CFG["xray_root"] = best
            changed = True
    if changed:
        save_settings(CFG)


# ---------------------------------------------------------------- HTTP
def json_bytes(o):
    return json.dumps(o, ensure_ascii=False).encode("utf-8")


VERSION = 2
LOCAL_ORIGIN = re.compile(r"https?://(localhost|127\.0\.0\.1)(:\d+)?")


def origin_ok(origin):
    """pages allowed to use this tool: the archive app (on this PC or its web address) and the tool itself"""
    if not origin:
        return True
    return bool(LOCAL_ORIGIN.fullmatch(origin)) or origin.rstrip("/") in [o.rstrip("/") for o in CFG.get("allowed_origins") or []]


# ---------------------------------------------------------------- finding X-rays on this computer
SCAN_EXT = IMG_EXT | DICOM_EXT
tokens = {}   # short token -> file path (so the page never sends raw paths for thumbnails)
_thumbs = {}


_tok_of = {}


def tok_for(path):
    with lock:
        t = _tok_of.get(path)
        if not t:
            t = _tok_of[path] = uuid.uuid4().hex[:16]   # random, so other pages cannot guess it
            tokens[t] = path
    return t


def default_watch_folders():
    """Downloads, Desktop and WhatsApp Desktop's received files - only the ones that exist"""
    home = Path.home()
    out = []
    for name, p, depth in (("التنزيلات", home / "Downloads", 2), ("سطح المكتب", home / "Desktop", 1),
                           ("سطح المكتب", home / "OneDrive" / "Desktop", 1),
                           ("صور واتساب", home / "Pictures" / "WhatsApp", 3),
                           ("واتساب", home / "Documents" / "WhatsApp", 3)):
        if p.is_dir():
            out.append((name, str(p), depth))
    la = os.environ.get("LOCALAPPDATA")
    if la and os.path.isdir(os.path.join(la, "Packages")):
        try:
            for d in os.scandir(os.path.join(la, "Packages")):
                if "whatsapp" in d.name.lower():
                    for sub in (("LocalState", "shared", "transfers"), ("LocalState",)):
                        p = os.path.join(d.path, *sub)
                        if os.path.isdir(p):
                            out.append(("واتساب", p, 5))
                            break
        except OSError:
            pass
    return out


def watch_folders():
    out = default_watch_folders()
    for p in CFG.get("watch_folders") or []:
        if os.path.isdir(p):
            out.append((os.path.basename(p.rstrip("\\/")) or p, p, 3))
    return out


def skip_dir(path):
    a = os.path.normcase(os.path.abspath(path))
    arch = os.path.dirname(CFG.get("rebuild_cmd") or "")   # the archive app folder (thumbs / previews live there)
    for b in (CFG.get("xray_root"), str(HOME_DIR), arch):
        if b:
            b = os.path.normcase(os.path.abspath(b))
            if a == b or a.startswith(b + os.sep):
                return True
    return False


def file_entry(path, st, where=""):
    return {"t": tok_for(path), "name": os.path.basename(path), "path": path, "where": where,
            "size": st.st_size, "mtime": int(st.st_mtime * 1000),
            "done": reg_key(path, st.st_size, st.st_mtime) in registry()}


def list_files(folder, depth, since=0, limit=300, where=""):
    out = []

    def walk(d, lvl):
        if skip_dir(d) or len(out) >= limit * 3:
            return
        try:
            ents = list(os.scandir(d))
        except OSError:
            return
        for e in ents:
            try:
                if e.is_dir(follow_symlinks=False):
                    if lvl < depth and not e.name.startswith((".", "$")):
                        walk(e.path, lvl + 1)
                elif os.path.splitext(e.name)[1].lower() in SCAN_EXT:
                    st = e.stat()
                    if st.st_mtime >= since and st.st_size >= 15000:   # tiny files = stickers / icons
                        out.append(file_entry(e.path, st, where))
            except OSError:
                pass

    walk(folder, 1)
    out.sort(key=lambda f: -f["mtime"])
    return out[:limit]


def recent_files(days):
    since = time.time() - max(1, days) * 86400
    seen, out = set(), []
    for where, p, depth in watch_folders():
        for f in list_files(p, depth, since, 200, where):
            k = os.path.normcase(f["path"])
            if k not in seen:
                seen.add(k)
                out.append(f)
    out.sort(key=lambda f: -f["mtime"])
    return out[:240]


def thumb_bytes(path):
    with lock:
        if path in _thumbs:
            return _thumbs[path]
    data, ctype = None, "image/jpeg"
    ext = os.path.splitext(path)[1].lower()
    if Image is not None and ext in IMG_EXT:
        try:
            with Image.open(path) as im:
                im.draft("L", (480, 480))
                g = to_gray(im)
                g.thumbnail((360, 360))
                b = io.BytesIO()
                g.save(b, "JPEG", quality=75)
                data = b.getvalue()
        except Exception:
            data = None
    if data is None and ext in BROWSER_IMG and os.path.getsize(path) < 15 << 20:
        data = open(path, "rb").read()
        ctype = {".png": "image/png", ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp"}.get(ext, "image/jpeg")
    if data is None:
        return None
    with lock:
        if len(_thumbs) > 400:
            _thumbs.clear()
        _thumbs[path] = (data, ctype)
    return data, ctype


def stage_path(path):
    """take a file that is already on this computer (typed path, folder listing, Downloads / WhatsApp)"""
    path = (path or "").strip().strip('"')
    if not os.path.isfile(path):
        raise ValueError("مش لاقي الملف ده: " + path)
    st = os.stat(path)
    iid = uuid.uuid4().hex[:12]
    d = STAGING / iid
    d.mkdir(parents=True, exist_ok=True)
    fname = os.path.basename(path)
    dst = str(d / ("upload" + Path(fname).suffix.lower()))
    shutil.copy2(path, dst)
    it = {"id": iid, "dir": str(d), "path": dst, "filename": fname, "size": st.st_size, "mtime": st.st_mtime,
          "t": time.time(), "src": path, "reg": reg_key(fname, st.st_size, st.st_mtime)}
    with lock:
        items[iid] = it
    res = analyze(it)
    res["src"] = path
    return res


# ---------------------------------------------------------------- start with Windows
def startup_file():
    ad = os.environ.get("APPDATA")
    return os.path.join(ad, "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "XRay Import Tool.vbs") if ad else None


def set_autostart(on):
    f = startup_file()
    if not f or not IS_WIN:
        raise ValueError("التشغيل التلقائي متاح على ويندوز بس")
    if on:
        exe = sys.executable
        w = os.path.join(os.path.dirname(exe), "pythonw.exe")
        if os.path.exists(w):
            exe = w
        line = 'CreateObject("WScript.Shell").Run """%s"" ""%s"" --no-browser", 0, False' % (exe, os.path.abspath(__file__))
        with open(f, "w", encoding="utf-16") as fh:   # UTF-16 so Arabic folder names work in VBScript
            fh.write(line + "\r\n")
    elif os.path.exists(f):
        os.remove(f)


# ---------------------------------------------------------------- HTTP
class H(BaseHTTPRequestHandler):
    server_version = "XRayImport/2"

    def log_message(self, *a):
        pass

    def cors(self):
        o = self.headers.get("Origin")
        if o and origin_ok(o):
            self.send_header("Access-Control-Allow-Origin", o)
            self.send_header("Vary", "Origin")

    def send(self, code, body, ctype="application/json; charset=utf-8", cache=False):
        if not isinstance(body, (bytes, bytearray)):
            body = json_bytes(body)
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "max-age=300" if cache else "no-store")
        self.cors()
        self.end_headers()
        self.wfile.write(body)

    def host_ok(self):
        # refuse requests that reach us under another host name (protects against DNS-rebinding tricks)
        h = (self.headers.get("Host") or "").split(":")[0].lower()
        return h in ("127.0.0.1", "localhost")

    def body_json(self):
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n) or b"{}") if n else {}

    def do_OPTIONS(self):
        o = self.headers.get("Origin")
        if not self.host_ok() or not o or not origin_ok(o):
            self.send_response(403)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        self.send_response(204)
        self.cors()
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "X-XRay, X-File-Name, X-Last-Modified, Content-Type")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Access-Control-Max-Age", "600")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        if not self.host_ok():
            return self.send(403, {"error": "forbidden"})
        u = urllib.parse.urlparse(self.path)
        p, q = u.path, urllib.parse.parse_qs(u.query)
        if p in ("/", "/index.html"):
            return self.send(200, PAGE_FILE.read_bytes(), "text/html; charset=utf-8")
        if p == "/import.js":
            return self.send(200, (TOOL_DIR / "import.js").read_bytes(), "text/javascript; charset=utf-8")
        if p == "/api/hello":
            return self.send(200, {"ok": True, "version": VERSION, "configured": bool(ARCH.root)})
        o = self.headers.get("Origin")
        if o and not origin_ok(o):
            return self.send(403, {"error": "forbidden"})
        if p == "/api/state":
            return self.send(200, state_json())
        if p == "/api/rebuild":
            return self.send(200, REB.status())
        if p == "/api/thumb":
            with lock:
                path = tokens.get((q.get("t") or [""])[0])
            r = thumb_bytes(path) if path and os.path.isfile(path) else None
            if not r:
                return self.send(404, {"error": "no preview"})
            return self.send(200, r[0], r[1], cache=True)
        self.send(404, {"error": "not found"})

    def do_POST(self):
        # only the archive app / this tool may call the API: the custom header forces the browser to ask first
        # (OPTIONS above), and other websites are refused there
        if self.headers.get("X-XRay") != "1" or not self.host_ok() or not origin_ok(self.headers.get("Origin")):
            return self.send(403, {"error": "forbidden"})
        p = urllib.parse.urlparse(self.path).path
        try:
            if p == "/api/analyze":
                return self.send(200, self.analyze())
            data = self.body_json()
            if p == "/api/import-path":
                path = data.get("path")
                if data.get("t"):
                    with lock:
                        path = tokens.get(data["t"])
                return self.send(200, stage_path(path))
            if p == "/api/browse":   # list the X-rays inside a folder the user typed
                path = (data.get("path") or "").strip().strip('"')
                if os.path.isfile(path):
                    return self.send(200, {"files": [file_entry(path, os.stat(path))], "file": True})
                if not os.path.isdir(path):
                    raise ValueError("مش لاقي الفولدر أو الملف ده: " + path)
                return self.send(200, {"files": list_files(path, 2, 0, 300, os.path.basename(path)), "file": False})
            if p == "/api/recent":
                days = int(data.get("days") or CFG.get("recent_days") or 7)
                return self.send(200, {"files": recent_files(days),
                                       "folders": [{"name": n, "path": f} for n, f, _ in watch_folders()]})
            if p == "/api/save":
                with lock:
                    it = items.get(data.get("id"))
                if not it:
                    return self.send(404, {"error": "الملف ده اتشال أو اتحفظ قبل كده"})
                res = save_item(it, data.get("name", ""), data.get("year", ""), data.get("source", ""))
                drop_item(it["id"])
                if not res["duplicate"]:
                    REB.request()
                res["rebuild"] = REB.status()
                return self.send(200, res)
            if p == "/api/discard":
                drop_item(data.get("id"))
                return self.send(200, {"ok": True})
            if p == "/api/config":
                return self.send(200, set_config(data))
            if p == "/api/ignore":
                t = clean_name(data.get("text", ""))
                if t and t not in CFG["ignore_words"]:
                    CFG["ignore_words"] = CFG["ignore_words"] + [t]
                    save_settings(CFG)
                return self.send(200, {"ok": True, "ignore_words": CFG["ignore_words"]})
            if p == "/api/rebuild":
                REB.request(0)
                return self.send(200, REB.status())
            if p == "/api/rescan":
                ARCH.scan()
                return self.send(200, state_json())
            if p == "/api/pick":
                return self.send(200, {"path": pick_path(data.get("kind", "folder"))})
            if p == "/api/open":
                path = data.get("path") or ARCH.root
                if path and os.path.exists(path) and IS_WIN:
                    if os.path.isfile(path):
                        subprocess.Popen(["explorer", "/select,", path])
                    else:
                        os.startfile(path)
                return self.send(200, {"ok": True})
        except ValueError as e:
            return self.send(400, {"error": str(e)})
        except Exception as e:
            return self.send(500, {"error": "%s: %s" % (type(e).__name__, e)})
        self.send(404, {"error": "not found"})

    def analyze(self):
        n = int(self.headers.get("Content-Length") or 0)
        fname = urllib.parse.unquote(self.headers.get("X-File-Name") or "xray.jpg")
        fname = os.path.basename(fname.replace("\\", "/")) or "xray.jpg"
        iid = uuid.uuid4().hex[:12]
        d = STAGING / iid
        d.mkdir(parents=True, exist_ok=True)
        path = str(d / ("upload" + Path(fname).suffix.lower()))
        left = n
        with open(path, "wb") as f:
            while left > 0:
                b = self.rfile.read(min(left, 1 << 20))
                if not b:
                    break
                f.write(b)
                left -= len(b)
        if left:
            shutil.rmtree(d, ignore_errors=True)
            raise ValueError("الملف ما وصلش كامل")
        mtime = None
        try:
            mtime = int(self.headers.get("X-Last-Modified") or 0) / 1000 or None
            if mtime:
                os.utime(path, (mtime, mtime))
        except Exception:
            mtime = None
        it = {"id": iid, "dir": str(d), "path": path, "filename": fname, "size": n, "mtime": mtime, "t": time.time(),
              "reg": reg_key(fname, n, mtime)}
        with lock:
            items[iid] = it
        return analyze(it)


def drop_item(iid):
    with lock:
        it = items.pop(iid, None)
    if it:
        shutil.rmtree(it["dir"], ignore_errors=True)


def pick_path(kind):
    try:
        import tkinter
        from tkinter import filedialog
        r = tkinter.Tk()
        r.withdraw()
        r.attributes("-topmost", True)
        if kind in ("folder", "source"):
            title = "اختار فولدر الأشعة الأساسي" if kind == "folder" else "اختار الفولدر اللي فيه الأشعة"
            p = filedialog.askdirectory(title=title, parent=r)
        elif kind == "xray":
            p = filedialog.askopenfilename(title="اختار الأشعة", parent=r)
        else:
            p = filedialog.askopenfilename(title="اختار ملف تحديث الأرشيف (rebuild.bat)", parent=r,
                                           filetypes=[("Batch / script", "*.bat *.cmd *.py *.ps1"), ("All", "*.*")])
        r.destroy()
        return os.path.normpath(p) if p else ""
    except Exception:
        return ""


def set_config(data):
    if "xray_root" in data:
        root = (data.get("xray_root") or "").strip().strip('"')
        if root and not os.path.isdir(root):
            raise ValueError("الفولدر ده مش موجود: " + root)
        CFG["xray_root"] = os.path.normpath(root) if root else ""
    if "rebuild_cmd" in data:
        cmd = (data.get("rebuild_cmd") or "").strip().strip('"')
        if cmd and not os.path.exists(cmd):
            raise ValueError("الملف ده مش موجود: " + cmd)
        CFG["rebuild_cmd"] = cmd
    if "auto_save" in data:
        CFG["auto_save"] = bool(data["auto_save"])
    if "auto_save_seconds" in data:
        CFG["auto_save_seconds"] = max(1, min(30, int(data["auto_save_seconds"] or 5)))
    if "recent_days" in data:
        CFG["recent_days"] = max(1, min(365, int(data["recent_days"] or 7)))
    if "ignore_words" in data and isinstance(data["ignore_words"], list):
        CFG["ignore_words"] = [clean_name(w) for w in data["ignore_words"] if clean_name(w)]
    if "watch_folders" in data and isinstance(data["watch_folders"], list):
        bad = [p for p in data["watch_folders"] if p and not os.path.isdir(p.strip().strip('"'))]
        if bad:
            raise ValueError("الفولدر ده مش موجود: " + bad[0])
        CFG["watch_folders"] = [os.path.normpath(p.strip().strip('"')) for p in data["watch_folders"] if p.strip()]
    if "autostart" in data:
        set_autostart(bool(data["autostart"]))
    save_settings(CFG)
    ARCH.scan()
    return state_json()


def state_json():
    eng = ocr_engine()
    yrs = set(ARCH.years) | {str(datetime.now().year)}
    sf = startup_file()
    return {
        "configured": bool(ARCH.root and os.path.isdir(ARCH.root)),
        "xray_root": CFG.get("xray_root", ""), "rebuild_cmd": CFG.get("rebuild_cmd", ""),
        "auto_save": CFG.get("auto_save", True), "auto_save_seconds": CFG.get("auto_save_seconds", 5),
        "ignore_words": CFG.get("ignore_words", []), "sources": CFG.get("sources", []),
        "watch_folders": CFG.get("watch_folders", []), "recent_days": CFG.get("recent_days", 7),
        "autostart": bool(sf and os.path.exists(sf)), "windows": IS_WIN,
        "years": sorted(yrs, reverse=True),
        "year_folders": ARCH.years,
        "patients": [{"n": p["n"], "y": p["y"], "c": p["count"]} for p in ARCH.patients],
        "ocr": {"windows": "قراءة ويندوز", "tesseract": "Tesseract", "": ""}[eng],
        "pillow": Image is not None,
        "rebuild": REB.status(),
        "sep": os.sep,
    }


def cleanup_staging():
    if STAGING.exists():
        for d in STAGING.iterdir():
            shutil.rmtree(d, ignore_errors=True)


def port_in_use(port):
    with socket.socket() as s:
        s.settimeout(0.5)
        return s.connect_ex(("127.0.0.1", port)) == 0


def main():
    global REB
    port = int(CFG.get("port") or 8765)
    url = "http://127.0.0.1:%d/" % port
    quiet = "--no-browser" in sys.argv
    if port_in_use(port):  # already running -> just open the page
        if not quiet:
            webbrowser.open(url)
        return
    cleanup_staging()
    autodetect()
    ARCH.scan()
    REB = Rebuilder()
    srv = ThreadingHTTPServer(("127.0.0.1", port), H)
    print("=" * 56)
    print(" X-Ray import tool is running:  " + url)
    print(" X-Ray folder : " + (CFG.get("xray_root") or "(not set yet - choose it in the page)"))
    print(" Rebuild      : " + (CFG.get("rebuild_cmd") or "(not set)"))
    print(" OCR engine   : " + (ocr_engine() or "NONE"))
    if Image is None:
        print(" Tip: run  'py -m pip install pillow'  for better name reading.")
    print(" The archive app now shows the '+ add X-ray' button.")
    print(" Keep this window open while you use it. Close it to stop.")
    print("=" * 56)
    if not quiet:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


def log(msg):
    try:
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write("%s  %s\n" % (datetime.now().strftime("%Y-%m-%d %H:%M:%S"), msg))
    except OSError:
        pass


if __name__ == "__main__":
    try:
        log("start, python %s, settings: %s" % (sys.version.split()[0], json.dumps(CFG, ensure_ascii=False)))
        main()
    except Exception:
        import traceback
        err = traceback.format_exc()
        log("CRASH\n" + err)
        print("\n" + err)
        print("The tool stopped because of the error above. Send a photo of this window.")
        sys.exit(1)
