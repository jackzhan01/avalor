import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const research=fileURLToPath(new URL("../../",import.meta.url));
const read=rel=>JSON.parse(fs.readFileSync(path.join(research,rel),"utf8"));
const experiments="data/video-benchmark/experiments/";
const models=["Gemini","Qwen3-32B","Jev"];
const rows=[], usage=[], ledger=[];
function recordCost({model,game,round,task,period,file,receipt}) {
  const answer=receipt.answer || receipt.openrouter;
  const u=answer?.usage;
  const direct=receipt.response?.usageMetadata;
  assert(u || direct, "missing usage: "+file);
  const input=u?.prompt_tokens ?? u?.input_tokens ?? direct?.promptTokenCount;
  const output=u?.completion_tokens ?? u?.output_tokens ?? ((direct?.candidatesTokenCount||0)+(direct?.thoughtsTokenCount||0));
  const cost=u?.cost ?? null;
  assert(Number.isFinite(input) && Number.isFinite(output) && (!u || Number.isFinite(cost)));
  ledger.push({period,model,model_id:answer?.model || receipt.response.modelVersion,provider:answer?.provider || "Google direct",
    game,size:game.startsWith("BV")?10:6,round,task,shared_first_round:round===1 && task==="percival",
    input_tokens:input,output_tokens:output,reasoning_tokens:u?.completion_tokens_details?.reasoning_tokens ?? direct?.thoughtsTokenCount ?? null,
    cached_input_tokens:u?.prompt_tokens_details?.cached_tokens ?? direct?.cachedContentTokenCount ?? null,
    currency:"USD",billed_usd:cost,estimated_list_usd:cost===null?(input*1.5+output*7.5)/1e6:null,
    receipt_id:answer?.id || receipt.response?.responseId || null,receipt_file:file});
}
const fields=["role","side","accuracy","prob","brier","exact","confidence"];
function add(model, input) {
  for (const r of input) {
    const row={model,game:r.game,size:r.game.startsWith("BV")?10:6,round:r.round,task:r.task,valid:r.valid};
    for (const k of fields) if (Number.isFinite(r[k])) row[k]=r[k];
    if(r.valid && r.task==="roles")row.composition=Object.values(r.predicted).sort().join()===Object.values(r.actual).sort().join();
    rows.push(row);
  }
}
const oldDir="data/avalon-nlu/experiments/";
const oldRows=read(oldDir+"gemini-4-hydrogen-rounds-v1/scores.json");
add("Gemini",oldRows);
for(const r of oldRows.filter(r=>!(r.round===1 && r.task==="recent"))) {
  const file=r.task==="roles" && r.round===r.length ? oldDir+"gemini-4-hydrogen-full-v1-medium/"+r.game+"/result.json"
    : oldDir+"gemini-4-hydrogen-rounds-v1/"+r.game+"/q"+r.round+"/"+r.task+".json";
  recordCost({...r,model:"Gemini",period:"历史复用",file,receipt:read(file)});
}
for(const [index,folder] of ["ten-rounds-v1","qwen-rounds-v1","jev-rounds-v1"].entries()) {
  const dir=experiments+folder+"/";
  add(models[index],read(dir+"scores.json"));
  const plan=read(dir+"plan.json");
  const receipts=[];
  for(const j of plan) {
    const file=dir+j.game+"/q"+j.round+"/"+j.task+".json";
    if(!fs.existsSync(path.join(research,file)))continue;
    const receipt=read(file);
    receipts.push(receipt);
    recordCost({...j,model:models[index],period:"本次新增",file,receipt});
  }
  assert(receipts.every(r=>typeof r.answer.usage?.cost==="number"),"Missing billed cost");
  usage.push({model:models[index],planned:plan.length,count:receipts.length,
    cost:receipts.reduce((n,r)=>n+r.answer.usage.cost,0)});
}
function compute(rows) {
  const avg=xs=>xs.length?xs.reduce((a,b)=>a+b,0)/xs.length:null;
  const groups=Object.groupBy(rows,r=>[r.model,r.size,r.task].join("/"));
  const stats=[], rounds=[], comparisons=[], cohorts=[], history=[], overall=[], pairData=new Map();
  function interval(xs) {
    if(xs.length<2)return null;
    let seed=580;
    const draws=Array.from({length:3000},()=>{
      let sum=0;
      for(let i=0;i<xs.length;i++) {
        seed=(Math.imul(1664525,seed)+1013904223)>>>0;
        sum+=xs[Math.floor(seed/4294967296*xs.length)];
      }
      return sum/xs.length;
    }).sort((a,b)=>a-b);
    return [draws[74],draws[2924]];
  }
  for(const group of Object.values(groups)) {
    const {model,size,task}=group[0];
    const byGame=Object.groupBy(group,r=>r.game);
    for(const key of task==="roles"?["role","side","exact"]:["accuracy","prob","brier","confidence"]) {
      const gains=[], initial=[], end=[];
      for(const game of Object.values(byGame)) {
        const a=game.find(r=>r.round===1 && r.valid);
        const b=game.find(r=>r.round===3 && r.valid);
        if(a && b){initial.push(a[key]);end.push(b[key]);gains.push(b[key]-a[key]);}
      }
      stats.push({model,size,task,key,n:gains.length,first:avg(initial),third:avg(end),delta:avg(gains),ci:interval(gains)});
      const gameMeans=Object.values(byGame).map(g=>avg(g.filter(r=>r.valid).map(r=>r[key]))).filter(x=>x!==null);
      overall.push({model,size,task,key,n:gameMeans.length,score:avg(gameMeans)});
      if(task==="percival") {
        const recent=groups[[model,size,"recent"].join("/")];
        const matched=new Map(recent.filter(r=>r.valid).map(r=>[r.game+"/"+r.round,r[key]]));
        const perGame=[];
        for(const g of Object.values(byGame)) {
          const differences=g.filter(r=>r.valid && r.round>1 && matched.has(r.game+"/"+r.round)).map(r=>r[key]-matched.get(r.game+"/"+r.round));
          if(differences.length)perGame.push(avg(differences));
        }
        history.push({model,size,key,n:perGame.length,delta:avg(perGame),ci:interval(perGame)});
      }
      pairData.set([model,size,task,key].join("/"),{initial,end,gains});
      for(let round=1;round<=5;round++) {
        const offered=group.filter(r=>r.round===round);
        const valid=offered.filter(r=>r.valid);
        rounds.push({model,size,task,key,round,n:valid.length,total:offered.length,mean:avg(valid.map(r=>r[key]))});
      }
      if(model==="Gemini")continue;
      const base=groups[["Gemini",size,task].join("/")];
      const ref=new Map(base.filter(r=>r.valid).map(r=>[r.game+"/"+r.round,r[key]]));
      const perGame=[];
      for(const game of Object.values(byGame)) {
        const pairs=game.filter(r=>r.valid && ref.has(r.game+"/"+r.round));
        if(pairs.length)perGame.push(avg(pairs.map(r=>r[key]-ref.get(r.game+"/"+r.round))));
      }
      comparisons.push({model,size,task,key,n:perGame.length,delta:avg(perGame),ci:interval(perGame)});
    }
  }
  for(const a of stats.filter(r=>r.size===6 && r.n)) {
    const six=pairData.get([a.model,6,a.task,a.key].join("/"));
    const ten=pairData.get([a.model,10,a.task,a.key].join("/"));
    if(!ten?.initial.length)continue;
    let seed=81580;
    const resample=xs=>{
      let sum=0;
      for(let i=0;i<xs.length;i++){
        seed=(Math.imul(1664525,seed)+1013904223)>>>0;
        sum+=xs[Math.floor(seed/4294967296*xs.length)];
      }
      return sum/xs.length;
    };
    const draws=Array.from({length:3000},()=>resample(ten.gains)-resample(six.gains)).sort((a,b)=>a-b);
    cohorts.push({model:a.model,task:a.task,key:a.key,six:a.n,ten:ten.gains.length,
      first:avg(ten.initial)-avg(six.initial),third:avg(ten.end)-avg(six.end),
      gain:avg(ten.gains)-avg(six.gains),ci:[draws[74],draws[2924]]});
  }
  return {stats,rounds,comparisons,cohorts,history,overall};
}
const summary=compute(rows);
const overview=read("data/video-benchmark/releases/yuanzhuo22-preprocess-v1/manifest.json");
const variants=overview.games.filter(g=>g.roles.swordholder).map(g=>g.bvid);
const sixLabels=read("data/avalon-nlu/experiments/gemini-4-hydrogen-rounds-v1/scores.json").filter(r=>r.task==="roles" && r.round===1).map(r=>r.actual);
const tenLabels=overview.pairs.filter(p=>p.kind==="full").map(p=>Object.fromEntries(Object.entries(read("data/video-benchmark/releases/yuanzhuo22-preprocess-v1/"+p.label_path).seats).map(([seat,v])=>[seat,v.role])));
const firstMerlin=labels=>labels.filter(roles=>Object.keys(roles).sort((a,b)=>Number(a)-Number(b)).find(s=>["merlin","morgana"].includes(roles[s]))===Object.keys(roles).find(s=>roles[s]==="merlin")).length;
const titles={roles:"全桌身份",percival:"派西 · 累计发言",recent:"派西 · 仅本轮发言",role:"具体身份准确率",side:"阵营准确率",accuracy:"认出梅林的准确率",prob:"给真梅林的概率",confidence:"对所选座位的信心",brier:"Brier 分数",exact:"全桌全对率"};
function render({rows,summary,usage,variants,titles,ledger}) {
  const $=id=>document.getElementById(id);
  const fmt=(v,k,delta=false)=>v==null?"—":(delta && v>0?"+":"")+(k==="brier"?v.toFixed(3): (100*v).toFixed(1)+(delta?"":"%"));
  const int=(ci,k)=>ci?ci.map(v=>fmt(v,k,true)).join(" 至 "):"—";
  function table(target, headers, data) {
    const el=$(target);
    el.replaceChildren();
    const hr=el.createTHead().insertRow();
    headers.forEach(h=>{const c=document.createElement("th");c.scope="col";c.textContent=h;hr.append(c);});
    const body=el.createTBody();
    data.forEach(line=>{const tr=body.insertRow();line.forEach(x=>{tr.insertCell().textContent=x;});});
  }
  function options(el,items) {el.replaceChildren(...items.map(([id,t])=>new Option(t,id)));}
  const task=$("task"), metric=$("metric"), model=$("model"), size=$("size");
  const allModels=["Gemini","Qwen3-32B","Jev"];
  const charts=(points,key)=>{
    const svg=$("chart");
    const parts=[];
    const y=v=>135-v*104;
    for(const line of [0,.5,1]){
      parts.push('<path d="M50 '+y(line)+'h520" class="grid"/><text x="42" y="'+(y(line)+4)+'" text-anchor="end">'+(key==="brier"?line:line*100+"%")+'</text>');
    }
    for(let r=1;r<=5;r++)parts.push('<text x="'+(75+(r-1)*118)+'" y="160" text-anchor="middle">第 '+r+' 轮</text>');
    for(const [i,m] of allModels.entries()){
      const series=points.filter(p=>p.model===m && p.n).sort((a,b)=>a.round-b.round);
      if(!series.length)continue;
      const xy=series.map(p=>[75+(p.round-1)*118,y(p.mean)]);
      parts.push('<g class="s'+i+'"><polyline points="'+xy.map(p=>p.join(",")).join(" ")+'"/>');
      xy.forEach(([x,v],j)=>parts.push('<circle cx="'+x+'" cy="'+v+'" r="4"><title>'+m+' · 第 '+series[j].round+' 轮 · '+fmt(series[j].mean,key)+' · '+series[j].n+' 局</title></circle>'));
      parts.push('</g>');
    }
    svg.innerHTML=parts.join("");
  };
  function update() {
    const t=task.value,k=metric.value,s=Number(size.value),m=model.value;
    const validModel=allModels.filter(v=>t!=="roles" || v!=="Jev");
    const inScope=r=>r.task===t && r.key===k;
    const match=summary.rounds.filter(r=>inScope(r) && r.size===s);
    table("overall",["模型","六人局","十人局"],validModel.map(v=>[v,...[6,10].map(z=>fmt(summary.overall.find(r=>inScope(r) && r.model===v && r.size===z)?.score,k))]));
    $("roundtitle").textContent=s+"人局各轮的"+titles[k];
    $("legend").textContent=validModel.join("　/　")+"（依次为实线、虚线、点线）";
    charts(match,k);
    table("rounds",["任务结算轮次",...validModel.map(v=>v+" · 有效局数")],Array.from({length:5},(_,i)=>[
      "第 "+(i+1)+" 轮",...validModel.map(v=>{const r=match.find(r=>r.round===i+1 && r.model===v);return r?.total?fmt(r.mean,k)+" · "+r.n+"/"+r.total:"—";})]));
    const pair=summary.stats.filter(inScope).sort((a,b)=>a.size-b.size);
    function rosterMean(v,special) {
      const subset=rows.filter(r=>r.model===v && r.task===t && r.size===10 && r.valid && variants.includes(r.game)===special);
      const g=Object.values(Object.groupBy(subset,r=>r.game));
      const mean=xs=>xs.reduce((a,b)=>a+b,0)/xs.length;
      return g.length?fmt(mean(g.map(game=>mean(game.map(r=>r[k])))),k)+" · "+g.length+" 局":"—";
    }
    table("rosters",["模型","常规十人板","执剑人／破壁人板"],validModel.map(v=>[v,rosterMean(v,false),rosterMean(v,true)]));
    table("paired",["数据","模型","配对局数","第一轮","第三轮","同局变化","变化的 95% 区间"],pair.map(r=>[r.size+" 人",r.model,r.n,fmt(r.first,k),fmt(r.third,k),fmt(r.delta,k,true),int(r.ci,k)]));
    table("cohorts",["模型","六人／十人局数","首轮差","第三轮差","提升幅度的差","提升差的 95% 区间"],summary.cohorts.filter(inScope).map(r=>[r.model,r.six+" / "+r.ten,fmt(r.first,k,true),fmt(r.third,k,true),fmt(r.gain,k,true),int(r.ci,k)]));
    table("rivals",["数据","模型 − Gemini","配对局数","平均差值","95% 区间"],summary.comparisons.filter(inScope).sort((a,b)=>a.size-b.size).map(r=>[r.size+" 人",r.model+" − Gemini",r.n,fmt(r.delta,k,true),int(r.ci,k)]));
    $("historyPanel").hidden=t==="roles";
    if(t!=="roles")table("history",["数据","模型","配对局数","累计 − 仅本轮","95% 区间"],summary.history.filter(r=>r.key===k).sort((a,b)=>a.size-b.size).map(r=>[r.size+" 人",r.model,r.n,fmt(r.delta,k,true),int(r.ci,k)]));
    const byGame={};
    for(const r of rows.filter(r=>r.size===s && r.task===t && r.model===m)) (byGame[r.game]??=[]).push(r);
    table("games",["对局",...Array.from({length:5},(_,i)=>"第 "+(i+1)+" 轮"),"末轮 − 首轮"],Object.entries(byGame).sort(([a],[b])=>a.localeCompare(b)).map(([game,g])=>{
      g.sort((a,b)=>a.round-b.round);
      const scores=Array.from({length:5},(_,i)=>g.find(r=>r.round===i+1 && r.valid)?.[k]);
      return [game+(variants.includes(game)?" *":""),...scores.map(v=>fmt(v,k)),fmt(g[0].valid && g.at(-1).valid && g.length>1?g.at(-1)[k]-g[0][k]:null,k,true)];
    }));
    $("unit").textContent=k==="brier"?"Brier 分数越低越好。差值以分数表示。":"差值以百分点表示。";
  }
  function taskChange() {
    const t=task.value, prev=model.value;
    options(metric,(t==="roles"?["role","side","exact"]:["accuracy","prob","brier","confidence"]).map(k=>[k,titles[k]]));
    options(model,allModels.filter(v=>t!=="roles" || v!=="Jev").map(v=>[v,v]));
    if([...model.options].some(o=>o.value===prev))model.value=prev;
    update();
  }
  options(task,["percival","roles","recent"].map(k=>[k,titles[k]]));
  task.onchange=taskChange;metric.onchange=size.onchange=model.onchange=update;taskChange();
  table("billing",["本次新增推理","已保存／计划请求","回执费用（美元）"],usage.map(u=>[u.model,u.count+" / "+u.planned,"$"+u.cost.toFixed(5)]));
  const groupCosts=Object.groupBy(ledger,r=>[r.period,r.model,r.size,titles[r.task]].join(" / "));
  const dollars=xs=>xs.length?"$"+xs.reduce((a,b)=>a+b,0).toFixed(6):"—";
  table("costGroups",["批次／模型／人数／任务","请求","输入 token","输出 token","有金额回执（美元）","无金额回执按标价估算（美元）"],Object.entries(groupCosts).map(([label,g])=>[label,g.length,g.reduce((a,r)=>a+r.input_tokens,0).toLocaleString(),g.reduce((a,r)=>a+r.output_tokens,0).toLocaleString(),dollars(g.map(r=>r.billed_usd).filter(x=>x!==null)),dollars(g.map(r=>r.estimated_list_usd).filter(x=>x!==null))]));
  const costGame=$("costGame");
  options(costGame,[...new Set(ledger.map(r=>r.game))].sort().map(g=>[g,g]));
  function showCosts() {
    const g=ledger.filter(r=>r.game===costGame.value).sort((a,b)=>a.round-b.round || a.model.localeCompare(b.model) || a.task.localeCompare(b.task));
    table("costRows",["轮","模型","任务","输入／输出 token","回执费用（美元）","仅标价估算（美元）"],g.map(r=>[r.round,r.model,titles[r.task]+(r.shared_first_round?"（共用）":""),r.input_tokens+" / "+r.output_tokens,r.billed_usd===null?"—":"$"+r.billed_usd.toFixed(8),r.estimated_list_usd===null?"—":"$"+r.estimated_list_usd.toFixed(6)]));
  }
  costGame.onchange=showCosts;showCosts();
  const download=$("downloadCosts");
  download.href=URL.createObjectURL(new Blob([JSON.stringify(ledger,null,2)],{type:"application/json"}));
  const roleGroups=Object.groupBy(rows.filter(r=>r.task==="roles"),r=>r.model+" · "+r.size+" 人");
  table("formats",["全桌身份任务","格式有效／快照","角色张数正确／格式有效"],Object.entries(roleGroups).map(([label,g])=>[label,g.filter(r=>r.valid).length+" / "+g.length,g.filter(r=>r.composition).length+" / "+g.filter(r=>r.valid).length]));
}
assert.equal(new Set(ledger.map(r=>r.receipt_file)).size,ledger.length);
const publicLedger=ledger.map(({receipt_id,receipt_file,...metrics})=>metrics);
const payload={rows,summary,usage,variants,titles,ledger:publicLedger};
const css=`:root{color-scheme:light dark;--paper:#faf9f5;--ink:#1e302b;--muted:#4f615b;--line:#ccd4cd;--accent:#136c54;--two:#a05c1e;--three:#565899}
@media(prefers-color-scheme:dark){:root{--paper:#15211d;--ink:#e4ece6;--muted:#b0c3b8;--line:#405449;--accent:#83d4af;--two:#e1af77;--three:#b8b7ed}}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.65 Inter,"Microsoft YaHei",sans-serif}main{max-width:1040px;margin:auto;padding:32px clamp(16px,4vw,52px) 60px}header{border-bottom:1px solid var(--line);padding-bottom:15px}h1{font:600 clamp(28px,4vw,46px)/1.3 Georgia,"Microsoft YaHei",serif;margin:14px 0}h2{font-size:23px;margin:28px 0 4px}p{margin:6px 0 12px}label{display:inline-grid;gap:3px;margin:10px 16px 6px 0;font-size:.9rem;color:var(--muted)}select{font:inherit;color:var(--ink);background:var(--paper);min-height:44px;padding:4px 10px;border:1px solid var(--line);border-radius:4px}.scroll{overflow:auto}table{border-collapse:collapse;width:100%;margin:8px 0 16px;font-variant-numeric:tabular-nums}th,td{white-space:nowrap;text-align:left;padding:7px 12px 7px 0;border-bottom:1px solid var(--line)}th{color:var(--muted);font-size:.9rem}a{color:var(--accent)}small,.note{color:var(--muted)}svg{width:100%;max-width:780px;display:block}svg text{font-size:12px;fill:var(--ink)}svg .grid{stroke:var(--line)}svg polyline{fill:none;stroke:currentColor;stroke-width:2.5}svg circle{fill:currentColor}.s0{color:var(--accent)}.s1{color:var(--two);stroke-dasharray:9 4}.s2{color:var(--three);stroke-dasharray:2 4}details{margin:18px 0}summary{cursor:pointer}footer{margin-top:28px}`;
const status=usage.map(u=>u.model+" "+u.count+"/"+u.planned).join("　·　");
const geminiFinished=usage[0].count===usage[0].planned && rows.filter(r=>r.model==="Gemini").every(r=>r.valid);
const pairedRole=size=>summary.stats.find(r=>r.model==="Gemini" && r.size===size && r.task==="roles" && r.key==="role");
const belief=size=>summary.overall.find(r=>r.model==="Gemini" && r.size===size && r.task==="percival" && r.key==="accuracy");
const pct=v=>(v*100).toFixed(1);
const lead=geminiFinished?`<p><strong>Gemini 在两份数据上的派西二选一总体表现接近。</strong>按局等权，六人局准确率为 ${pct(belief(6).score)}%，十人局为 ${pct(belief(10).score)}%。从第一轮到第三轮，旁观者对具体身份的识别在六人局提高 ${pct(pairedRole(6).delta)} 个百分点，在十人局提高 ${pct(pairedRole(10).delta)} 个百分点。六人局有 ${pairedRole(6).n} 局可配对，十人局有 ${pairedRole(10).n} 局。</p>`:"";
const html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>阿瓦隆 · 跨人数与模型对比</title><style>${css}</style>
<main><header><a href="index.html">实验设计</a>　<a href="results.html">六人局原始报告</a><h1>多听两轮，谁更能认出梅林？</h1><p>20 局英文线上六人局，22 局中文录像十人局。每个模型在同一轮末独立判断一次。切换任务可看旁观者认全桌，以及派西维尔只听本轮的对照。</p><small>本次新增回执　${status}</small></header>
${lead}<label>任务<select id="task"></select></label><label>指标<select id="metric"></select></label><label>逐轮曲线与单局明细<select id="size"><option value="10">十人局</option><option value="6">六人局</option></select></label>
<h2>每局等权的总体表现</h2><p>先在每局内平均所有有结果的轮末，再平均各局，避免轮数较多的对局占更大权重。</p><div class="scroll"><table id="overall"></table></div>
<h2 id="roundtitle"></h2><p id="legend"></p><svg id="chart" role="img" aria-label="按任务结算轮次展示模型平均得分，横轴为轮次，纵轴为所选指标；完整数值见下表" viewBox="0 0 590 176"></svg><div class="scroll"><table id="rounds"></table></div>
<h2>第一轮到第三轮，同一批局涨了多少？</h2><p>每局先算第三轮减第一轮，再按局取平均。区间为 3,000 次按局重抽样的百分位区间。<span id="unit"></span></p><div class="scroll"><table id="paired"></table></div>
<h2>同一模型，十人局与六人局相差多少？</h2><p>十人局减六人局，只看同时记录到第一轮和第三轮的对局。两个数据集各自按局重抽样，估计两组提升幅度之差的区间。</p><div class="scroll"><table id="cohorts"></table></div>
<details><summary>对照两种十人板子的结果</summary><p>先按轮、再按局平均。特殊板子只有两局，可回到逐局表复核。</p><div class="scroll"><table id="rosters"></table></div></details>
<h2>在相同的轮末，谁比 Gemini 判断得准？</h2><p>同一局同一轮做差，先在局内按轮平均，再按局平均。两种人数分别计算。二选一打平记半分，随机猜的期望准确率为 50%，始终报 50% 的 Brier 分数为 0.25。</p><div class="scroll"><table id="rivals"></table></div>
<p class="note">所有模型都先看到座号较小的候选人。只猜第一个候选人，六人局猜对 ${firstMerlin(sixLabels)}/${sixLabels.length} 局，十人局猜对 ${firstMerlin(tenLabels)}/${tenLabels.length} 局。本实验未交换过候选顺序。</p>
<section id="historyPanel"><h2>能读到之前几轮，有多少额外收益？</h2><p>从第二轮起，对同一轮的两份回答相减：累计发言减仅本轮发言。先在局内平均，再按局平均。</p><div class="scroll"><table id="history"></table></div></section>
<h2>每一局的判断轨迹</h2><label>查看模型<select id="model"></select></label><div class="scroll"><table id="games"></table></div><p class="note">* 表示含执剑人、破壁人的十人局。空缺表示没有可评分的轮末。末轮指这局最后一个有任务结果的录像或聊天截点。</p>
<details open><summary>视野、计分与解释边界</summary><p>全桌身份任务读取玩家发言与公开行动，派西任务只读发言，额外知道自己的座位和两个无序拇指位。模型独立读取前缀，累计发言和仅本轮发言在第一轮共用预测。按座位判角色和阵营，忠臣等价。十人录像仅保留可用当时信息，四个缺失的轮末从整局输入截至任务结果和当时的失败牌数。</p><p>身份随机基线按当局板子的角色比例平方求和：六人局 22.2%，常规十人局 22%，含执剑人和破壁人的十人局 16%。两种人数的语料还同时改变了语言、板子、交流方式和记录完整度。十人局第四、五轮只适合看个案。每个模型在每个不同输入上取一次回答。</p></details>
<details><summary>全桌身份输出的合法性</summary><p>只要每个座位都返回一个可用的角色名就逐座位计分。角色张数不符的回答也保留，可在此查看次数。</p><div class="scroll"><table id="formats"></table></div></details>
<h2 id="cost">每次实验花了多少钱？</h2><p>按去重后的推理回执汇总。第一轮共用的两份派西判断只计费一次，记入累计发言。本次新增的金额与历史回执分列。千问曾返回不完整响应；缺少金额回执的尝试无法核价。金额单位为美元，不含充值手续费。<a id="downloadCosts" download="avalon-request-costs.json">下载逐请求费用账本（JSON）</a></p><div class="scroll"><table id="billing"></table></div>
<details><summary>按模型、人数和任务核对费用</summary><div class="scroll"><table id="costGroups"></table></div><p>历史 Google 直连回执只有用量，按每百万输入 $1.50、输出 $7.50 单列估算；实际扣款由 Google 账单决定。所有 OpenRouter 金额都取自 usage.cost。输出 token 包含服务商计入的思考 token。</p></details>
<details><summary>查看某一局每轮的请求费用</summary><label>对局<select id="costGame"></select></label><div class="scroll"><table id="costRows"></table></div></details>
<footer><a href="https://openrouter.ai/google/gemini-4-hydrogen">Gemini 4 Hydrogen</a>　<a href="https://openrouter.ai/qwen/qwen3-32b">Qwen3-32B</a>　<a href="https://openrouter.ai/docs/guides/community/jev">Jev 1.14</a></footer></main>
<script>(${render.toString()})(${JSON.stringify(payload).replaceAll("<","\\u003c")})</script></html>`;
fs.writeFileSync(path.join(research,"avalon-task-exhibit/dist/comparison.html"),html);
fs.writeFileSync(path.join(research,experiments,"round-comparison.json"),JSON.stringify({usage,...summary},null,2)+"\n");
fs.writeFileSync(path.join(research,experiments,"request-costs.json"),JSON.stringify(ledger,null,2)+"\n");
console.log(status, "有效评分", rows.filter(r=>r.valid).length, "/", rows.length);
