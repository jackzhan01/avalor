"""Render saved baseline results locally; never call a model or read a key."""
from __future__ import annotations

import html
import json
from pathlib import Path

from nlu_gemini_baseline import RUN

NAMES = {"merlin": "梅林", "percival": "派西维尔", "morgana": "莫甘娜", "assassin": "刺客", "servant": "忠臣"}


def main():
    scores = json.loads((RUN / "scores.json").read_text(encoding="utf8"))
    summary = scores["summary"]
    games = scores["games"]
    if not games:
        raise RuntimeError("No actual results to render")
    lines, details = [], []
    for game in games:
        gid = html.escape(game["game_id"])
        raw_link = f"{gid}/result.json"
        input_link = f"../../releases/avalon-nlu-full-v1/inputs/{gid}/input.en.txt"
        label_link = f"../../releases/avalon-nlu-full-v1/evaluator/{gid}/label.json"
        valid = "有效" if game["parse_error"] is None else html.escape(game["parse_error"])
        lines.append(f"<tr><td><a href='#g-{gid}'>{gid}</a></td><td>{game['role_correct']}/6</td><td>{game['side_correct']}/6</td><td>{'是' if game['all_roles_correct'] else '否'}</td><td>{valid}</td><td><a href='{input_link}'>Input</a> · <a href='{label_link}'>Label</a> · <a href='{raw_link}'>响应</a></td></tr>")
        seats = []
        for seat in map(str, range(1, 7)):
            actual = game["actual"][seat]
            predicted = (game.get("prediction") or {}).get(seat)
            seats.append(f"<tr><td>{seat}号</td><td>{NAMES[actual]}</td><td>{html.escape(NAMES.get(predicted, predicted or '无有效输出'))}</td><td>{'正确' if actual == predicted else '错误'}</td></tr>")
        details.append(f"<details id='g-{gid}'><summary>{gid} · 逐座位核对</summary><table><thead><tr><th>座位</th><th>真实身份</th><th>模型判断</th><th>结果</th></tr></thead><tbody>{''.join(seats)}</tbody></table></details>")
    attempted = summary["attempted_games"]
    pct = lambda key: f"{summary[key] * 100:.1f}%" if summary[key] is not None else "未计算"
    versions = sorted({g.get("model_version") for g in games if g.get("model_version")})
    usage = {key: sum(g.get("usage", {}).get(key, 0) or 0 for g in games) for key in ("promptTokenCount", "candidatesTokenCount", "thoughtsTokenCount", "totalTokenCount")}
    page = f"""<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Avalon NLU · Gemini 首轮实验</title><style>:root{{color-scheme:light dark;font:16px/1.6 system-ui,sans-serif}}body{{max-width:1150px;margin:auto;padding:30px}}h1{{font-size:28px}}p{{max-width:1000px}}table{{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}}th,td{{padding:10px;text-align:left;border-bottom:1px solid GrayText}}a{{color:LinkText}}details{{margin:20px 0}}summary{{cursor:pointer;font-weight:bold}}small{{opacity:.75}}.scroll{{overflow:auto}}</style>
<h1>Avalon NLU · Gemini 首轮实验</h1><small>数据：Avalon NLU 20 局六人局 · 公开英文全文身份推断 · 每局一次独立请求</small>
<p><b>当前已尝试 {attempted}/20 局；有效身份输出 {summary['valid_predictions']}/20 局。</b>尚未尝试 {summary['remaining_unattempted_games']} 局。无效响应在已尝试分母中按错误计，未尝试样本不混入当前准确率。</p>
<p><b>具体身份准确率：{pct('role_accuracy_on_attempted')}</b>（{summary['role_correct']}/{attempted*6} 个座位）<br>
<b>好坏阵营准确率：{pct('side_accuracy_on_attempted')}</b>（{summary['side_correct']}/{attempted*6} 个座位）<br>
<b>整局六人全对率：{pct('whole_game_accuracy_on_attempted')}</b>（{summary['whole_games_correct']}/{attempted} 局）</p>
<p>请求模型：{html.escape(scores['config']['model'])}；实际响应版本：{html.escape(', '.join(versions) or '响应未返回版本')}。temperature={scores['config']['temperature']}，thinking={scores['config']['thinking_level']}，输出 token 上限 {scores['config']['max_output_tokens']:,}，不联网搜索、不提供工具，不跨局保留上下文。输入截至刺杀／终局公告之前；角色答案、玩家 beliefs、策略和欺骗标注均未发送。两名忠臣统一评分为 servant。</p>
<p>正式实验前有一次 HIGH / 16,384 token 的接口试跑，触发 MAX_TOKENS 且未输出身份，单独保存在 ../gemini-4-hydrogen-full-v1/，不纳入本表。随后统一采用本页参数。</p>
<p>这是一次抽样的初步基线，不代表稳定性能或人类对照实验。对局是独立统计单位，同一局六人的判断相关。数据公开，无法保证模型训练时没见过。免费层由用户在 AI Studio 确认；本页不等同于 Google 账单。</p>
<div class="scroll"><table><thead><tr><th>对局</th><th>身份正确</th><th>阵营正确</th><th>整局全对</th><th>输出状态</th><th>审核</th></tr></thead><tbody>{''.join(lines)}</tbody></table></div>
<p>API 返回的 token 统计：输入 {usage['promptTokenCount']:,}；答案 {usage['candidatesTokenCount']:,}；思考 {usage['thoughtsTokenCount']:,}；总计 {usage['totalTokenCount']:,}。<a href='scores.json'>完整评分 JSON</a> · <a href='config.json'>固定实验参数</a></p>
{''.join(details)}</html>"""
    target = RUN / "overview.html"
    target.write_text(page, encoding="utf8")
    print(target)
    print(json.dumps({"summary": summary, "usage": usage, "model_versions": versions}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
