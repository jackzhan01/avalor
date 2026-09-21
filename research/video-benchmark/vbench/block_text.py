"""The document that is actually sent to a model, and the sanitized blocks it is rendered from.

`blocks_document()` strips every audit field (ids, sequences, evidence, turn
structure) from `build_blocks()` output; `render_input()` accepts nothing else.
So the string on disk cannot contain a timecode, a record id or a private label
— there is no parameter through which one could arrive.
"""

from __future__ import annotations

ROLE_ZH = {"merlin": "梅林", "percival": "派西维尔", "loyal": "忠臣", "morgana": "莫甘娜",
           "mordred": "莫德雷德", "assassin": "刺客", "oberon": "奥伯伦", "minion": "爪牙"}
RESULT_ZH = {"success": "成功", "fail": "失败"}
OUTCOME_ZH = {"passed": "车过了", "rejected": "车被否"}
DOC_TITLE = "# 阿瓦隆对局记录"
UNKNOWN_SPEAKER = "说话人未知"

PUBLIC_BLOCK_KEYS = ("block_id", "mission", "attempt", "forced", "speech_recorded", "leader_seat",
                     "team_seats", "votes", "tally_text", "outcome", "mission_ran", "mission_result", "fail_count")

RULE_KEYS = ("player_count", "mission_team_sizes", "proposal_limit", "final_proposal_forced",
             "fails_required", "lady_of_the_lake", "role_composition")


def _speech_recorded(block: dict) -> str:
    if not block["speech"]:
        return "none" if block["gap_inside"] else "empty"
    return "partial" if block["gap_inside"] else "full"


def blocks_document(blocks: list[dict], rules: dict) -> dict:
    """Public projection of the blocks: the only thing the renderer is allowed to see."""
    out = []
    for b in blocks:
        pub = {k: b.get(k) for k in PUBLIC_BLOCK_KEYS}
        pub["speech_recorded"] = _speech_recorded(b)
        pub["speech"] = [{"seat": p["seat"], "text": p["text"]} for p in b["speech"]]
        out.append(pub)
    # `rules` stays complete because the internal checks (mission result vs fail
    # count, team size vs rule size) need every value. `rules_unverified` marks
    # the ones that are standard-rule assumptions rather than things this video
    # showed, and the renderer drops exactly those from the text a model reads.
    unverified = [k for k in RULE_KEYS if k in set(rules.get("unverified") or ())]
    return {
        "schema": "vbench.agent_blocks/1",
        "rules": {k: rules.get(k) for k in RULE_KEYS},
        "rules_unverified": unverified,
        "blocks": out,
    }


def _seats(xs) -> str:
    return "、".join(f"{s}号" for s in xs) if xs else "无"


def _nums(xs) -> str:
    return "、".join(str(x) for x in xs)


def coverage_line(blocks: list[dict]) -> str | None:
    """How far this record reaches, read off the blocks of THIS sample.

    Never off `mission_team_sizes`: a rule list can name missions the record
    never reached (this client shows three mission sizes in a game whose record
    stops inside mission 2), and a cutoff would inherit the full record's reach.
    """
    if not blocks:
        return None
    last = blocks[-1]
    m, a = last["mission"], last["attempt"]
    if last.get("mission_ran") and last.get("mission_result") is not None:
        return f"本记录到第 {m} 轮任务结束为止。"
    return f"本记录到第 {m} 轮第 {a} 次组队为止。"


def _header(doc: dict, speech: bool = True) -> list[str]:
    rules = doc["rules"]
    skip = set(doc.get("rules_unverified") or ())
    n = rules.get("player_count")
    sizes = rules.get("mission_team_sizes") or []
    limit = rules.get("proposal_limit")
    fails = rules.get("fails_required") or []
    comp = rules.get("role_composition") or {}
    lines = [DOC_TITLE, ""]
    rule = f"规则：{n} 人局"
    if sizes and "mission_team_sizes" not in skip:
        rule += f"；每轮任务人数依次为 {_nums(sizes)}"
        # A statement about what the record shows, true at every cutoff — not a
        # claim about how far the game got, which is the coverage line's job.
        if len(sizes) < 5:
            rule += "（记录中只出现过前 %d 轮的人数）" % len(sizes)
    if limit and "proposal_limit" not in skip:
        forced = rules.get("final_proposal_forced") and "final_proposal_forced" not in skip
        rule += f"；每轮最多 {limit} 次组队" + ("，第 %d 次为强制执行、不投票" % limit if forced else "")
    if fails and "fails_required" not in skip:
        rule += f"；各轮任务判定失败所需的失败牌数依次为 {_nums(fails)}"
    lines.append(rule + "。")
    if comp and "role_composition" not in skip:
        lines.append("身份构成：" + "、".join(f"{ROLE_ZH.get(k, k)} {v}" for k, v in comp.items() if v) + "。")
    lines.append(f"座位：1 号到 {n} 号。")
    lady = rules.get("lady_of_the_lake")
    if "lady_of_the_lake" not in skip:
        if not lady:
            lines.append("湖中女神：本记录中没有出现过。")
        else:
            after = lady.get("used_after_missions")
            lines.append("湖中女神：本局有" + (f"，在第 {_nums(after)} 轮任务结束后使用。" if after else "。"))
    cov = coverage_line(doc.get("blocks") or [])
    if cov:
        lines.append(cov)
    if speech:
        lines.append("以下按每次组队分段，先是该次组队讨论中的玩家原话，然后是这次组队的客观结果。「说话人未知」表示画面没有显示是谁在说话。")
    else:
        # Says what this document holds, and nothing about why. It must not say
        # that nobody spoke: withheld by an experiment and absent from the record
        # are different claims, and the second one is false here.
        lines.append("以下按每次组队分段，列出这次组队的客观结果。")
    lines.append("")
    return lines


def _block_heading(b: dict) -> str:
    head = f"第{b['mission']}轮任务 · 第{b['attempt']}次组队"
    return head + "（强制轮）" if b["forced"] else head


def render_input(doc: dict, speech: bool = True) -> str:
    """The exact string sent as the user message. Input is the sanitized document only.

    `speech=False` is the objective-only ablation: every original utterance and
    every speech-coverage marker is withheld. Nothing else moves — same rules,
    same coverage sentence, same blocks in the same order, same facts.
    """
    lines = _header(doc, speech)
    for b in doc["blocks"]:
        lines.append(_block_heading(b))
        lines.append("")
        if speech:
            for p in b["speech"]:
                who = f"{p['seat']}号" if p["seat"] is not None else UNKNOWN_SPEAKER
                lines.append(f"{who}：{p['text']}")
            if b["speech"]:
                lines.append("")
            if b["speech_recorded"] == "none":
                lines += ["发言：未记录", ""]
            elif b["speech_recorded"] == "partial":
                lines += ["发言：部分未记录", ""]
            elif b["speech_recorded"] == "empty":
                # No caption and no accepted record is an absence of observation,
                # not proof that nobody spoke, so the wording stays at "未见".
                lines += ["发言：本段未见玩家发言", ""]
        lines += _facts(b)
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def _facts(b: dict) -> list[str]:
    out = []
    if b["leader_seat"] is not None:
        out.append(f"车主：{b['leader_seat']}号")
    if b["team_seats"]:
        out.append(f"车队：{_nums(b['team_seats'])}")
    elif b["leader_seat"] is not None:
        out.append("车队：未记录")
    if b["forced"] and b["team_seats"]:
        out.append("投票：无需投票，强制执行")
    elif b["votes"] is not None:
        v = b["votes"]
        out.append("上票：" + (_nums(v["approve"]) or "无"))
        out.append("下票：" + (_nums(v["reject"]) or "无"))
        if v["unclear"]:
            out.append("看不清：" + _nums(v["unclear"]))
        if v["unrecorded"]:
            out.append("未记录：" + _nums(v["unrecorded"]))
    elif b["outcome"] is not None:
        out.append("票型：未记录")
    if b["outcome"] is not None:
        tally = f"（{b['tally_text']}）" if b["tally_text"] else ""
        out.append(f"组队结果：{OUTCOME_ZH[b['outcome']]}{tally}")
    elif b["votes"] is not None:
        out.append("组队结果：未记录")
    if b["mission_ran"]:
        if b["mission_result"] is None:
            out.append("任务结果：未记录")
        else:
            out.append(f"任务结果：{RESULT_ZH[b['mission_result']]}")
            out.append("失败牌：" + ("未知" if b["fail_count"] is None else str(b["fail_count"])))
    return out


def speech_lines(text: str) -> list[tuple[str, str]]:
    """(speaker, words) for every speech line of a rendered document (checks and tests)."""
    out = []
    for line in text.splitlines():
        if "：" not in line:
            continue
        who, _, words = line.partition("：")
        if who == UNKNOWN_SPEAKER or (who.endswith("号") and who[:-1].isdigit()):
            out.append((who, words))
    return out
