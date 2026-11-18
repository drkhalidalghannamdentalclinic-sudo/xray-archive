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

TOOL_DIR = Path(__file__).resolve().parent
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
                    idx.append({"k": k, "toks": k.split(), "n": latest["n"],
                                "years": sorted({p["y"] for p in ps}, reverse=True),
                                "count": sum(p["count"] for p in ps)})
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


def year_from_ocr(lines):
    for line in lines:
        l = ascii_digits(line)
        if BIRTH_RE.search(l) or not DATE_LINE_RE.search(l):
            continue
        y = find_year(l)
        if y:
            return y
    return None


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

    dicom = read_dicom(path) if (ext in DICOM_EXT or ext == "") else {}
    if dicom.get("name"):
        sources.append(("dicom", [dicom_name(dicom["name"])]))
    if dicom.get("date"):
        year, year_src = find_year(dicom["date"]), "تاريخ الأشعة (DICOM)"

    ocr_lines = []
    if ext in IMG_EXT:
        ex = exif_info(path)
        if ex["texts"]:
            sources.append(("meta", ex["texts"]))
        if not year and ex["date"] and find_year(ex["date"]):
            year, year_src = find_year(ex["date"]), "تاريخ التصوير"
        if not dicom.get("name"):
            ocr_lines, note = run_ocr(path, item["dir"])
            sources.append(("ocr", ocr_lines))
            if not year:
                y = year_from_ocr(ocr_lines)
                if y:
                    year, year_src = y, "التاريخ المكتوب على الأشعة"
    elif ext not in DICOM_EXT:
        note = "نوع الملف ده مش صورة — اكتب الاسم بإيدك"

    if not year and item.get("mtime"):
        year, year_src = str(datetime.fromtimestamp(item["mtime"]).year), "تاريخ الملف"
    this_year = str(datetime.now().year)
    if not year or not (1990 <= int(year) <= int(this_year) + 1):
        year, year_src = this_year, "السنة الحالية"

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
        "year": year, "year_source": year_src, "ocr_text": ocr_lines[:40], "note": note, "preview": preview,
    }


# ---------------------------------------------------------------- saving
def file_hash(p):
    h = hashlib.sha1()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def save_item(item, name, year):
    name = clean_name(name)
    if not name:
        raise ValueError("اكتب اسم المريض")
    year = ascii_digits(str(year)).strip()
    if not re.fullmatch(r"(19|20)\d\d", year):
        raise ValueError("السنة مش مظبوطة")
    if not ARCH.root or not os.path.isdir(ARCH.root):
        raise ValueError("فولدر الأشعة الأساسي مش متحدد أو مش موجود — افتح الإعدادات")

    ydir = ARCH.year_folder(year, create=True)
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
        folder = prev[0]["n"] if prev else name   # keep the same spelling as older years
    pdir = os.path.join(ydir, folder)
    os.makedirs(pdir, exist_ok=True)

    src = item["path"]
    fname = BAD_CHARS.sub("_", item["filename"]).strip() or ("xray" + Path(src).suffix)
    size = os.path.getsize(src)
    h = None
    for d in os.scandir(pdir):  # same file already there?
        if d.is_file() and d.stat().st_size == size:
            h = h or file_hash(src)
            if file_hash(d.path) == h:
                return {"duplicate": True, "path": d.path, "rel": os.path.relpath(d.path, ARCH.root), "new_patient": False, "folder": folder}
    stem, ext = os.path.splitext(fname)
    dest, n = os.path.join(pdir, fname), 2
    while os.path.exists(dest):
        dest = os.path.join(pdir, "%s (%d)%s" % (stem, n, ext))
        n += 1
    shutil.copy2(src, dest)
    if os.path.getsize(dest) != size:
        raise IOError("النسخ ما كملش — جرّب تاني")

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
    places = [TOOL_DIR, TOOL_DIR.parent, TOOL_DIR.parent.parent]
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
                         and f.parent != TOOL_DIR]
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


class H(BaseHTTPRequestHandler):
    server_version = "XRayImport/1"

    def log_message(self, *a):
        pass

    def send(self, code, body, ctype="application/json; charset=utf-8"):
        if not isinstance(body, (bytes, bytearray)):
            body = json_bytes(body)
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def body_json(self):
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n) or b"{}") if n else {}

    def do_GET(self):
        p = urllib.parse.urlparse(self.path).path
        if p in ("/", "/index.html"):
            return self.send(200, PAGE_FILE.read_bytes(), "text/html; charset=utf-8")
        if p == "/api/state":
            return self.send(200, state_json())
        if p == "/api/rebuild":
            return self.send(200, REB.status())
        self.send(404, {"error": "not found"})

    def do_POST(self):
        # only our own page may call the API (blocks other websites from posting to this local tool)
        if self.headers.get("X-XRay") != "1":
            return self.send(403, {"error": "forbidden"})
        p = urllib.parse.urlparse(self.path).path
        try:
            if p == "/api/analyze":
                return self.send(200, self.analyze())
            data = self.body_json()
            if p == "/api/save":
                with lock:
                    it = items.get(data.get("id"))
                if not it:
                    return self.send(404, {"error": "الملف ده اتشال أو اتحفظ قبل كده"})
                res = save_item(it, data.get("name", ""), data.get("year", ""))
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
                    CFG["ignore_words"].append(t)
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
        it = {"id": iid, "dir": str(d), "path": path, "filename": fname, "size": n, "mtime": mtime, "t": time.time()}
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
        if kind == "folder":
            p = filedialog.askdirectory(title="اختار فولدر الأشعة الأساسي", parent=r)
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
    for k in ("auto_save",):
        if k in data:
            CFG[k] = bool(data[k])
    if "auto_save_seconds" in data:
        CFG["auto_save_seconds"] = max(1, min(30, int(data["auto_save_seconds"] or 5)))
    if "ignore_words" in data and isinstance(data["ignore_words"], list):
        CFG["ignore_words"] = [clean_name(w) for w in data["ignore_words"] if clean_name(w)]
    save_settings(CFG)
    ARCH.scan()
    return state_json()


def state_json():
    eng = ocr_engine()
    yrs = set(ARCH.years) | {str(datetime.now().year)}
    return {
        "configured": bool(ARCH.root and os.path.isdir(ARCH.root)),
        "xray_root": CFG.get("xray_root", ""), "rebuild_cmd": CFG.get("rebuild_cmd", ""),
        "auto_save": CFG.get("auto_save", True), "auto_save_seconds": CFG.get("auto_save_seconds", 5),
        "ignore_words": CFG.get("ignore_words", []),
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
    if port_in_use(port):  # already running -> just open the page
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
    print(" Keep this window open while you use the tool. Close it to stop.")
    print("=" * 56)
    if "--no-browser" not in sys.argv:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
