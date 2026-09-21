"""Proof-reading sheets for the timeline revision (public crops only).

Each row shows one subtitle card in timeline order: public label + subtitle
crops, the text currently in the record, the attributed seat, and turn/part
boundary markers; objective events and coverage gaps appear as text rows.
Unlike the v1 reference sheets these deliberately show machine text: they are
for proof-reading and grouping review, not for independent transcription.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np

from .util import fmt_tc, read_json, read_jsonl, write_json

FONT_CANDIDATES = [r"C:\Windows\Fonts\msyh.ttc", r"C:\Windows\Fonts\simhei.ttf", "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"]


def _font(size: int):
    from PIL import ImageFont

    for f in FONT_CANDIDATES:
        if Path(f).exists():
            return ImageFont.truetype(f, size)
    return ImageFont.load_default()


def build_review_sheets(run_root: Path, record_path: Path, start: float, end: float, out_dir: Path,
                        rows_per_sheet: int = 28, only_segment_ids: set[str] | None = None) -> dict:
    """`only_segment_ids` narrows the sheet to the segments that actually need a
    decision (the rest of the interval is still walked, so row numbers stay
    meaningful against the full record)."""
    from PIL import Image, ImageDraw

    record = read_json(record_path)
    utts = {u["utterance_id"]: u for u in read_jsonl(run_root / "views" / "all" / "utterances.jsonl")}
    speakers = {s["speaker_segment_id"]: s for s in read_jsonl(run_root / "public" / "speaker_segments.jsonl")}
    f_main, f_small = _font(24), _font(16)
    W, H = 1700, 52
    rows: list[Image.Image] = []
    index: list[dict] = []
    sheets = 0

    def flush():
        nonlocal rows, sheets
        if not rows:
            return
        sheets += 1
        img = Image.new("RGB", (W, H * len(rows)), "white")
        for i, r in enumerate(rows):
            img.paste(r, (0, i * H))
        out_dir.mkdir(parents=True, exist_ok=True)
        img.save(out_dir / f"sheet_{start:07.1f}_{sheets:03d}.png")
        rows = []

    def add(row, meta):
        rows.append(row)
        index.append(dict(meta, row=len(index) + 1, sheet=sheets + 1))
        if len(rows) == rows_per_sheet:
            flush()

    def crop_img(rel: str | None, size) -> Image.Image:
        if rel and (run_root / rel).exists():
            return Image.open(run_root / rel).convert("RGB").resize(size)
        return Image.new("RGB", size, (150, 150, 150))

    for it in record["timeline"]:
        t0 = it.get("start", it.get("public_at"))
        if t0 is None or not (start <= t0 < end):
            continue
        if it["kind"] != "speech":
            row = Image.new("RGB", (W, H), (255, 244, 214) if it["kind"] == "event" else (255, 220, 220))
            d = ImageDraw.Draw(row)
            if it["kind"] == "event":
                text = f"#{len(index) + 1}  {fmt_tc(it['public_at'])}  【{it['type']}】 {it['payload']}  reporting={it['reporting']['status']}  review={it['review_status']}"
            else:
                text = f"#{len(index) + 1}  {fmt_tc(it['start'])}–{fmt_tc(it['end'])}  【剪辑缺口】 {it['description']}"
            d.text((8, 14), text, fill="black", font=f_small)
            add(row, {"kind": it["kind"], "item_id": it["item_id"]})
            continue
        for k, s in enumerate(it["segments"]):
            if only_segment_ids is not None and s["segment_id"] not in only_segment_ids:
                continue
            u = utts[s["segment_id"]]
            row = Image.new("RGB", (W, H), "white")
            d = ImageDraw.Draw(row)
            if k == 0:
                color = (200, 0, 0) if it["boundary_before"]["type"] in ("new_turn", "start") else (0, 90, 200)
                d.rectangle([0, 0, W, 3], fill=color)
                d.text((8, 30), ("新轮次 " if it["boundary_before"]["type"] != "new_part" else "续段 ") + ",".join(it["boundary_before"]["reasons"]), fill=color, font=f_small)
            d.text((8, 6), f"#{len(index) + 1} {fmt_tc(s['start'])}", fill="black", font=f_small)
            spk = [speakers[r["id"]] for r in u["speaker"]["evidence_refs"] if r["id"] in speakers]
            label_crop = next((x.get("representative_crop") for x in spk if x.get("seat") == u["speaker"]["seat"]), None)
            row.paste(crop_img(label_crop, (150, 38)), (260, 7))
            row.paste(crop_img((u.get("caption") or {}).get("crop"), (560, 40)), (415, 6))
            status = {"accepted": "[OK]", "machine_candidate": "[?]", "needs_review": "[!]", "rejected": "[X]"}.get(s["review_status"], "[?]")
            seat = it["seat"] if it["seat"] is not None else "?"
            d.text((990, 10), f"{status} {seat}号  {s['text']}", fill="black", font=f_main)
            if s["source"] == "asr_only":
                d.text((990, 34), "（无字幕 ASR）", fill=(180, 0, 0), font=f_small)
            add(row, {"kind": "segment", "segment_id": s["segment_id"], "item_id": it["item_id"], "turn_id": it["turn_id"], "seat": it["seat"], "text": s["text"], "start": s["start"], "review_status": s["review_status"]})
    flush()
    write_json(out_dir / f"index_{start:07.1f}_{end:07.1f}.json", {"record": str(record_path), "interval": [start, end], "rows": index})
    return {"rows": len(index), "sheets": sheets, "out_dir": str(out_dir)}
