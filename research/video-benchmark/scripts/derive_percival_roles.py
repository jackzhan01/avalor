"""Derive the percival-roles task from the published benchmark: assign every seat, as Percival.

For each checkpoint the model sees the roles/full record (chat plus proposals, votes and quest
results), headed by the percival/asc line with its own seat and the two thumbs. The system
prompt is the roles prompt rewritten for Percival: the sighting is added, nothing else changes.
One candidate order only (asc). The output schema is the roles schema.

Built from research/benchmark/tasks rather than export_role_tasks.py because the private
releases that script reads are not on every machine. Writes a superset of the published task
set (published rows first, byte-identical, then the new ones) so one --data scores everything:

  python derive_percival_roles.py            # -> research/data/role-tasks-percival-roles/
  python score_role_tasks.py --data ../../data/role-tasks-percival-roles --pred ...
"""
import argparse
import hashlib
import json
import re
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
SRC = REPO / "research/benchmark/tasks"
OUT = REPO / "research/data/role-tasks-percival-roles"
HEADER = re.compile(r"^(?:Your seat: (\d+)\. Candidate seats: (\d+), (\d+)\.|你的座位：(\d+)。候选座位：(\d+)、(\d+)。)\n")

# (old, new) edits on the roles system prompt; each must apply exactly once.
EDITS = {
    "en": [
        ("Infer all six players' hidden roles in this six-player game of The Resistance: Avalon, "
         "from the supplied public record only.",
         "You are the good player Percival in this six-player game of The Resistance: Avalon. "
         "Infer all six players' hidden roles from your initial sighting and the supplied public record only."),
        ("The record contains public chat",
         "Your seat and your two candidate seats are given first; the two candidate seats are Merlin and "
         "Morgana in unknown order. The record contains public chat"),
        ("Use only public evidence in this record;", "Use only your sighting and the public evidence in this record;"),
        ("respecting the role counts, even when uncertain.",
         "respecting the role counts and your sighting, even when uncertain."),
    ],
    "zh": [
        ("你是旁观者。根据截至此刻的公开发言和行动，返回全桌最可能的身份分配，遵守每种角色的张数。",
         "你是好人派西维尔，两个候选座位分别是梅林和莫甘娜，次序未知。根据你的开局视野和截至此刻的公开发言和行动，"
         "返回全桌最可能的身份分配，遵守每种角色的张数，并与你的开局视野一致。"),
    ],
}


def load_jsonl(path):
    return [json.loads(line) for line in Path(path).read_text(encoding="utf8").splitlines() if line.strip()]


def percival_system(text, language):
    for old, new in EDITS[language]:
        assert text.count(old) == 1, (language, old)
        text = text.replace(old, new)
    return text


def derive(tasks, labels):
    roles = {(t["dataset"], t["game"], t["round"]): t for t in tasks if t["task"] == "roles" and t["variant"] == "full"}
    out_tasks, out_labels = [], []
    for p in tasks:
        if p["task"] != "percival" or p["variant"] != "asc":
            continue
        r = roles[(p["dataset"], p["game"], p["round"])]
        header = HEADER.match(p["messages"][1]["content"])
        assert header, p["task_id"]
        own, a, b = [g for g in header.groups() if g]
        tid = r["task_id"].replace("/roles/full", "/percival-roles/asc")
        out_tasks.append(r | {"task_id": tid, "task": "percival-roles", "variant": "asc", "messages": [
            {"role": "system", "content": percival_system(r["messages"][0]["content"], r["language"])},
            {"role": "user", "content": header[0] + r["messages"][1]["content"]}]})
        label = labels[p["task_id"]]
        assert label["roles"][own] == "percival" and {label["roles"][a], label["roles"][b]} == {"merlin", "morgana"}
        assert label["first_listed_seat"] == a
        out_labels.append(label | {"task_id": tid, "percival_seat": own, "candidate_seats": [a, b]})
    return out_tasks, out_labels


def write_jsonl(path, rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf8", newline="\n") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")


def main():
    cli = argparse.ArgumentParser()
    cli.add_argument("--src", type=Path, default=SRC)
    cli.add_argument("--out", type=Path, default=OUT)
    args = cli.parse_args()
    tasks = load_jsonl(args.src / "tasks.jsonl")
    labels = load_jsonl(args.src / "evaluator/labels.jsonl")
    new_tasks, new_labels = derive(tasks, {l["task_id"]: l for l in labels})
    for t in new_tasks:  # nothing answer-side on the model side
        assert not {"roles", "merlin_seat", "first_listed_is_merlin", "sides"} & set(t), t["task_id"]
        assert "first_listed_is_merlin" not in json.dumps(t, ensure_ascii=False)
    write_jsonl(args.out / "tasks.jsonl", tasks + new_tasks)
    write_jsonl(args.out / "evaluator/labels.jsonl", labels + new_labels)
    digests = {rel: hashlib.sha256((args.out / rel).read_bytes()).hexdigest()
               for rel in ("tasks.jsonl", "evaluator/labels.jsonl")}
    (args.out / "sha256.json").write_text(json.dumps(digests, indent=2) + "\n", encoding="utf8")
    print(json.dumps({"published": len(tasks), "percival-roles": len(new_tasks)}))


if __name__ == "__main__":
    main()
