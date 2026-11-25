"""Render a self-contained checkpoint report from saved model responses."""
import json
import random
from collections import Counter
from html import escape
from statistics import fmean

from nlu_rounds import OUT, base, jobs, outcomes

SITE = base.REPO / "research/avalon-task-exhibit/dist"
TASKS = {"roles":"全桌身份", "percival":"派西 · 累计发言", "recent":"派西 · 仅本轮发言"}
METRICS = {
    "role":("具体身份准确率","每人身份与底牌相符得 1 分，两名忠臣等价。"),
    "side":("阵营准确率","同一座位的好坏阵营判对得 1 分。"),
    "exact":("六人全对率","六个座位具体身份全部正确才得 1 分。"),
    "accuracy":("拇指位辨认准确率","押中真梅林得 1 分，押错得 0 分，五五开得半分。"),
    "prob":("给真梅林的概率","揭晓底牌后，读取模型给真梅林的概率。越高越好。"),
    "confidence":("自报信心","取两个候选概率的较大值。认错时也可能很高。"),
    "brier":("Brier 分数","（1 − 给真梅林的概率）²，越低越好。")}


def mean(values):
    return fmean(values) if values else None


def fmt(v, key, delta=False):
    if v is None:
        return "—"
    if key == "brier":
        return f"{v:+.3f}" if delta else f"{v:.3f}"
    return f"{v*100:+.1f}" if delta else f"{v*100:.1f}%"


def ci(values):
    if len(values) < 2:
        return None
    rng = random.Random(580)
    boots = sorted(fmean(rng.choices(values,k=len(values))) for _ in range(2000))
    return boots[49],boots[1949]


def chart(data, metric):
    points = []
    labels = []
    for k in range(1,6):
        avg = mean([d[k] for d in data.values() if d.get(k) is not None])
        if avg is None:
            continue
        x,y = 55+(k-1)*137, 125-95*avg
        points.append(f"{x},{y:.1f}")
        labels.append(f'<circle cx="{x}" cy="{y:.1f}" r="4" fill="#16483e"/><text x="{x}" y="{y-10:.1f}">{fmt(avg,metric)}</text><text x="{x}" y="148">第 {k} 轮</text>')
    return ('<svg viewBox="0 0 665 160" style="display:block;width:100%;max-width:780px;background:#fffef9" role="img" aria-label="各轮实际参评局的平均得分，明细见下表"><g stroke="#dce2d8"><path d="M35 30H645 M35 77.5H645 M35 125H645"/></g>'
            +'<polyline fill="none" stroke="#407762" stroke-width="3" points="'+' '.join(points)+'"/><g text-anchor="middle" fill="#193a32" font-size="13">'+''.join(labels)+'</g></svg>')


def panel(all_rows, task, metric):
    rows = [r for r in all_rows if r["task"] == task]
    games = sorted({r["game"] for r in rows})
    data = {g: {r["round"]:r.get(metric) for r in rows if r["game"]==g} for g in games}
    routed = {(r["game"],r["round"]) for r in rows if r.get("transport")=="OpenRouter"}
    last = [d[max(d)]-d[1] for d in data.values() if d[1] is not None and d[max(d)] is not None]
    per_step = [(d[max(d)]-d[1])/(max(d)-1) for d in data.values() if all(v is not None for v in d.values())]
    title, meaning = METRICS[metric]
    unit = "分" if metric=="brier" else "个百分点"
    bounds = ci(last)
    interval = f' · 95% 区间 {fmt(bounds[0],metric,True)} 至 {fmt(bounds[1],metric,True)} {unit}' if bounds else ""
    parts = [f'<section class="panel" id="{task}-{metric}"><h2>{TASKS[task]} · {title}</h2><p>{meaning}</p>',
             f'<div class="call"><strong>{fmt(mean(last),metric,True)}</strong> {unit}　每局首轮到各自末轮的平均变化 · {len(last)} 局{interval}</div>',
             f'<p>数值上升 {sum(d>0 for d in last)} 局，持平 {sum(d==0 for d in last)} 局，下降 {sum(d<0 for d in last)} 局。'
             f'按局等权，平均每推进一轮变化 {fmt(mean(per_step),metric,True)} {unit}（{len(per_step)} 局完整记录；各局先用首末差除以轮间隔数）。</p>',
             '<h3>总体趋势</h3>',chart(data,metric),'<div class="scroll"><table><thead><tr><th>任务结束后</th><th>本轮均值</th><th>参评局数¹</th><th>较上一轮的配对变化</th><th>配对局数</th></tr></thead><tbody>']
    for k in range(1,6):
        vals = [d[k] for d in data.values() if d.get(k) is not None]
        diffs = [d[k]-d[k-1] for d in data.values() if d.get(k) is not None and d.get(k-1) is not None]
        v = mean(vals)
        bar = f'<i style="width:{100*v:.2f}%"></i>' if v is not None else ""
        parts.append(f'<tr><th>第 {k} 轮</th><td><div class="bar">{bar}<b>{fmt(v,metric)}</b></div></td><td>{len(vals)} / {sum(k in d for d in data.values())}</td><td>{fmt(mean(diffs),metric,True)}</td><td>{len(diffs) if k>1 else "—"}</td></tr>')
    parts.append(f'</tbody></table></div><p class="note">¹ 分母是实际打到本轮的局数。变化单位为{unit}，只比较两端都有得分的同一局。全桌任务的无效预测按 0 分计，派西无效概率留空。</p><h3>逐局对照</h3><p>格内上行是本轮成绩，下行是较上一轮的变化。斜线表示该局已结束，空缺用破折号表示。</p><div class="scroll"><table><thead><tr><th>对局</th>'+''.join(f'<th>第 {k} 轮</th>' for k in range(1,6))+'<th>首轮至末轮</th></tr></thead><tbody>')
    for g,d in data.items():
        parts.append(f'<tr data-game="{escape(g)}"><th>{escape(g)}</th>')
        for k in range(1,6):
            v = d.get(k)
            prev = d.get(k-1)
            delta = f'<small>{fmt(v-prev,metric,True)}</small>' if v is not None and prev is not None else ""
            source = '<sup title="经 OpenRouter 调用 Google AI Studio">＊</sup>' if (g,k) in routed else ""
            parts.append(f'<td>{fmt(v,metric) if k in d else "／"}{source}{delta}</td>')
        a,b = d[1],d[max(d)]
        parts.append(f'<td>{fmt(b-a if a is not None and b is not None else None,metric,True)}</td></tr>')
    parts.append('</tbody></table></div></section>')
    return ''.join(parts)


def render():
    outcomes(jobs())
    rows = base.read(OUT/"scores.json")
    valid = Counter(r["task"] for r in rows if r.get("valid"))
    attempted = Counter(r["task"] for r in rows if "valid" in r)
    receipts = [base.read(p) for p in OUT.glob("*/q*/*.json")]
    routed = [r["openrouter"] for r in receipts if r.get("transport")=="OpenRouter"]
    router_cost = sum(r["usage"]["cost"] for r in routed)
    direct = [r["response"]["usageMetadata"] for r in receipts if r.get("transport")!="OpenRouter"]
    fresh = [r["response"]["usageMetadata"] for r in receipts]
    inputs = sum(x["promptTokenCount"] for x in fresh)
    outputs = sum(x.get("thoughtsTokenCount",0)+x.get("candidatesTokenCount",0) for x in fresh)
    old = 129109*1.5e-6+174651*7.5e-6
    direct_equivalent = old + sum(u["promptTokenCount"]*1.5e-6+
              (u.get("candidatesTokenCount",0)+u.get("thoughtsTokenCount",0))*7.5e-6 for u in direct)
    page = ['''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>逐轮实测 · 阿瓦隆身份推断</title><style>
    :root{--ink:#193a32;--muted:#4d655c;--line:#cbd6c9;--paper:#f5f5ed;--green:#16483e}*{box-sizing:border-box}body{margin:0;color:var(--ink);background:var(--paper);font:17px/1.65 Inter,"Microsoft YaHei",sans-serif}.wrap,main{width:min(1080px,calc(100% - 32px));margin:auto}header{background:#113e36;color:#fffced;padding:28px 0}header a{color:#ebcf89}.kicker{color:#ead29d;letter-spacing:.1em}h1,h2,h3{font-family:"Noto Serif SC",SimSun,serif;line-height:1.3}h1{font-size:clamp(34px,5vw,58px);margin:.25em 0}h2{font-size:29px;margin:.9em 0 .2em}h3{margin:1.4em 0 .4em}p{margin:.55em 0}main{padding:20px 0 50px}.selector{display:flex;gap:15px;flex-wrap:wrap}label{font-weight:650}select{display:block;max-width:100%;min-height:44px;padding:6px 15px;font:inherit;color:var(--ink);background:white;border:1px solid #829b8c;border-radius:4px}.call{margin:18px 0;background:#e5edde;border-left:4px solid var(--green);padding:12px 16px}.call strong{font:36px Georgia,serif}.scroll{overflow-x:auto}table{width:100%;border-collapse:collapse;background:#fffef9;font-variant-numeric:tabular-nums}th,td{white-space:nowrap;text-align:left;padding:8px 12px;border-bottom:1px solid var(--line)}thead{color:var(--muted);font-size:15px}tbody th{font-weight:550}.bar{min-width:70px;position:relative}.bar i{position:absolute;top:75%;left:0;background:#b3d5b9;height:4px}.bar b{position:relative}.note,small{color:var(--muted);font-size:14px}small{display:block}details{margin-top:22px;padding:12px 16px;border:1px solid var(--line)}summary{cursor:pointer;font-weight:650}a{color:inherit}section[hidden]{display:none}
    </style><header><div class="wrap"><a href="index.html">返回实验设计</a>　<a href="comparison.html">六人／十人模型与费用对比</a><p class="kicker">AVALON NLU / 逐轮实测</p><h1>多听一轮，能多认出谁？</h1><p>20 局六人真人对局 · 每个截点独立推断 · 轮次按任务结果公布划分</p></div></header><main>''']
    page.append('<p><b>有效回答</b>　'+'　／　'.join(f'{TASKS[t]} {valid[t]}/82' for t in TASKS)+'</p>')
    if all(valid[t]==82 for t in TASKS):
        page.append('<div class="call"><b>实验完成 · 20 局的每个轮末均已评分</b><p>第一至第五轮分别有 20、20、20、16、6 局。下表按游戏等权比较首轮与各局自己的末轮。</p><a href="#history-control">查看累计发言和只看本轮的配对结果</a></div>')
    if routed:
        page.append(f'<p class="note">全实验包含 {20+len(direct)} 份 Google 直连回执及 {len(routed)} 份 OpenRouter 回执。逐局表中的 ＊ 标明 OpenRouter。续跑锁定 Google AI Studio、同款 Gemini 4 Hydrogen、中等思考强度及原始提示。接口差异与对照条件存在重合，比较时需要一并考虑。</p>')
    block = OUT/"last_api_block.json"
    if block.exists() and base.read(block)["http_status"]==402 and len(fresh)<206:
        missing = 164-attempted["roles"]-attempted["percival"]
        page.append(f'<div class="call"><b>阶段结果 · API 报告预付余额耗尽（HTTP 402）</b><p>新增 {len(fresh)}/206 次有效响应。两项主实验尚缺 {missing} 个截点，'
                    f'加上对照共缺 {206-len(fresh)} 次调用。各轮样本量见表，空缺不计入均值。第一轮共用的回答无法独立检验累计发言是否有帮助。</p></div>')
    page.append('<p class="note">20 份全桌末轮复用历史结果；派西两个条件共用 20 个首轮回答。各格只列保存的实际响应。无效输出数按上述顺序为 '+ '、'.join(str(attempted[t]-valid[t]) for t in TASKS)+'。</p>')
    page.append('<h2>从第一轮到本局最后一轮</h2><div class="scroll"><table><thead><tr><th>主实验指标</th><th>首轮均值</th><th>末轮均值</th><th>同局平均变化（百分点）</th><th>对局数</th></tr></thead><tbody>')
    for task, metric in [("roles","role"),("roles","side"),("percival","accuracy"),("percival","prob"),("percival","confidence")]:
        paired = []
        for first in rows:
            if first["task"] != task or first["round"] != 1 or metric not in first:
                continue
            end = next(r for r in rows if r["task"]==task and r["game"]==first["game"] and r["round"]==r["length"])
            if metric in end:
                paired.append((first[metric],end[metric]))
        start = mean([a for a,b in paired])
        end_mean = mean([b for a,b in paired])
        change = mean([b-a for a,b in paired])
        page.append(f'<tr><th>{TASKS[task]} · {METRICS[metric][0]}</th><td>{fmt(start,metric)}</td><td>{fmt(end_mean,metric)}</td><td>{fmt(change,metric,True)}</td><td>{len(paired)}</td></tr>')
    page.append('</tbody></table></div>')
    example = [r for r in rows if r["game"]=="1aKReQ"]
    counts = [str(round(r["role"]*6)) for r in example if r["task"]=="roles" and r.get("valid")]
    belief = [fmt(r["prob"],"prob") for r in example if r["task"]=="percival" and r.get("valid")]
    if len(counts)==len(belief)==5:
        page.append('<div class="call"><b>一局怎样改变判断？　1aKReQ</b><p>五轮里，旁观者认对的具体身份数依次为 '
                    +'、'.join(counts)+' 人（每轮共六人）。派西给真梅林的概率依次为 '+'、'.join(belief)
                    +'。第三轮更相信莫甘娜，直到第五轮才把超过一半的概率给了真梅林。</p></div>')
    page.append('<h2>逐轮、逐局查看</h2>')
    games = sorted({r["game"] for r in rows})
    page.append('<div class="selector"><label>实验视角<select id="task">'+''.join(f'<option value="{t}">{title}</option>' for t,title in TASKS.items())+'</select></label><label>评分指标<select id="metric"></select></label><label>逐局表筛选<select id="game"><option value="">全部 20 局</option>'+''.join(f'<option>{escape(g)}</option>' for g in games)+'</select></label></div>')
    keys = {t:(["role","side","exact"] if t=="roles" else ["prob","accuracy","confidence","brier"]) for t in TASKS}
    for task, metrics in keys.items():
        for m in metrics:
            page.append(panel(rows,task,m))
    page.append('<details><summary>开局无信息时，随机猜能有多准？</summary><p>全桌共有 6!/2! = 360 种合法身份分配。对它们等概率抽样，具体身份正确率期望为 8/36 = 22.2%，阵营正确率期望为 20/36 = 55.6%，整桌全对概率为 1/360。派西的两个拇指位开局等可能，概率基线各为 50%。这些参考值由规则计算，无需调用模型。</p></details>')
    page.append('<details open id="history-control"><summary>派西对照 · 累计发言是否比只看本轮更有帮助？</summary><p>在相同对局、相同截点比较给真梅林的概率。固定五五开基线的辨认得分和真梅林概率均为 50%，Brier 为 0.25。</p>')
    indexed = {(r["game"],r["round"],r["task"]):r for r in rows}
    paired_games = []
    pairs = 0
    for g in games:
        diffs = [r["prob"]-indexed[g,r["round"],"recent"]["prob"] for r in rows
                 if r["game"]==g and r["round"]>1 and r["task"]=="percival" and "prob" in r
                 and "prob" in indexed[g,r["round"],"recent"]]
        if diffs:
            pairs += len(diffs)
            paired_games.append(fmean(diffs))
    if pairs:
        bounds = ci(paired_games)
        interval = f'，按局重抽样的 95% 区间为 {fmt(bounds[0],"prob",True)} 至 {fmt(bounds[1],"prob",True)} 个百分点' if bounds else ""
        page.append(f'<p><b>第二轮起，共 {pairs} 个配对截点。</b>先在各局内求平均，再对 {len(paired_games)} 局等权。两种输入给真梅林的概率相差 {fmt(mean(paired_games),"prob",True)} 个百分点（累计减去仅本轮）{interval}。首轮共用回答，不参与这一比较。</p>')
        final_pairs = [(r,indexed[r["game"],r["round"],"recent"]) for r in rows
                       if r["task"]=="percival" and r["round"]==r["length"] and r.get("valid")
                       and indexed[r["game"],r["round"],"recent"].get("valid")]
        if final_pairs:
            full, recent = zip(*final_pairs)
            page.append(f'<p>看各局末轮，在这 {len(full)} 局里，累计发言的辨认准确率为 {fmt(fmean(r["accuracy"] for r in full),"accuracy")}，仅本轮为 {fmt(fmean(r["accuracy"] for r in recent),"accuracy")}。两者给真梅林的平均概率分别为 {fmt(fmean(r["prob"] for r in full),"prob")} 和 {fmt(fmean(r["prob"] for r in recent),"prob")}。</p>')
    for k in range(1,6):
        differences = [r["prob"]-indexed[r["game"],k,"recent"]["prob"] for r in rows if r["round"]==k and r["task"]=="percival" and "prob" in r and "prob" in indexed[r["game"],k,"recent"]]
        page.append(f'<p>第 {k} 轮　{fmt(mean(differences),"prob",True)} 个百分点　·　配对 {len(differences)} 局</p>')
    page.append('</details><details><summary>全桌任务 · 哪些轮次改对或改错了身份？</summary><p>统计相邻两轮均有有效预测的座位。两轮都错但改猜另一种错误身份的座位记为持续错误。</p>')
    for k in range(2,6):
        moves = Counter()
        for r in rows:
            if r["task"]!="roles" or r["round"]!=k or not r.get("valid"):
                continue
            prev = indexed[r["game"],k-1,"roles"]
            if prev.get("valid"):
                for seat, role in r["actual"].items():
                    moves[prev["predicted"][seat]==role,r["predicted"][seat]==role] += 1
        page.append(f'<p>第 {k-1} 至 {k} 轮　错变对 {moves[False,True]} 人， 对变错 {moves[True,False]} 人，持续正确 {moves[True,True]} 人，持续错误 {moves[False,False]} 人。</p>')
    page.append(f'</details><details><summary>API 回执与费用</summary><p>自 20 局末轮基线后共新增 {len(fresh)} 份响应，输入 {inputs:,} token，输出及思考 {outputs:,} token。</p><p>OpenRouter 的 {len(routed)} 份回执记录的推理费用合计 ${router_cost:.4f}，不含充值手续费。Google 直连的 {20+len(direct)} 份正式回执（含最初 20 份）按标准价折合 ${direct_equivalent:.2f}，实际扣款以 Google 账单为准。试跑及无用量回执的失败请求未计入。</p><a href="https://openrouter.ai/google/gemini-4-hydrogen">OpenRouter 模型页</a> · <a href="https://ai.google.dev/gemini-api/docs/pricing#gemini-4-hydrogen">Google 官方定价</a></details>')
    page.append('<p class="note">相邻轮的变化和首末变化均先在同一局内计算，再对局等权平均。首末区间按整局重抽样 2,000 次。每个截点只有一次回答，变化包含抽样波动。第五轮只有六局。</p></main>')
    page.append('<script>const keys='+json.dumps(keys)+';const titles='+json.dumps({k:v[0] for k,v in METRICS.items()},ensure_ascii=False)+''';
const task = document.querySelector('#task');
const metric = document.querySelector('#metric');
const game = document.querySelector('#game');
function show() {
  for (const section of document.querySelectorAll('.panel')) {
    section.hidden = section.id !== task.value + '-' + metric.value;
  }
}
function change() {
  metric.replaceChildren(...keys[task.value].map(k => new Option(titles[k], k)));
  show();
}
game.onchange = () => {
  for (const row of document.querySelectorAll('[data-game]')) {
    row.hidden = Boolean(game.value) && row.dataset.game !== game.value;
  }
};
task.onchange = change;
metric.onchange = show;
change();
</script></html>''')
    (SITE/"results.html").write_text(''.join(page),encoding="utf-8")


if __name__ == "__main__":
    render()
