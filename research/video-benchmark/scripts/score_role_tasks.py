"""Score predictions for tasks.jsonl against evaluator/labels.jsonl, with the game as the unit.

  python score_role_tasks.py --data ../../data/role-tasks-v1 --pred preds/base.jsonl --pred preds/lora.jsonl \
      --compare preds/lora.jsonl preds/base.jsonl

Metrics follow the API runs, plus the two the peer review asked for:
  roles  : role / side / exact accuracy, within-side accuracy, Merlin pick, composition legality
  belief : P(true Merlin), accuracy (a 50 counts 0.5), Brier, log loss (p clipped to [0.01, 0.99]),
           position-balanced accuracy, and an order-averaged probability when asc and desc both exist.
Rows are averaged inside a game first (rounds and samples), then games are weighted equally.
Intervals: 3000 game-level bootstrap resamples. Invalid outputs are counted, not silently dropped.
"""
import argparse
import json
import math
import random
import re
from collections import defaultdict
from pathlib import Path

EVIL = {"morgana", "assassin", "oberon", "mordred", "wallbreaker"}
SEED = 20261125


def load_jsonl(path):
    with Path(path).open(encoding="utf8") as f:
        return [json.loads(line) for line in f if line.strip()]


def parse(text):
    """Last top-level JSON object in the text, after dropping <think> blocks."""
    text = re.sub(r"<think>.*?</think>", "", text or "", flags=re.S).strip()
    try:
        value = json.loads(text)
        return value if isinstance(value, dict) else None
    except ValueError:
        pass
    depth, start, last = 0, None, None
    for i, ch in enumerate(text):
        if ch == "{":
            depth, start = depth + 1, i if depth == 0 else start
        elif ch == "}" and depth:
            depth -= 1
            if depth == 0:
                last = text[start:i + 1]
    try:
        value = json.loads(last) if last else None
    except ValueError:
        return None
    return value if isinstance(value, dict) else None


def score_row(task, label, value):
    base = {"task_id": task["task_id"], "dataset": task["dataset"], "task": task["task"], "variant": task["variant"],
            "game": task["game"], "round": task["round"], "valid": False}
    if value is None:
        return base
    if task["task"] == "roles":
        seats = list(label["roles"])
        allowed = set(task["json_schema"]["properties"][seats[0]]["enum"])
        if set(value) != set(seats) or any(value[s] not in allowed for s in seats):
            return base
        actual = label["roles"]
        role = [value[s] == actual[s] for s in seats]
        side = [(value[s] in EVIL) == (actual[s] in EVIL) for s in seats]
        merlin = [s for s in seats if value[s] == "merlin"]
        return base | {"valid": True, "role": sum(role) / len(seats), "side": sum(side) / len(seats),
                       "exact": float(all(role)), "within": sum(r for r, s in zip(role, side) if s) / max(1, sum(side)),
                       "merlin": float(len(merlin) == 1 and actual[merlin[0]] == "merlin"),
                       "composition_valid": float(sorted(value.values()) == sorted(actual.values()))}
    first = value.get("first_percent")
    if not isinstance(first, int) or isinstance(first, bool) or not 0 <= first <= 100:
        return base
    p_first = first / 100
    prob = p_first if label["first_listed_is_merlin"] else 1 - p_first
    clipped = min(max(prob, 0.01), 0.99)
    return base | {"valid": True, "p_first": p_first, "merlin_first": label["first_listed_is_merlin"], "prob": prob,
                   "accuracy": 0.5 if prob == 0.5 else float(prob > 0.5), "brier": (1 - prob) ** 2,
                   "logloss": -math.log(clipped)}


def game_mean(rows, key):
    per_game = defaultdict(list)
    for r in rows:
        if r.get("valid") and key in r:
            per_game[r["game"]].append(r[key])
    return {g: sum(v) / len(v) for g, v in per_game.items()}


def interval(values, rng):
    if not values:
        return None
    n = len(values)
    boots = sorted(sum(values[rng.randrange(n)] for _ in range(n)) / n for _ in range(3000))
    return [boots[74], boots[2924]]


def summarize(rows, rng):
    groups = defaultdict(list)
    for r in rows:
        groups[(r["dataset"], r["task"], r["variant"])].append(r)
    out = {}
    for (dataset, task, variant), group in sorted(groups.items()):
        cell = {"rows": len(group), "valid_rate": sum(r["valid"] for r in group) / len(group),
                "games": len({r["game"] for r in group})}
        keys = ("role", "side", "exact", "within", "merlin", "composition_valid") if task == "roles" else \
               ("prob", "accuracy", "brier", "logloss", "p_first")
        for key in keys:
            gm = list(game_mean(group, key).values())
            if gm:
                cell[key] = {"mean": sum(gm) / len(gm), "ci95": interval(gm, rng)}
        if task != "roles":
            halves = [list(game_mean([r for r in group if r.get("merlin_first") is flag], "accuracy").values())
                      for flag in (True, False)]
            if all(halves):
                cell["balanced_accuracy"] = sum(sum(h) / len(h) for h in halves) / 2
        out[f"{dataset}|{task}|{variant}"] = cell
    # Order-averaged belief: mean P(Merlin) over asc and desc of the same checkpoint and sample.
    pairs = defaultdict(dict)
    for r in rows:
        if r["task"] != "roles" and r.get("valid"):
            pairs[(r["dataset"], r["task"], r["game"], r["round"], r.get("sample", 1))][r["variant"]] = r["prob"]
    merged = defaultdict(list)
    for (dataset, task, game, round_, _), probs in pairs.items():
        if {"asc", "desc"} <= set(probs):
            p = (probs["asc"] + probs["desc"]) / 2
            merged[(dataset, task)].append({"game": game, "valid": True, "prob": p,
                                            "accuracy": 0.5 if p == 0.5 else float(p > 0.5), "brier": (1 - p) ** 2,
                                            "logloss": -math.log(min(max(p, 0.01), 0.99))})
    for (dataset, task), group in sorted(merged.items()):
        cell = {"rows": len(group), "games": len({r["game"] for r in group})}
        for key in ("prob", "accuracy", "brier", "logloss"):
            gm = list(game_mean(group, key).values())
            cell[key] = {"mean": sum(gm) / len(gm), "ci95": interval(gm, rng)}
        out[f"{dataset}|{task}|order-averaged"] = cell
    return out


def compare(rows_a, rows_b, rng):
    """Paired game-level deltas A - B on the tasks both files answered."""
    out = {}
    cell_of = lambda r: (r["dataset"], r["task"], r["variant"])
    ga, gb = defaultdict(list), defaultdict(list)
    for r in rows_a:
        ga[cell_of(r)].append(r)
    for r in rows_b:
        gb[cell_of(r)].append(r)
    for cell in sorted(set(ga) & set(gb)):
        keys = ("role", "side", "within", "merlin") if cell[1] == "roles" else ("accuracy", "brier", "logloss", "prob")
        for key in keys:
            ma, mb = game_mean(ga[cell], key), game_mean(gb[cell], key)
            common = sorted(set(ma) & set(mb))
            if common:
                d = [ma[g] - mb[g] for g in common]
                out[f"{'|'.join(cell)}|{key}"] = {"games": len(common), "delta": sum(d) / len(d), "ci95": interval(d, rng)}
    return out


def score_file(tasks, labels, path):
    rows = []
    for p in load_jsonl(path):
        task, label = tasks.get(p["task_id"]), labels.get(p["task_id"])
        if task is None:
            raise SystemExit(f"{path}: unknown task_id {p['task_id']}")
        rows.append(score_row(task, label, parse(p.get("text"))) | {"sample": p.get("sample", 1)})
    return rows


def main(argv=None):
    cli = argparse.ArgumentParser()
    cli.add_argument("--data", type=Path, required=True, help="directory holding tasks.jsonl and evaluator/")
    cli.add_argument("--pred", action="append", default=[], help="predictions .jsonl; repeatable")
    cli.add_argument("--compare", nargs=2, metavar=("A", "B"), help="paired deltas A - B")
    cli.add_argument("--out", type=Path, help="write scores and summary JSON here")
    args = cli.parse_args(argv)
    tasks = {t["task_id"]: t for t in load_jsonl(args.data / "tasks.jsonl")}
    labels = {l["task_id"]: l for l in load_jsonl(args.data / "evaluator/labels.jsonl")}
    rng = random.Random(SEED)
    report = {"files": {}}
    scored = {}
    for path in args.pred + (list(args.compare) if args.compare else []):
        if path not in scored:
            scored[path] = score_file(tasks, labels, path)
            report["files"][path] = summarize(scored[path], rng)
    if args.compare:
        report["compare"] = {"a": args.compare[0], "b": args.compare[1],
                             "deltas": compare(scored[args.compare[0]], scored[args.compare[1]], rng)}
    if args.out:
        args.out.mkdir(parents=True, exist_ok=True)
        (args.out / "summary.json").write_text(json.dumps(report, ensure_ascii=False, indent=1) + "\n", encoding="utf8")
        for path, rows in scored.items():
            name = Path(path).stem + ".scores.jsonl"
            with (args.out / name).open("w", encoding="utf8", newline="\n") as f:
                for row in rows:
                    f.write(json.dumps(row, ensure_ascii=False) + "\n")
    for path, cells in report["files"].items():
        print(f"== {path}")
        for name, cell in cells.items():
            main_key = "role" if "|roles|" in name else "brier"
            value = cell.get(main_key, {}).get("mean")
            extra = f" balanced_acc={cell['balanced_accuracy']:.3f}" if "balanced_accuracy" in cell else ""
            valid = f" valid={cell['valid_rate']:.2f}" if "valid_rate" in cell else ""
            print(f"  {name:45s} games={cell['games']:2d}{valid} {main_key}={value if value is None else round(value, 3)}{extra}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
