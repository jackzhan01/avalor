"""Export every role-inference checkpoint as model-agnostic chat tasks plus a separate answer key.

Output (default research/data/role-tasks-v1/, git-ignored):
  tasks.jsonl            what a model may see: OpenAI-style messages + a JSON schema. No labels.
  evaluator/labels.jsonl answers keyed by task_id; for scoring only, never in a prompt.
  sha256.json            hashes of both files.

Prompts are byte-identical to the ones the API runs sent (6p from the frozen Avalon-NLU
round plan, 10p from the leak-free ten-rounds-v2 plan), so local models are comparable with
Gemini/Qwen/Jev. Two additions the API runs lacked:
  - roles/actions: the six-player record with player chat removed (nlu_actions_only.py);
  - belief tasks in both candidate orders (asc as sent before, desc swapped), because a
    model that always picks one slot otherwise looks like it reads Merlin.
The "current round only" belief control is not exported: it answered a side question (does
old talk help?) with too few paired checkpoints to say anything.
"""
import argparse
import hashlib
import json
import re
from pathlib import Path

import nlu_rounds
from nlu_actions_only import cutoffs as six_cutoffs
from nlu_openrouter import request_body
from nlu_rounds import base

REPO = Path(__file__).resolve().parents[3]
TEN_PLAN = REPO / "research/data/video-benchmark/experiments/ten-rounds-v2/plan.json"
TEN_RELEASE = REPO / "research/data/video-benchmark/releases/yuanzhuo22-preprocess-v2"
OUT = REPO / "research/data/role-tasks-v1"
EVIL = {"morgana", "assassin", "oberon", "mordred", "wallbreaker"}
SIX_SEATS = re.compile(r"^(Your seat: \d+\. Candidate seats: )(\d+), (\d+)\.", re.M)
TEN_SEATS = re.compile(r"^(你的座位：\d+。候选座位：)(\d+)、(\d+)。", re.M)


def chat(body):
    """Gemini-format body -> the provider-neutral part of an OpenAI chat request."""
    converted = request_body(body)
    return converted["messages"], converted["response_format"]["json_schema"]["schema"]


def swap(messages, pattern, sep):
    user = messages[1]["content"]
    match = pattern.search(user)
    assert match, "candidate line not found"
    swapped = pattern.sub(lambda m: f"{m[1]}{m[3]}{sep}{m[2]}" + ("." if sep == ", " else "。"), user, count=1)
    return [messages[0], {"role": "user", "content": swapped}], (match[2], match[3])


def label(task_id, players, game, roles, first=None):
    merlin = next(s for s, r in roles.items() if r == "merlin")
    row = {"task_id": task_id, "players": players, "game": game, "roles": roles, "merlin_seat": merlin,
           "sides": {s: "evil" if r in EVIL else "good" for s, r in roles.items()}}
    if first is not None:
        row["first_listed_seat"] = first
        row["first_listed_is_merlin"] = first == merlin
    return row


def six_player():
    tasks, labels = [], []
    jobs = nlu_rounds.jobs()
    roles_by_game = {j["game"]: j["roles"] for j in jobs}
    seen = set()
    for j in jobs:
        if j["task"] == "recent":
            continue  # dropped control, see module docstring
        key = (j["game"], j["round"], j["task"])
        if key in seen:
            continue
        seen.add(key)
        messages, schema = chat(j["body"])
        common = {"dataset": "avalon-nlu-6p", "players": 6, "language": "en", "game": j["game"], "round": j["round"],
                  "task": j["task"]}
        if j["task"] == "roles":
            tid = f"nlu6/{j['game']}/q{j['round']}/roles/full"
            tasks.append(common | {"task_id": tid, "variant": "full", "messages": messages, "json_schema": schema})
            labels.append(label(tid, 6, j["game"], j["roles"]))
            continue
        flipped, (a, b) = swap(messages, SIX_SEATS, ", ")
        for variant, msgs, first in (("asc", messages, a), ("desc", flipped, b)):
            tid = f"nlu6/{j['game']}/q{j['round']}/{j['task']}/{variant}"
            tasks.append(common | {"task_id": tid, "variant": variant, "messages": msgs, "json_schema": schema})
            labels.append(label(tid, 6, j["game"], j["roles"], first))
    items, _ = six_cutoffs()
    for gid, round_, _, actions in items:
        messages, schema = chat(base.payload(actions))
        tid = f"nlu6/{gid}/q{round_}/roles/actions"
        tasks.append({"task_id": tid, "dataset": "avalon-nlu-6p", "players": 6, "language": "en", "game": gid,
                      "round": round_, "task": "roles", "variant": "actions", "messages": messages,
                      "json_schema": schema})
        labels.append(label(tid, 6, gid, roles_by_game[gid]))
    return tasks, labels


def ten_player():
    manifest = base.read(TEN_RELEASE / "manifest.json")
    assert manifest["release_id"] == "yuanzhuo22-preprocess-v2", "ten-player tasks must come from the v2 release"
    truth = {}
    for pair in manifest["pairs"]:
        if pair["kind"] == "full":
            seats = base.read(TEN_RELEASE / pair["label_path"])["seats"]
            truth[pair["bvid"]] = {s: v["role"] for s, v in seats.items()}
    tasks, labels = [], []
    plan = base.read(TEN_PLAN)
    desc_text = {(j["game"], j["round"]): j["body"]["messages"][1]["content"] for j in plan if j["task"] == "percival_desc"}
    for j in plan:
        if j["task"] == "percival_desc":
            continue  # rebuilt below by swap(); must match what Gemini was sent
        body = j["body"]
        assert body["model"] == "google/gemini-4-hydrogen", "export from the gemini arm, the reference prompt set"
        messages = body["messages"]
        schema = body["response_format"]["json_schema"]["schema"]
        common = {"dataset": "yuanzhuo22-10p-v2", "players": 10, "language": "zh", "game": j["game"],
                  "round": j["round"], "task": j["task"]}
        if j["task"] == "roles":
            tid = f"yz10/{j['game']}/q{j['round']}/roles/full"
            tasks.append(common | {"task_id": tid, "variant": "full", "messages": messages, "json_schema": schema})
            labels.append(label(tid, 10, j["game"], truth[j["game"]]))
            continue
        flipped, (a, b) = swap(messages, TEN_SEATS, "、")
        assert flipped[1]["content"] == desc_text[(j["game"], j["round"])], "desc must equal the API order control"
        for variant, msgs, first in (("asc", messages, a), ("desc", flipped, b)):
            tid = f"yz10/{j['game']}/q{j['round']}/{j['task']}/{variant}"
            tasks.append(common | {"task_id": tid, "variant": variant, "messages": msgs, "json_schema": schema})
            labels.append(label(tid, 10, j["game"], truth[j["game"]], first))
    return tasks, labels


def check(tasks, labels):
    ids = [t["task_id"] for t in tasks]
    assert len(ids) == len(set(ids)) == len(labels)
    assert ids == [l["task_id"] for l in labels]
    for t in tasks:
        text = json.dumps(t, ensure_ascii=False)
        # Nothing on the model side may name a seat's true role or carry evaluator fields.
        assert "first_listed_is_merlin" not in text and "merlin_seat" not in text
    for t, l in zip(tasks, labels):
        if t["task"] != "roles":
            seat = l["first_listed_seat"]
            assert re.search(rf"(Candidate seats: |候选座位：){seat}\b", t["messages"][1]["content"]), t["task_id"]


def write_jsonl(path, rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf8", newline="\n") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")


def main():
    cli = argparse.ArgumentParser()
    cli.add_argument("--out", type=Path, default=OUT)
    args = cli.parse_args()
    six_tasks, six_labels = six_player()
    ten_tasks, ten_labels = ten_player()
    tasks, labels = six_tasks + ten_tasks, six_labels + ten_labels
    check(tasks, labels)
    write_jsonl(args.out / "tasks.jsonl", tasks)
    write_jsonl(args.out / "evaluator/labels.jsonl", labels)
    digests = {rel: hashlib.sha256((args.out / rel).read_bytes()).hexdigest()
               for rel in ("tasks.jsonl", "evaluator/labels.jsonl")}
    (args.out / "sha256.json").write_text(json.dumps(digests, indent=2) + "\n", encoding="utf8")
    counts = {}
    for t in tasks:
        k = f"{t['dataset']}|{t['task']}|{t['variant']}"
        counts[k] = counts.get(k, 0) + 1
    print(json.dumps({"tasks": len(tasks), "by_kind": counts}, indent=1))


if __name__ == "__main__":
    main()
