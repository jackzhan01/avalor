"""Six-player roles task: full public record vs. public actions only (player chat removed).

Answers one question the round-by-round report could not: is the round 1 -> 3 gain in
whole-table role accuracy a reading of player talk, or just what the actions already say?

Both arms are sent in one batch through the same transport (OpenRouter -> Google AI Studio)
in a shuffled order, so time and routing cannot masquerade as an arm effect. The system
instruction is byte-identical across arms; only the user record changes. The historical
single-draw full-record answers are kept as a separate arm for a transport check.
"""
import argparse
import concurrent.futures
import json
import random
import re
import threading
import urllib.error
import urllib.request
from collections import Counter

import nlu_rounds
from nlu_openrouter import MODEL, URL, normalize, request_body
from nlu_rounds import atomic, base

OUT = base.DATA / "experiments/gemini-hydrogen-actions-only-v1"
HISTORY = base.DATA / "experiments/gemini-4-hydrogen-rounds-v1/scores.json"
ARMS = (("full", 1), ("actions", 1), ("actions", 2))
EVIL = {"morgana", "assassin"}
SEED = 20261125
BUDGET_USD = 20.0

# Written into plan.json before the first request; the scorer reads it back, not this constant.
PREREGISTRATION = {
    "question": "Does player chat add role information beyond public actions for the whole-table roles task?",
    "unit": "game (20 Avalon-NLU games); rounds and draws are nested inside a game",
    "primary": "delta_role = role accuracy(full) - role accuracy(actions), averaged per game over rounds 1-3 "
               "(all 20 games reach round 3), then equally over games. Actions arm averages its 2 draws first.",
    "secondary": ["delta_side (side accuracy)", "delta_within (role correct / side correct, per cutoff)",
                  "delta_merlin (the seat labelled merlin is Merlin)", "same deltas over all 82 cutoffs"],
    "decision": "Support 'chat adds role information' only if the 95% game-bootstrap interval of the primary "
                "delta lies above 0. Interval above 0 for delta_within or delta_merlin while delta_side is "
                "near 0 would localise the gain to role identity rather than side. Interval containing 0 is "
                "'not shown', never 'chat is useless'.",
    "uncertainty": "3000 game-level bootstrap resamples (percentile) and a sign-flip permutation test "
                   "(20000 random flips) on per-game deltas.",
    "transport_check": "fresh full arm vs historical full arm (different transport mix); reported, not pooled "
                       "into the primary contrast.",
}


def cutoffs():
    """(game, round, full_text, actions_text) at every quest result, mirroring nlu_rounds.jobs(); plus labels."""
    reference = {(j["game"], j["round"]): j["body"] for j in nlu_rounds.jobs() if j["task"] == "roles"}
    labels, items = {}, []
    for pair in base.prepare()["pairs"]:
        gid = pair["game_id"]
        source = base.DATA / "upstream/dataset" / (gid + ".json")
        assert base.digest(source.read_bytes()) == pair["source_sha256"]
        game = base.read(source)
        labels[gid] = base.read(base.RELEASE / pair["label_path"])["roles"]
        view, round_ = {}, 0
        for rid, m in sorted(game["messages"].items(), key=lambda kv: int(kv[0])):
            if base.phase_end(m):
                break
            view[rid] = m
            if m["player"] == "system" and re.fullmatch(r"quest (succeeded|failed)!", m["msg"].strip().lower()):
                round_ += 1
                full = base.public_text(view)[0]
                # Record ids keep their original numbers, so gaps show how much was said but not what.
                actions = base.public_text({k: v for k, v in view.items() if v["player"] == "system"})[0]
                assert base.payload(full) == reference[(gid, round_)], (gid, round_)
                assert not re.search(r"\] player-\d: ", actions)
                items.append((gid, round_, full, actions))
    assert len(labels) == 20 and len(items) == 82
    return items, labels


def schedule(items):
    jobs = []
    for gid, round_, full, actions in items:
        for arm, draw in ARMS:
            body = request_body(base.payload(full if arm == "full" else actions))
            jobs.append({"game": gid, "round": round_, "arm": arm, "draw": draw, "body": body,
                         "digest": base.digest(json.dumps(body, sort_keys=True).encode()),
                         "path": OUT / arm / gid / f"q{round_}" / f"draw{draw}.json"})
    assert len(jobs) == 82 * len(ARMS)
    random.Random(SEED).shuffle(jobs)
    return jobs


def freeze(jobs):
    plan = {"model": MODEL, "transport": "OpenRouter -> Google AI Studio (pinned, no fallbacks)", "seed": SEED,
            "preregistration": PREREGISTRATION,
            "system_instruction_sha256": base.digest(base.INSTRUCTION.encode()),
            "jobs": [{k: j[k] for k in ("game", "round", "arm", "draw", "digest")} | {"request": j["body"]}
                     for j in jobs]}
    path = OUT / "plan.json"
    if path.exists():
        assert base.read(path) == json.loads(json.dumps(plan)), "plan.json drifted; refuse to mix designs"
    else:
        atomic(path, plan)


def api_key():
    text = (base.REPO / ".env.local").read_text(encoding="utf-8-sig")
    line = re.search(r"(?im)^\s*(?:export\s+)?openrouter_api_key\s*=\s*(.+)$", text)
    if not line:
        raise RuntimeError("Missing OpenRouter key")
    return line[1].strip().split(" #")[0].strip().strip("\"'")


def spent():
    return sum((base.read(p)["openrouter"]["usage"].get("cost") or 0) for p in OUT.glob("*/*/q*/draw*.json"))


def run(jobs, workers, limit):
    key = api_key()
    stop = threading.Event()
    lock = threading.Lock()
    budget = {"used": spent()}
    todo = [j for j in jobs if not j["path"].exists()][:limit]
    print(f"{len(todo)} to send, {budget['used']:.4f} USD already spent", flush=True)

    def fetch(job):
        with lock:
            if budget["used"] >= BUDGET_USD:
                stop.set()
        if stop.is_set():
            return
        req = urllib.request.Request(URL, data=json.dumps(job["body"]).encode(), headers={
            "Authorization": "Bearer " + key, "Content-Type": "application/json",
            "User-Agent": "research-batch/1.0"})
        for attempt in range(4):
            if stop.is_set():
                return
            try:
                with urllib.request.urlopen(req, timeout=600) as response:
                    answer = json.load(response)
            except urllib.error.HTTPError as exc:
                detail = exc.read().decode(errors="replace").replace(key, "[redacted]")
                try:
                    error = json.loads(detail).get("error", {})
                except ValueError:
                    error = {}
                meta = error.get("metadata") or {}
                print("OpenRouter", exc.code, str(error.get("message", "Request error"))[:300], flush=True)
                transient = exc.code in (429, 502, 503, 504) or (
                    exc.code == 402 and meta.get("reason") == "in_flight_budget_exhausted")
                if transient and attempt < 3:
                    stop.wait(5 * 2 ** attempt)
                    continue
                stop.set()
                return
            except (OSError, ValueError) as exc:
                print(type(exc).__name__, str(exc).replace(key, "[redacted]")[:200], flush=True)
                if attempt < 3:
                    stop.wait(10 * 2 ** attempt)
                    continue
                stop.set()
                return
            receipt = {"digest": job["digest"], "transport": "OpenRouter", "openrouter": answer}
            try:
                receipt["response"] = normalize(answer)
            except (ValueError, KeyError, TypeError) as exc:
                atomic(OUT / "errors" / job["arm"] / job["game"] / f"q{job['round']}" / f"draw{job['draw']}.json",
                       receipt | {"error": repr(exc)})
                print("unexpected receipt", job["game"], job["round"], job["arm"], repr(exc), flush=True)
                return
            atomic(job["path"], receipt)
            cost = answer.get("usage", {}).get("cost") or 0
            with lock:
                budget["used"] += cost
            print(job["arm"], job["draw"], job["game"], job["round"], f"{cost:.4f}", f"total={budget['used']:.3f}",
                  flush=True)
            return

    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        list(pool.map(fetch, todo))
    return int(stop.is_set())


def metrics(pred, actual):
    if pred is None:
        return None
    role = [pred[s] == actual[s] for s in actual]
    side = [(pred[s] in EVIL) == (actual[s] in EVIL) for s in actual]
    within = sum(r for r, s in zip(role, side) if s) / max(1, sum(side))
    merlin = [s for s in pred if pred[s] == "merlin"]
    return {"role": sum(role) / 6, "side": sum(side) / 6, "within": within,
            "merlin": float(len(merlin) == 1 and actual[merlin[0]] == "merlin"),
            "composition_valid": Counter(pred.values()) == base.COUNTS}


def score(jobs, labels):
    rows = []
    for j in jobs:
        row = {k: j[k] for k in ("game", "round", "arm", "draw")} | {"valid": None}
        if j["path"].exists():
            receipt = base.read(j["path"])
            assert receipt["digest"] == j["digest"]
            pred, error = base.parse_prediction(receipt["response"])
            row.update(valid=error is None, error=error, cost=receipt["openrouter"]["usage"].get("cost"),
                       predicted=pred, **(metrics(pred, labels[j["game"]]) or {}))
        rows.append(row)
    for r in base.read(HISTORY):
        if r["task"] == "roles":
            rows.append({"game": r["game"], "round": r["round"], "arm": "full_hist", "draw": 1, "valid": r["valid"],
                         "transport": r.get("transport"), "predicted": r.get("predicted"),
                         **(metrics(r.get("predicted"), labels[r["game"]]) if r["valid"] else {})})
    atomic(OUT / "scores.json", rows)
    return rows


def game_means(rows, arm, key, rounds):
    cells = {}
    for r in rows:
        if r["arm"] == arm and r.get("valid") and r["round"] in rounds:
            cells.setdefault((r["game"], r["round"]), []).append(r[key])
    per_game = {}
    for (g, _), values in cells.items():
        per_game.setdefault(g, []).append(sum(values) / len(values))
    return {g: sum(v) / len(v) for g, v in per_game.items()}


def summarize(rows):
    rng = random.Random(SEED)
    state = lambda r: "pending" if r.get("valid") is None else ("valid" if r["valid"] else "invalid")
    out = {"valid": {f"{a}|{s}": n for (a, s), n in Counter((r["arm"], state(r)) for r in rows).items()},
           "cost_usd": round(sum(r.get("cost") or 0 for r in rows), 5), "levels": {}, "contrasts": {}}
    windows = {"rounds1-3": {1, 2, 3}, "all": {1, 2, 3, 4, 5}}
    for name, rounds in windows.items():
        for key in ("role", "side", "within", "merlin"):
            for arm in ("full", "actions", "full_hist"):
                gm = game_means(rows, arm, key, rounds)
                out["levels"][f"{name}|{key}|{arm}"] = {"n": len(gm), "mean": sum(gm.values()) / max(1, len(gm))}
            for a, b in (("full", "actions"), ("full_hist", "actions"), ("full", "full_hist")):
                ga, gb = game_means(rows, a, key, rounds), game_means(rows, b, key, rounds)
                common = sorted(set(ga) & set(gb))
                if not common:
                    continue
                d = [ga[g] - gb[g] for g in common]
                mean = sum(d) / len(d)
                boots = sorted(sum(d[rng.randrange(len(d))] for _ in d) / len(d) for _ in range(3000))
                flips = sum(abs(sum(x if rng.random() < .5 else -x for x in d)) >= abs(sum(d)) - 1e-12
                            for _ in range(20000))
                out["contrasts"][f"{name}|{key}|{a}-{b}"] = {
                    "n": len(d), "delta": mean, "ci95": [boots[74], boots[2924]], "sign_flip_p": flips / 20000,
                    "per_game": dict(zip(common, d))}
    for arm in ("full", "actions", "full_hist"):
        for round_ in range(1, 6):
            for key in ("role", "side", "within", "merlin"):
                gm = game_means(rows, arm, key, {round_})
                if gm:
                    out["levels"][f"round{round_}|{key}|{arm}"] = {"n": len(gm), "mean": sum(gm.values()) / len(gm)}
    atomic(OUT / "summary.json", out)
    primary = out["contrasts"].get("rounds1-3|role|full-actions")
    print(json.dumps({"cost_usd": out["cost_usd"], "valid": out["valid"], "primary": primary and
                      {k: primary[k] for k in ("n", "delta", "ci95", "sign_flip_p")}}, indent=1))


if __name__ == "__main__":
    cli = argparse.ArgumentParser()
    cli.add_argument("command", choices=["prepare", "run", "score"])
    cli.add_argument("--workers", type=int, default=4)
    cli.add_argument("--limit", type=int, default=10_000)
    args = cli.parse_args()
    checkpoints, truth = cutoffs()
    all_jobs = schedule(checkpoints)
    freeze(all_jobs)
    code = run(all_jobs, args.workers, args.limit) if args.command == "run" else 0
    if args.command != "prepare":
        summarize(score(all_jobs, truth))
    raise SystemExit(code)
