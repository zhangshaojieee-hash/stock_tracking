"""Display-only stock industry, concept, and highest-profit business metadata."""
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from urllib.parse import quote

import db
from net import robust_get

PROFILE_TTL = 7 * 24 * 3600
PROFILE_RETRY_SEC = 10 * 60
_PROFILE_LOCK = threading.Lock()
_PROFILE_LOADING = False
_PROFILE_FAILED_UNTIL = 0.0


def _market_code(code):
    code = str(code or "").lower()
    if len(code) < 3 or code[:2] not in ("sh", "sz"):
        return None
    return ("1" if code.startswith("sh") else "0") + code[2:]


def _split_concepts(value):
    if not value or value == "-":
        return ""
    values = [x.strip() for x in re.split(r"[,，;；/、]+", str(value))]
    return ",".join(dict.fromkeys(x for x in values if x and x != "-"))


def normalize(code, payload):
    data = (payload or {}).get("data") or {}
    return {
        "code": code,
        "industry": str(data.get("f127") or "").strip(),
        "region": str(data.get("f128") or "").strip(),
        "concepts": _split_concepts(data.get("f129")),
        "fetched_at": time.time(),
    }


def _secucode(code):
    code = str(code or "").lower()
    if len(code) < 3 or code[:2] not in ("sh", "sz"):
        return None
    return code[2:] + (".SH" if code.startswith("sh") else ".SZ")


def _data_url(report, columns, filter_value, page_size=100):
    return ("https://datacenter.eastmoney.com/securities/api/data/v1/get"
            f"?reportName={report}&columns={quote(columns)}"
            f"&filter={quote(filter_value)}&pageNumber=1&pageSize={page_size}"
            "&source=HSF10&client=PC")


def _batch_filter(secucodes):
    values = '","'.join(secucodes)
    return f'(SECUCODE in ("{values}"))'


def _code_from_secucode(value):
    value = str(value or "").upper()
    if value.endswith(".SH"):
        return "sh" + value[:-3]
    if value.endswith(".SZ"):
        return "sz" + value[:-3]
    return ""


def _business_url(code):
    code = str(code or "").lower()
    if len(code) < 3 or code[:2] not in ("sh", "sz"):
        return None
    symbol = code[:2].upper() + code[2:]
    return ("https://emweb.securities.eastmoney.com/PC_HSF10/BusinessAnalysis/"
            f"PageAjax?code={quote(symbol)}")


def _primary_business(code):
    """Return the latest-report business with the highest disclosed profit."""
    url = _business_url(code)
    if not url:
        return ""
    try:
        payload = robust_get(url, timeout=15).json()
        rows = payload.get("zygcfx") or []
        if not rows:
            return ""
        latest = max(str(row.get("REPORT_DATE") or "") for row in rows)
        rows = [row for row in rows if str(row.get("REPORT_DATE") or "") == latest]
        # Product-level data is the closest available mapping to a business category.
        for op_type in ("2", "1", "3"):
            typed = [row for row in rows if str(row.get("MAINOP_TYPE") or "") == op_type]
            if typed:
                rows = typed
                break
        def profit(row):
            value = row.get("MAIN_BUSINESS_RPOFIT")
            try:
                return float(value)
            except (TypeError, ValueError):
                return float("-inf")
        row = max(rows, key=profit)
        name = str(row.get("ITEM_NAME") or "").strip()
        return name
    except Exception:
        return ""


def _profile_row(code, basic=None, concepts=None, primary_business=""):
    basic = basic or {}
    names = [str(item.get("BOARD_NAME") or "").strip()
             for item in (concepts or [])
             if str(item.get("IS_PRECISE") or "") == "1"]
    industry = str(basic.get("EM2016") or basic.get("INDUSTRYCSRC1") or "").strip()
    concepts_text = ",".join(dict.fromkeys(x for x in names if x))
    # Some issuers do not publish a usable segment-profit table. Use the
    # first precise concept as a clearly bounded display fallback.
    representative = primary_business or (names[0] if names else industry)
    return {
        "code": code,
        "industry": industry,
        "region": "",
        "concepts": concepts_text,
        "primary_concept": representative,
        "primary_business": representative,
        "fetched_at": time.time(),
    }


def fetch_one(code):
    secucode = _secucode(code)
    if not secucode:
        return None
    try:
        basic_url = _data_url(
            "RPT_F10_BASIC_ORGINFO", "SECUCODE,EM2016,INDUSTRYCSRC1",
            f'(SECUCODE="{secucode}")', page_size=1)
        concept_url = _data_url(
            "RPT_F10_CORETHEME_BOARDTYPE",
            "SECUCODE,BOARD_NAME,IS_PRECISE,BOARD_RANK",
            f'(SECUCODE="{secucode}")(IS_PRECISE="1")', page_size=5000)
        basic = robust_get(basic_url, timeout=10).json()
        concepts = robust_get(concept_url, timeout=10).json()
        basic_rows = ((basic.get("result") or {}).get("data")) or []
        concept_rows = ((concepts.get("result") or {}).get("data")) or []
        if not basic_rows and not concept_rows:
            return None
        return _profile_row(code, basic_rows[0] if basic_rows else {}, concept_rows,
                            _primary_business(code))
    except Exception:
        # Do not cache transport failures as an empty profile. They remain
        # pending and can be retried on the next API poll.
        return None


def fetch_batch(codes):
    """Fetch industry and precise concepts for a bounded group of stocks."""
    pairs = [(str(code), _secucode(code)) for code in codes]
    pairs = [(code, secucode) for code, secucode in pairs if secucode]
    if not pairs:
        return []
    try:
        secucodes = [secucode for _, secucode in pairs]
        filter_value = _batch_filter(secucodes)
        basic_url = _data_url(
            "RPT_F10_BASIC_ORGINFO", "SECUCODE,EM2016,INDUSTRYCSRC1",
            filter_value, page_size=len(secucodes))
        concept_url = _data_url(
            "RPT_F10_CORETHEME_BOARDTYPE",
            "SECUCODE,BOARD_NAME,IS_PRECISE,BOARD_RANK",
            filter_value + '(IS_PRECISE="1")', page_size=5000)
        basic = robust_get(basic_url, timeout=20).json()
        concepts = robust_get(concept_url, timeout=20).json()
        basic_by_code = {
            _code_from_secucode(row.get("SECUCODE")): row
            for row in (((basic.get("result") or {}).get("data")) or [])
        }
        concepts_by_code = {}
        for row in (((concepts.get("result") or {}).get("data")) or []):
            code = _code_from_secucode(row.get("SECUCODE"))
            if code:
                concepts_by_code.setdefault(code, []).append(row)
        rows = [_profile_row(code, basic_by_code.get(code), concepts_by_code.get(code))
                for code, _ in pairs
                if code in basic_by_code or code in concepts_by_code]
        # Main-business data is one request per stock, so keep it bounded and
        # independent from the bulk industry/concept queries.
        with ThreadPoolExecutor(max_workers=8) as executor:
            business = dict(zip(
                (code for code, _ in pairs),
                executor.map(_primary_business, (code for code, _ in pairs))))
        for row in rows:
            representative = business.get(row["code"], "") or row.get("primary_concept", "")
            row["primary_business"] = representative
            row["primary_concept"] = representative
        return rows
    except Exception:
        # A failed batch is left pending so the next poll can retry it.
        return []


def _refresh(codes):
    global _PROFILE_FAILED_UNTIL
    saved = False
    codes = list(codes)
    batches = [codes[start:start + 200] for start in range(0, len(codes), 200)]
    with ThreadPoolExecutor(max_workers=4) as executor:
        futures = [executor.submit(fetch_batch, batch) for batch in batches]
        for future in as_completed(futures):
            try:
                rows = future.result()
            except Exception:
                rows = []
            if rows:
                db.save_stock_profiles(rows)
                saved = True
    if saved:
        _PROFILE_FAILED_UNTIL = 0.0
    else:
        _PROFILE_FAILED_UNTIL = time.time() + PROFILE_RETRY_SEC


def ensure_async(codes):
    """Refresh missing/stale metadata without delaying the signal API."""
    global _PROFILE_LOADING
    codes = {str(code) for code in codes if code}
    if not codes:
        return
    with _PROFILE_LOCK:
        if _PROFILE_LOADING or time.time() < _PROFILE_FAILED_UNTIL:
            return
    fresh = db.stock_profiles(codes)
    now = time.time()
    missing = [code for code in codes
               if code not in fresh
               or not (fresh[code].get("industry") or fresh[code].get("region")
                       or fresh[code].get("concepts"))
               or not (fresh[code].get("primary_business") or fresh[code].get("primary_concept"))
               or now - float(fresh[code].get("fetched_at") or 0) > PROFILE_TTL]
    if not missing:
        return
    with _PROFILE_LOCK:
        if _PROFILE_LOADING:
            return
        _PROFILE_LOADING = True
    def worker():
        global _PROFILE_LOADING
        try:
            _refresh(missing)
        finally:
            with _PROFILE_LOCK:
                _PROFILE_LOADING = False
    threading.Thread(target=worker, name="stock-profile-refresh", daemon=True).start()


def pending_count(codes):
    codes = {str(code) for code in codes if code}
    if not codes:
        return 0
    fresh = db.stock_profiles(codes)
    now = time.time()
    return sum(1 for code in codes
               if code not in fresh
               or not (fresh[code].get("industry") or fresh[code].get("region")
                       or fresh[code].get("concepts"))
               or not (fresh[code].get("primary_business") or fresh[code].get("primary_concept"))
               or now - float(fresh[code].get("fetched_at") or 0) > PROFILE_TTL)
