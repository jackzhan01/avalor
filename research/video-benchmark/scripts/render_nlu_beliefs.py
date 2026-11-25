"""Show the original belief updates and an explicitly time-filtered projection."""
import json
from pathlib import Path

BASE = Path(__file__).resolve().parents[2] / "data/avalon-nlu"
games = {}
for path in sorted((BASE / "upstream/dataset").glob("*.json")):
    data = json.loads(path.read_text(encoding="utf8"))
    games[path.stem] = {"present": "beliefs" in data, "beliefs": data.get("beliefs", {})}

page = """<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Avalon NLU · 原始 Beliefs 查看</title><style>:root{color-scheme:light dark;font:16px/1.6 system-ui,sans-serif}body{max-width:1250px;margin:auto;padding:28px}h1{font-size:28px}h2{font-size:20px}select,input,button{font:inherit;padding:7px;margin:6px}label{display:inline-block}table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}td,th{padding:9px;border-bottom:1px solid GrayText;text-align:left}pre{white-space:pre-wrap;overflow-wrap:anywhere;padding:14px;border:1px solid GrayText;max-height:500px;overflow:auto}a{color:LinkText}.scroll{overflow:auto}.split{display:grid;grid-template-columns:1fr 1fr;gap:25px}@media(max-width:850px){.split{display:block}}</style>
<h1>Avalon NLU · 原始 Beliefs 查看</h1>
<p>这些是玩家自行记录的身份判断，不是真实身份，也不属于公开聊天。数据来源为本地 upstream/dataset 原始 JSON，未修改原文件。未记录与主动选择 undecided 分开显示。</p>
<label>对局 <select id="game"></select></label><label>Quest <input id="quest" type="number" min="1" value="3"></label><label>Turn <input id="turn" type="number" min="0" value="1"></label><button id="latest">查看全部已记录判断</button>
<p id="status"></p><p><a id="source">打开该局完整原始 JSON</a> · <a href="overview.html">返回数据集审核表</a></p>
<h2>截至所选 Quest / Turn 的最新判断</h2><p>行：谁在判断；列：判断谁。保留同一对玩家的最后一条更新。Quest 是日志阶段编号，终局／刺杀阶段可能比实际任务轮数大 1；Turn 是轮内回合编号，不是聊天消息条数。</p><div class="scroll"><table id="matrix"></table></div>
<div class="split"><section><h2>截至所选时点的更新历史</h2><p>原始编号保留；同一 Quest / Turn 内若多次改口，按原始编号顺序排列。</p><div class="scroll"><table id="history"></table></div></section><section><h2>原始 beliefs 字段（全量）</h2><p>这里不随时点筛选，便于查看尚未进入当前快照的后续记录。</p><pre id="raw"></pre></section></div>
<script>
const data=__DATA__;
const el=id=>document.getElementById(id);
const names={merlin:'梅林',percival:'派西维尔',morgana:'莫甘娜',assassin:'刺客',servant:'忠臣',minion:'爪牙',undecided:'未确定（主动选择）'};
function cell(row,txt,header=false){const c=document.createElement(header?'th':'td');c.textContent=txt;row.appendChild(c)}
function row(table,values,header=false){const r=document.createElement('tr');values.forEach(v=>cell(r,v,header));table.appendChild(r)}
function records(){return Object.entries(data[el('game').value].beliefs).sort((a,b)=>Number(a[0])-Number(b[0]))}
function render(){const id=el('game').value;const q=Number(el('quest').value),t=Number(el('turn').value);const all=records();const visible=all.filter(([_,b])=>b.quest<q||(b.quest===q&&b.turn<=t));
el('status').textContent=data[id].present?`本局原始记录 ${all.length} 条；截至 Quest ${q} / Turn ${t} 可见 ${visible.length} 条。`:'本局原始文件没有 beliefs 表，不能补成“所有人都未确定”。';
el('source').href='../upstream/dataset/'+id+'.json';el('raw').textContent=JSON.stringify(data[id].present?{beliefs:data[id].beliefs}:{note:'原始 JSON 中没有 beliefs 字段'},null,2);
const matrix=el('matrix');matrix.replaceChildren();row(matrix,['判断者 / 对象',...Array.from({length:6},(_,i)=>(i+1)+'号')],true);
const state={};visible.forEach(([_,b])=>state[b.player+'|'+b.about_player]=b.belief);
for(let i=1;i<=6;i++){const cells=[i+'号'];for(let j=1;j<=6;j++){const v=state['player-'+i+'|player-'+j];cells.push(v===undefined?'未记录':(names[v]||v))}row(matrix,cells)}
const hist=el('history');hist.replaceChildren();row(hist,['记录','Quest / Turn','谁 → 谁','判断'],true);visible.forEach(([key,b])=>row(hist,[key,b.quest+' / '+b.turn,b.player+' → '+b.about_player,names[b.belief]||b.belief]));}
Object.keys(data).forEach(id=>{const o=document.createElement('option');o.value=id;o.textContent=id+' ('+Object.keys(data[id].beliefs).length+'条)';el('game').appendChild(o)});el('game').value='oeEva0';
el('latest').onclick=()=>{const all=records();if(all.length){const b=all.reduce((a,[_,v])=>v.quest>a.quest||(v.quest===a.quest&&v.turn>a.turn)?v:a,{quest:1,turn:0});el('quest').value=b.quest;el('turn').value=b.turn}render()};
['game','quest','turn'].forEach(id=>el(id).addEventListener('change',render));render();
</script></html>""".replace("__DATA__", json.dumps(games, ensure_ascii=False).replace("<", "\\u003c"))
target = BASE / "review-2026-11-19/beliefs-viewer.html"
target.write_text(page, encoding="utf8")
print(target)
