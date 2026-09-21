"""Readable Chinese transcript rendered solely from a `vbench.game_record/1`.

No other input is accepted, so the transcript cannot contain anything the
canonical JSON does not (in particular, no identities).
"""

from __future__ import annotations

import re

from .util import fmt_tc

VOTE_ZH = {"approve": "上票", "reject": "下票", "unknown": "看不清"}
SPEECH_MARK = "▍"  # every original-speech paragraph starts with this; tests rely on it


def _md_escape(text: str) -> str:
    # Keep original characters; only neutralise Markdown syntax at line starts / emphasis.
    return re.sub(r"([\\`*_#>|\[\]])", r"\\\1", text)


def _seat(s) -> str:
    return f"{s}号" if s is not None else "未知座位"


def _seats(xs) -> str:
    return "、".join(str(x) for x in xs) if xs else "（无）"


def _heading(ctx: dict, rules: dict) -> str:
    m, a = ctx.get("mission"), ctx.get("attempt")
    if m is None:
        return "## 轮次未知"
    size = None
    sizes = rules.get("mission_team_sizes")
    if sizes and 1 <= m <= len(sizes):
        size = sizes[m - 1]
    head = f"## 第{m}轮任务" + (f"（需要{size}人）" if size else "")
    head += f" · 第{a}次组队" if a is not None else " · 组队次数未知"
    return head


def render_markdown(record: dict) -> str:
    rules = record["rules"]
    cov = record["coverage"]
    lines = [
        "# 对局文字记录（公开信息）",
        "",
        f"> 数据集：**{'草稿（含未审阅的机器候选）' if record['draft'] else '已审阅（accepted）'}** · 记录 `{record['record_id']}`",
        "> 本文由规范化 JSON 时间线直接生成，只含公开发言与客观公开事件，不含任何身份答案。",
        "> 发言是剪辑后的烧录字幕原文（审阅以画面像素为准，未对照音频）；相邻字幕卡之间以一个空格连接，未添加标点。",
        "",
        "## 规则与覆盖范围",
        "",
        f"- 人数：{rules.get('player_count')}；各轮人数：{rules.get('mission_team_sizes')}；每轮组队上限：{rules.get('proposal_limit')}（最后一次{'为必做轮' if rules.get('final_proposal_forced') else '非必做'}）；湖中女神：{'未知' if rules.get('lady_of_the_lake') is None else rules.get('lady_of_the_lake')}",
        f"- 时间范围：{fmt_tc(cov['interval'][0])}–{fmt_tc(cov['interval'][1])}",
        f"- 已审阅区间：{'；'.join(f'{fmt_tc(a)}–{fmt_tc(b)}' for a, b in cov['reviewed_intervals']) or '无'}",
        f"- 未审阅区间：{'；'.join(f'{fmt_tc(a)}–{fmt_tc(b)}' for a, b in cov['unreviewed_intervals']) or '无'}",
        f"- 剪辑缺口：{len(cov['gaps'])} 处；发言轮次 {cov['counts']['speech_turns']}，发言段 {cov['counts']['speech_parts']}，字幕卡 {cov['counts']['segments_included']}（其中未审阅 {cov['counts']['segments_unreviewed_included']}，无字幕 ASR {cov['counts']['segments_asr_only_included']}）",
        "",
    ]
    last_heading = None
    for it in record["timeline"]:
        h = _heading(it["context"], rules)
        if h != last_heading:
            lines += [h, ""]
            last_heading = h
        if it["kind"] == "speech":
            tags = []
            if it["continues_turn"]:
                tags.append("续")
            if "speaker_unknown" in it["flags"]:
                tags.append("说话人未知")
            if "speaker_transition" in it["flags"] or it["speaker_basis"] not in ("label_stable", "reviewed"):
                tags.append("说话人待确认")
            if "overlap_suspected" in it["flags"]:
                tags.append("疑似多人重叠")
            if "unreviewed_segment" in it["flags"]:
                tags.append("含未审阅字幕")
            if "asr_only_segment" in it["flags"]:
                tags.append("含无字幕语音识别")
            if "long_pause" in it["flags"]:
                tags.append("中间有停顿")
            reasons = set(it["boundary_before"]["reasons"])
            if it["boundary_before"]["type"] == "new_turn" and "speaker_change" not in reasons:
                if "excluded_segment_between" in reasons:
                    tags.append("与上一段之间有未纳入本数据集的语音片段")
                if "long_gap" in reasons:
                    tags.append("长时间无字幕后重新开始")
                if "coverage_gap" in reasons:
                    tags.append("剪辑缺口后")
                if "reviewed_break" in reasons:
                    tags.append("审阅确认为新的一段发言")
            tag = f" 〔{'，'.join(tags)}〕" if tags else ""
            lines.append(f"**{_seat(it['seat'])}**{tag} `{fmt_tc(it['start'])}–{fmt_tc(it['end'])}`")
            lines.append("")
            lines.append(SPEECH_MARK + " " + _md_escape(it["text"]))
            lines.append("")
            continue
        if it["kind"] == "coverage_gap":
            lines.append(f"> **【剪辑缺口】** `{fmt_tc(it['start'])}–{fmt_tc(it['end'])}` {it['description']}")
            for o in it["omitted"]:
                lines.append(f"> - 画面中缺失：{o}")
            lines.append("")
            continue
        p = it["payload"]
        late = it["reporting"]["status"] == "retrospective"
        late_note = f"（事后补录：出现在剪辑缺口 `{it['reporting'].get('gap_id')}` 期间的记录板上，并非现场揭示）" if late else ""
        stamp = f"`{fmt_tc(it['public_at'])}`"
        if it["type"] == "team_selection":
            idx = p.get("proposal_index")
            lines.append(
                f"> **【发车】** {stamp} 第{p.get('mission')}轮第{idx if idx is not None else '?'}次组队：队长 {_seat(p.get('leader_seat'))}，车上 {_seats(p.get('team_seats'))}"
                + ("；必做轮（不投票）" if p.get("forced") else "") + late_note
            )
        elif it["type"] == "vote_observation":
            votes = p.get("votes", {})
            groups = {k: sorted(int(s) for s, v in votes.items() if v == k) for k in VOTE_ZH}
            missing = sorted(set(range(1, rules.get("player_count", 10) + 1)) - {int(s) for s in votes})
            parts = [f"{VOTE_ZH[k]} {_seats(groups[k])}" for k in ("approve", "reject") ] + ([f"看不清 {_seats(groups['unknown'])}"] if groups["unknown"] else []) + ([f"未观测 {_seats(missing)}"] if missing else [])
            lines.append(f"> **【票型】** {stamp} 第{p.get('mission')}轮第{p.get('proposal_index') or '?'}次组队：" + "；".join(parts) + late_note)
        elif it["type"] == "vote_outcome":
            res = {"passed": "车过了", "rejected": "车被否"}[p["result"]]
            tally = f"（{p['tally_text']}）" if p.get("tally_text") else "（票数未显示）"
            lines.append(f"> **【投票结果】** {stamp} 第{p.get('mission')}轮第{p.get('proposal_index') or '?'}次组队：{res}{tally}" + late_note)
        elif it["type"] == "mission_outcome":
            res = {"success": "任务成功", "fail": "任务失败"}[p["result"]]
            fc = p.get("fail_count")
            fct = "失败牌数未知" if fc is None else f"失败牌 {fc} 张"
            lines.append(f"> **【任务结果】** {stamp} 第{p.get('mission')}轮：{res}，{fct}" + late_note)
        else:
            lines.append(f"> **【{it['type']}】** {stamp} {p}" + late_note)
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def speech_paragraphs(markdown: str) -> list[str]:
    """Original-speech paragraphs in document order (for consistency checks)."""
    out = []
    for line in markdown.splitlines():
        if line.startswith(SPEECH_MARK + " "):
            out.append(re.sub(r"\\(.)", r"\1", line[len(SPEECH_MARK) + 1 :]))
    return out
