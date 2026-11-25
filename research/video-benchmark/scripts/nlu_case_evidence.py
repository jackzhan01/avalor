"""Blind post-hoc citations and matched deletion checks on three selected turns."""
import argparse
import concurrent.futures
import copy
import json
import re
import time
import urllib.error
import urllib.request

from nlu_openrouter import URL, normalize, request_body
from nlu_rounds import OUT, atomic, base, jobs

CASES = [("9avmeG",3,"roles"),("7ax9by",4,"percival"),("mep2bM",4,"percival")]
ROOT = OUT.parent / "gemini-hydrogen-case-evidence-v1"


def completed_request(path, body, key):
    if path.exists():
        saved = base.read(path)
        assert saved["request"] == body
        return saved["prediction"]
    req = urllib.request.Request(URL, data=json.dumps(body).encode(), headers={
        "Authorization":"Bearer "+key,"Content-Type":"application/json","User-Agent":"Avalon-NLU-Cases/1.0"})
    for i in range(4):
        try:
            with urllib.request.urlopen(req,timeout=300) as resp:
                raw = json.load(resp)
            break
        except urllib.error.HTTPError as exc:
            if exc.code not in (429,502,503,504) or i==3:
                raise
            time.sleep(8*2**i)
    normalized = normalize(raw)["candidates"][0]
    if normalized["finishReason"]!="STOP":
        raise ValueError("Unfinished prediction")
    prediction = json.loads(normalized["content"]["parts"][0]["text"])
    atomic(path,dict(request=body,prediction=prediction,receipt=raw))
    print(path.relative_to(ROOT),flush=True)
    return prediction


def materials(all_jobs,g,k,t):
    here = next(j for j in all_jobs if (j["game"],j["round"],j["task"])==(g,k,t))
    before = next(j for j in all_jobs if (j["game"],j["round"],j["task"])==(g,k-1,t))
    log = base.read(base.DATA/"upstream/dataset"/(g+".json"))["messages"]
    lines = []
    n = 1
    for rid,m in sorted(log.items(),key=lambda kv:int(kv[0])):
        if n>k:
            break
        if t=="roles":
            line = base.public_text({rid:m})[0].rstrip("\n")
        elif m["player"]!="system":
            line = m["player"]+": "+m["msg"]
        else:
            line = None
        if line is not None:
            lines.append((int(rid),n,m["player"],line))
        if m["player"]=="system" and re.fullmatch(r"quest (succeeded|failed)!",m["msg"].strip().lower()):
            n+=1
    body = request_body(here["body"])
    text = body["messages"][1]["content"]
    chat = "\n".join(item[3] for item in lines)
    first = text.index(chat)
    assert text[first:first+len(chat)]==chat
    def with_lines(items):
        return text[:first]+"\n".join(items)+text[first+len(chat):]
    def answer(j):
        rec = base.read(j["reused"] or j["path"])["response"]
        return json.loads(rec["candidates"][0]["content"]["parts"][-1]["text"])
    return body,lines,with_lines,answer(before),answer(here)


def run(stage):
    key = re.search(r"(?im)^\s*openrouter_api_key\s*=\s*(.+)$",(base.REPO/".env.local").read_text(encoding="utf-8-sig"))[1].strip().strip("\"'")
    schedule = jobs()
    queue = []
    for g,k,t in CASES:
        folder = ROOT/g
        body,lines,with_lines,a,b = materials(schedule,g,k,t)
        new = {rid:(speaker,line) for rid,n,speaker,line in lines if n==k}
        if stage=="boundary":
            # These cuts isolate the arrival of one candidate claim or one quest outcome.
            # Full player dialogue in 7ax9by ends at 163; the following vote is system-only.
            edges = {"7ax9by":[68,69,96,97,162], "9avmeG":[77]}.get(g,[])
            for draw in range(1,4):
                for end in edges:
                    q=copy.deepcopy(body)
                    q["messages"][1]["content"]=with_lines([line for rid,n,s,line in lines if rid<=end])
                    queue.append((folder/f"through-{end}-{draw}.json",q))
            continue
        if stage=="cite":
            q=copy.deepcopy(body)
            q["messages"][0]["content"] = ("Audit two archived forecasts from consecutive quest checkpoints. These are model predictions, not verified roles. "
                "Using the observation and numbered dialogue or system events below, select one to three specific NEW record IDs most relevant to the change. "
                "Give a brief public-evidence justification and an alternative reading in English. Avoid treating a public claim as fact. No access to ground truth.")
            q["messages"][1]["content"]=with_lines([f"[ID {rid}, quest {n}] {line}" for rid,n,s,line in lines])+f"\nPrevious forecast: {a}\nCurrent forecast: {b}\nCurrent quest: {k}."
            q["response_format"]["json_schema"]["schema"]={"type":"object","additionalProperties":False,"properties":{
                "ids":{"type":"array","items":{"type":"integer","enum":list(new)},"minItems":1,"maxItems":3},
                "justification":{"type":"string"},"alternative":{"type":"string"}},"required":["ids","justification","alternative"]}
            queue.append((folder/"citation.json",q))
            continue
        ids=set(base.read(folder/"citation.json")["prediction"]["ids"])
        assert ids and ids<=new.keys()
        # Match speaker and line length where possible, then choose the closest remaining length.
        placebo=set()
        for rid in sorted(ids):
            speaker,line=new[rid]
            other=min(new.keys()-ids-placebo,key=lambda i:(new[i][0]!=speaker,abs(len(new[i][1])-len(line)),i))
            placebo.add(other)
        atomic(folder/"design.json",{"task":t,"quest":k,"previous":a,"current":b,
                "cited":{i:new[i][1] for i in sorted(ids)},"placebo":{i:new[i][1] for i in sorted(placebo)}})
        for draw in range(1,4):
            for arm,hidden in (("full",set()),("without_cited",ids),("placebo",placebo)):
                q=copy.deepcopy(body)
                q["messages"][1]["content"]=with_lines([line for rid,n,s,line in lines if rid not in hidden])
                if arm=="full":
                    assert q==body
                queue.append((folder/f"{arm}-{draw}.json",q))
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        list(pool.map(lambda item:completed_request(*item,key),queue))


def summarize():
    report = {"conditions":"Three independent draws per condition. Cited records were chosen retrospectively; comparison records match speaker and length where possible.", "cases":{}}
    calls = 0
    cost = 0
    for g,k,t in CASES:
        folder = ROOT/g
        data = base.read(folder/"design.json")
        truth = base.read(base.RELEASE/"evaluator"/g/"label.json")["roles"]
        candidates = sorted(i for i,r in truth.items() if r in ("morgana","merlin"))
        data["evidence_statement"] = base.read(folder/"citation.json")["prediction"]
        data["true_roles"] = truth
        measurements = {}
        for file in sorted(folder.glob("*.json")):
            trial = base.read(file)
            if "receipt" not in trial:
                continue
            calls += 1
            cost += trial["receipt"]["usage"]["cost"]
            if file.name=="citation.json":
                continue
            arm,number=file.stem.rsplit("-",1)
            pred=trial["prediction"]
            if t=="roles":
                measure={"correct_seats":sum(pred[s]==truth[s] for s in truth),
                         "merlin_guess":next((s for s in pred if pred[s]=="merlin"),None)}
            else:
                p=pred["first_percent"]
                measure={"true_merlin_percent":p if truth[candidates[0]]=="merlin" else 100-p}
            measurements.setdefault(arm,[]).append(measure)
        data["replicates"] = measurements
        report["cases"][g] = data
    report.update(requests=calls, cost_usd=cost)
    atomic(ROOT/"summary.json",report)
    print(json.dumps({g:v["replicates"] for g,v in report["cases"].items()}),flush=True)


if __name__=="__main__":
    cli=argparse.ArgumentParser()
    cli.add_argument("stage",choices=["cite","test","boundary","score"])
    stage = cli.parse_args().stage
    if stage=="score":
        summarize()
    else:
        run(stage)
