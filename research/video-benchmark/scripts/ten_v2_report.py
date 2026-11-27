"""Summarize the ten-player v2 rerun (Gemini, Qwen, Jev) into one JSON for the results page.

Reads the per-request scores that ten_rounds_v2.mjs writes, the v1 scores for the paired
v1 -> v2 comparison, and nothing else. Unit is the game: average inside a game first, then
weight games equally; intervals are 3000 game-level bootstrap resamples, paired contrasts
also get a sign-flip permutation p-value.
"""
import json
import math
import random
from collections import defaultdict
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
EXP = REPO / "research/data/video-benchmark/experiments"
OUT = EXP / "ten-v2-summary.json"
ARMS = {"Gemini": "ten-rounds", "Qwen3-32B": "qwen-rounds", "Jev": "jev-rounds"}
EVIL = {"morgana", "assassin", "oberon", "mordred"}
SEED = 20261126
CHANCE = {"role": 0.22, "side": 0.52, "within": None, "merlin": 0.1, "accuracy": 0.5, "prob": 0.5, "brier": 0.25,
          "logloss": math.log(2)}


def read(path):
    return json.loads(Path(path).read_text(encoding="utf8"))


def rng():
    return random.Random(SEED)


def by_game(rows, key):
    cells = defaultdict(list)
    for r in rows:
        if r.get(key) is not None:
            cells[r["game"]].append(r[key])
    return {g: sum(v) / len(v) for g, v in cells.items()}


def ci(values, r):
    n = len(values)
    boots = sorted(sum(values[r.randrange(n)] for _ in range(n)) / n for _ in range(3000))
    return [boots[74], boots[2924]]


def level(rows, key, r):
    gm = list(by_game(rows, key).values())
    if not gm:
        return None
    return {"mean": sum(gm) / len(gm), "ci95": ci(gm, r), "games": len(gm), "chance": CHANCE.get(key)}


def paired(a_rows, b_rows, key, r):
    a, b = by_game(a_rows, key), by_game(b_rows, key)
    common = sorted(set(a) & set(b))
    if not common:
        return None
    d = [a[g] - b[g] for g in common]
    mean = sum(d) / len(d)
    flips = sum(abs(sum(x if r.random() < .5 else -x for x in d)) >= abs(sum(d)) - 1e-12 for _ in range(20000))
    return {"delta": mean, "ci95": ci(d, r), "games": len(common), "sign_flip_p": flips / 20000}


def enrich_roles(rows):
    for x in rows:
        if x.get("valid") and x.get("predicted"):
            a, p = x["actual"], x["predicted"]
            side = [(p[s] in EVIL) == (a[s] in EVIL) for s in a]
            role = [p[s] == a[s] for s in a]
            x["within"] = sum(rr for rr, ss in zip(role, side) if ss) / max(1, sum(side))
            picks = [s for s in p if p[s] == "merlin"]
            x["merlin"] = float(len(picks) == 1 and a[picks[0]] == "merlin")
            x["seat1"] = float(p["1"] == a["1"])
    return rows


def enrich_beliefs(rows, truth):
    for x in rows:
        if x.get("valid") and x.get("prob") is not None:
            p = min(max(x["prob"], 0.01), 0.99)
            x["logloss"] = -math.log(p)
            if "merlin_first" not in x:  # v1 rows: candidates were listed in seat order
                cands = sorted((s for s, role in truth[x["game"]].items() if role in ("merlin", "morgana")), key=int)
                x["merlin_first"] = truth[x["game"]][cands[0]] == "merlin"
                x["p_first"] = x["prob"] if x["merlin_first"] else 1 - x["prob"]
            x["picks_first"] = 0.5 if x["p_first"] == 0.5 else float(x["p_first"] > 0.5)
    return rows


def balanced(rows):
    halves = [list(by_game([x for x in rows if x.get("merlin_first") is flag], "accuracy").values()) for flag in (True, False)]
    return sum(sum(h) / len(h) for h in halves) / 2 if all(halves) else None


def load(prefix, version, truth):
    path = EXP / f"{prefix}-{version}" / "scores.json"
    if not path.exists():
        return None
    rows = [x for x in read(path) if x["game"] in truth]
    return {"roles": enrich_roles([x for x in rows if x["task"] == "roles" and x.get("valid")]),
            "percival": enrich_beliefs([x for x in rows if x["task"] == "percival" and x.get("valid")], truth),
            "percival_desc": enrich_beliefs([x for x in rows if x["task"] == "percival_desc" and x.get("valid")], truth),
            "rows": rows}


def main():
    manifest = read(REPO / "research/data/video-benchmark/releases/yuanzhuo22-preprocess-v2/manifest.json")
    release = REPO / "research/data/video-benchmark/releases/yuanzhuo22-preprocess-v2"
    truth = {}
    for pair in manifest["pairs"]:
        if pair["kind"] == "full":
            truth[pair["bvid"]] = {s: v["role"] for s, v in read(release / pair["label_path"])["seats"].items()}
    report = {"games": len(truth), "models": {}, "order_control": None, "v1_vs_v2": {}, "trend": {}, "cost": {}}
    v2 = {m: load(prefix, "v2", truth) for m, prefix in ARMS.items()}
    v1 = {m: load(prefix, "v1", truth) for m, prefix in ARMS.items()}
    for model, data in v2.items():
        if data is None:
            continue
        r = rng()
        cell = {"planned": len(data["rows"]), "valid": sum(bool(x.get("valid")) for x in data["rows"]),
                "cost_usd": sum(x.get("cost") or 0 for x in data["rows"])}
        if data["roles"]:
            cell["roles"] = {k: level(data["roles"], k, r) for k in ("role", "side", "within", "merlin", "exact", "seat1")}
            cell["roles"]["composition_valid_rate"] = sum(x["composition_valid"] for x in data["roles"]) / len(data["roles"])
        bel = data["percival"]
        cell["percival"] = {k: level(bel, k, r) for k in ("accuracy", "prob", "brier", "logloss", "confidence", "picks_first")}
        cell["percival"]["balanced_accuracy"] = balanced(bel)
        cell["percival"]["ties"] = sum(x["prob"] == 0.5 for x in bel)
        cell["percival"]["checkpoints"] = len(bel)
        report["models"][model] = cell
        report["cost"][model] = cell["cost_usd"]
        # Round 1 -> 3 on games that reach round 3, paired inside each game.
        trend = {}
        for task, rows, keys in (("roles", data["roles"], ("role", "side")), ("percival", bel, ("accuracy", "prob"))):
            for key in keys:
                first = {x["game"]: x[key] for x in rows if x["round"] == 1 and x.get(key) is not None}
                third = {x["game"]: x[key] for x in rows if x["round"] == 3 and x.get(key) is not None}
                common = sorted(set(first) & set(third))
                if common:
                    d = [third[g] - first[g] for g in common]
                    trend[f"{task}|{key}"] = {"round1": sum(first[g] for g in common) / len(common),
                                              "round3": sum(third[g] for g in common) / len(common),
                                              "delta": sum(d) / len(d), "ci95": ci(d, r), "games": len(common)}
        report["trend"][model] = trend
        by_round = defaultdict(dict)
        for task, rows, key in (("roles", data["roles"], "role"), ("roles", data["roles"], "side"), ("percival", bel, "accuracy")):
            for rd in range(1, 6):
                gm = by_game([x for x in rows if x["round"] == rd], key)
                if gm:
                    by_round[f"{task}|{key}"][rd] = {"mean": sum(gm.values()) / len(gm), "games": len(gm)}
        report["trend"][model + "|by_round"] = by_round
        if v1.get(model):
            r = rng()
            comp = {}
            for task, keys in (("roles", ("role", "side", "seat1")), ("percival", ("accuracy", "prob", "brier", "logloss"))):
                if data[task] and v1[model][task]:
                    for key in keys:
                        comp[f"{task}|{key}"] = paired(data[task], v1[model][task], key, r) | {
                            "v1": level(v1[model][task], key, r)["mean"], "v2": level(data[task], key, r)["mean"]}
            report["v1_vs_v2"][model] = comp
    g = v2.get("Gemini")
    if g and g["percival_desc"]:
        r = rng()
        asc = {(x["game"], x["round"]): x for x in g["percival"]}
        desc = {(x["game"], x["round"]): x for x in g["percival_desc"]}
        both = sorted(set(asc) & set(desc))
        rows, consistent, decisive = [], 0, 0
        for k in both:
            a, d = asc[k], desc[k]
            avg = (a["prob"] + d["prob"]) / 2
            rows.append({"game": k[0], "round": k[1], "bias": (a["p_first"] + d["p_first"]) / 2 - 0.5,
                         "abs_gap": abs(a["prob"] - d["prob"]), "avg_prob": avg,
                         "avg_accuracy": 0.5 if avg == 0.5 else float(avg > 0.5), "avg_brier": (1 - avg) ** 2,
                         "avg_logloss": -math.log(min(max(avg, 0.01), 0.99))})
            if a["prob"] != 0.5 and d["prob"] != 0.5:
                decisive += 1
                consistent += (a["prob"] > 0.5) == (d["prob"] > 0.5)
        report["order_control"] = {
            "checkpoints": len(both),
            "first_slot_bias": level(rows, "bias", r) | {"chance": 0.0},
            "mean_abs_prob_gap": level(rows, "abs_gap", r) | {"chance": None},
            "same_pick_both_orders": {"consistent": consistent, "decisive_pairs": decisive},
            "asc": {k: level(g["percival"], k, r) for k in ("accuracy", "prob", "brier", "logloss", "picks_first")},
            "desc": {k: level(g["percival_desc"], k, r) for k in ("accuracy", "prob", "brier", "logloss", "picks_first")},
            "asc_balanced_accuracy": balanced(g["percival"]), "desc_balanced_accuracy": balanced(g["percival_desc"]),
            "order_averaged": {k: level(rows, k, r) for k in ("avg_accuracy", "avg_prob", "avg_brier", "avg_logloss")},
            "asc_minus_desc_accuracy": paired(g["percival"], g["percival_desc"], "accuracy", r),
            "merlin_listed_first_share": sum(x["merlin_first"] for x in g["percival"]) / len(g["percival"]),
        }
        # Round 1 -> 3 per listing and order-averaged: a trend seen in one listing only may be the slot preference.
        acc = lambda p: 0.5 if p == 0.5 else float(p > 0.5)
        views = {"asc": lambda k: asc[k]["prob"], "desc": lambda k: desc[k]["prob"],
                 "averaged": lambda k: (asc[k]["prob"] + desc[k]["prob"]) / 2}
        games3 = sorted({k[0] for k in both if k[1] == 3 and (k[0], 1) in asc})
        order_trend, by_round = {}, {}
        for name, prob in views.items():
            for key, f in (("accuracy", lambda k: acc(prob(k))), ("prob", prob)):
                d = [f((gm, 3)) - f((gm, 1)) for gm in games3]
                order_trend[f"{name}|{key}"] = {"round1": sum(f((gm, 1)) for gm in games3) / len(games3),
                                                "round3": sum(f((gm, 3)) for gm in games3) / len(games3),
                                                "delta": sum(d) / len(d), "ci95": ci(d, r), "games": len(games3)}
                by_round[f"{name}|{key}"] = {rd: {"mean": sum(f(k) for k in both if k[1] == rd) / sum(1 for k in both if k[1] == rd),
                                                  "games": sum(1 for k in both if k[1] == rd)} for rd in range(1, 6)}
        report["order_control"]["trend"] = order_trend
        report["order_control"]["by_round"] = by_round
    for model in ("Qwen3-32B", "Jev"):
        if v2.get(model) and g:
            r = rng()
            report.setdefault("vs_gemini", {})[model] = {
                f"percival|{k}": paired(v2[model]["percival"], g["percival"], k, r) for k in ("accuracy", "brier", "logloss")}
            if v2[model]["roles"]:
                report["vs_gemini"][model]["roles|role"] = paired(v2[model]["roles"], g["roles"], "role", r)
    OUT.write_text(json.dumps(report, ensure_ascii=False, indent=1) + "\n", encoding="utf8")
    print(json.dumps({m: {"valid": c["valid"], "planned": c["planned"], "cost": round(c["cost_usd"], 4)}
                      for m, c in report["models"].items()}, ensure_ascii=False))


if __name__ == "__main__":
    main()
