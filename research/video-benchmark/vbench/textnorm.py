"""Comparison-only text normalization and edit distance.

Nothing here rewrites stored text. These functions build a *comparison view*
so OCR jitter and ASR formatting differences can be measured.
"""

from __future__ import annotations

import re
import unicodedata

_PUNCT = re.compile(r"[\s　,.!?;:'\"，。！？；：、“”‘’（）()\[\]【】《》<>…—\-~·]+")
_CN_DIGITS = {"零": "0", "〇": "0", "一": "1", "二": "2", "两": "2", "三": "3", "四": "4", "五": "5", "六": "6", "七": "7", "八": "8", "九": "9"}
NEGATION_CHARS = ("不", "没", "别", "非", "否", "未", "无")

# Common traditional forms Whisper emits for Mandarin; comparison only.
_T2S = str.maketrans({
    "說": "说", "號": "号", "們": "们", "個": "个", "這": "这", "那": "那", "覺": "觉", "得": "得",
    "們": "们", "為": "为", "麼": "么", "會": "会", "對": "对", "還": "还", "過": "过", "裡": "里",
    "裏": "里", "後": "后", "來": "来", "車": "车", "發": "发", "點": "点", "壞": "坏", "應": "应",
    "該": "该", "現": "现", "樣": "样", "開": "开", "時": "时", "間": "间", "問": "问", "題": "题",
    "給": "给", "話": "话", "邊": "边", "讓": "让", "嗎": "吗", "們": "们", "們": "们", "聽": "听",
    "當": "当", "們": "们", "驗": "验", "臣": "臣", "語": "语", "認": "认", "識": "识", "錯": "错",
    "隊": "队", "長": "长", "輪": "轮", "務": "务", "組": "组", "場": "场", "嘛": "嘛", "麽": "么",
    "與": "与", "從": "从", "動": "动", "頭": "头", "見": "见", "決": "决", "幾": "几", "張": "张",
    "兩": "两", "關": "关", "係": "系", "準": "准", "實": "实", "際": "际", "類": "类", "聲": "声",
    "帶": "带", "綫": "线", "線": "线", "選": "选", "爲": "为", "並": "并", "麥": "麦", "蘭": "兰",
    "淨": "净", "乾": "干", "幹": "干", "紅": "红", "藍": "蓝", "們": "们", "們": "们",
})


def normalize_for_compare(text: str | None) -> str:
    if not text:
        return ""
    t = unicodedata.normalize("NFKC", text)
    t = t.translate(_T2S)
    t = _PUNCT.sub("", t)
    return t.lower()


def canonical_numerals(text: str) -> str:
    """Map Chinese seat-style numerals to digits: 十号 -> 10号, 三 -> 3."""
    t = re.sub(r"十([一二三四五六七八九])", lambda m: "1" + _CN_DIGITS[m.group(1)], text)
    t = re.sub(r"(?<![一二三四五六七八九])十", "10", t)
    return "".join(_CN_DIGITS.get(ch, ch) for ch in t)


def levenshtein(a: str, b: str) -> int:
    if a == b:
        return 0
    if len(a) < len(b):
        a, b = b, a
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def cer(hyp: str | None, ref: str | None, canonical_digits: bool = False) -> float | None:
    """Character error rate of hyp against ref on the comparison view.

    canonical_digits folds 二号/2号 together; used for caption-vs-ASR distance,
    never for OCR quality against a reference (a misread digit is an error there).
    """
    r = normalize_for_compare(ref)
    h = normalize_for_compare(hyp)
    if canonical_digits:
        r, h = canonical_numerals(r), canonical_numerals(h)
    if not r:
        return None if not h else 1.0
    return levenshtein(h, r) / len(r)


def similar(a: str, b: str, max_cer: float) -> bool:
    na, nb = normalize_for_compare(a), normalize_for_compare(b)
    if not na or not nb:
        return na == nb
    return levenshtein(na, nb) / max(len(na), len(nb)) <= max_cer


def numerals_in(text: str) -> list[str]:
    return re.findall(r"\d+", canonical_numerals(normalize_for_compare(text)))


def negation_count(text: str) -> int:
    t = normalize_for_compare(text)
    return sum(t.count(c) for c in NEGATION_CHARS)
