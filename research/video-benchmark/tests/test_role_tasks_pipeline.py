"""Client -> predictions -> scorer, with the HTTP call replaced in-process. No network."""
import importlib.util
import json
from pathlib import Path

SCRIPTS = Path(__file__).parents[1] / "scripts"


def load(name):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


client, scorer = load("run_openai_compatible"), load("score_role_tasks")
ROLES = {"1": "merlin", "2": "percival", "3": "morgana", "4": "assassin", "5": "servant", "6": "servant"}
SCHEMA_ROLES = {"type": "object", "properties": {s: {"type": "string", "enum": ["merlin", "percival", "morgana",
                "assassin", "servant"]} for s in ROLES}, "required": list(ROLES), "additionalProperties": False}
SCHEMA_BELIEF = {"type": "object", "properties": {"first_percent": {"type": "integer", "minimum": 0, "maximum": 100}},
                 "required": ["first_percent"], "additionalProperties": False}


SEEN = []


def fake_post(url, body, key, timeout):
    """Stands in for the HTTP call; the suite forbids sockets, localhost included."""
    SEEN.append(body)
    if "Candidate seats" in body["messages"][1]["content"]:
        # Always favours the first-listed seat: a pure position bias.
        content = '<think>seat 1 looks calm</think>\n{"first_percent": 80}'
    else:
        content = json.dumps({**ROLES, "1": "percival", "2": "merlin"})
    return {"model": body["model"], "choices": [{"message": {"content": content}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 10, "completion_tokens": 5}}


def write_jsonl(path, rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(r) + "\n" for r in rows), encoding="utf8")


def make_data(root):
    common = {"dataset": "avalon-nlu-6p", "players": 6, "language": "en", "game": "g1", "round": 1}
    tasks = [common | {"task_id": "nlu6/g1/q1/roles/full", "task": "roles", "variant": "full",
                       "messages": [{"role": "system", "content": "s"}, {"role": "user", "content": "record"}],
                       "json_schema": SCHEMA_ROLES}]
    labels = [{"task_id": "nlu6/g1/q1/roles/full", "players": 6, "game": "g1", "roles": ROLES, "merlin_seat": "1"}]
    for variant, first in (("asc", "1"), ("desc", "3")):
        other = "3" if first == "1" else "1"
        tid = f"nlu6/g1/q1/percival/{variant}"
        tasks.append(common | {"task_id": tid, "task": "percival", "variant": variant, "json_schema": SCHEMA_BELIEF,
                               "messages": [{"role": "system", "content": "s"},
                                            {"role": "user", "content": f"Your seat: 2. Candidate seats: {first}, {other}."}]})
        labels.append({"task_id": tid, "players": 6, "game": "g1", "roles": ROLES, "merlin_seat": "1",
                       "first_listed_seat": first, "first_listed_is_merlin": first == "1"})
    write_jsonl(root / "tasks.jsonl", tasks)
    write_jsonl(root / "evaluator/labels.jsonl", labels)


def test_client_and_scorer_end_to_end(tmp_path, monkeypatch):
    make_data(tmp_path)
    monkeypatch.setattr(client, "post", fake_post)
    preds = tmp_path / "preds.jsonl"
    argv = ["--tasks", str(tmp_path / "tasks.jsonl"), "--out", str(preds), "--model", "stub", "--samples", "2",
            "--base-url", "http://compute-node:8000/v1", "--workers", "2"]
    assert client.main(argv) == 0
    assert client.main(argv) == 0  # resume: nothing left to send
    rows = [json.loads(l) for l in preds.read_text(encoding="utf8").splitlines()]
    assert len(rows) == 6 and len(SEEN) == 6
    assert all(b["response_format"]["json_schema"]["strict"] for b in SEEN)

    out = tmp_path / "scored"
    assert scorer.main(["--data", str(tmp_path), "--pred", str(preds), "--out", str(out)]) == 0
    summary = json.loads((out / "summary.json").read_text(encoding="utf8"))["files"][str(preds)]
    roles = summary["avalon-nlu-6p|roles|full"]
    assert roles["role"]["mean"] == 4 / 6 and roles["side"]["mean"] == 1.0 and roles["merlin"]["mean"] == 0.0
    # 80% on the first slot is right in asc, wrong in desc; averaging the orders exposes it as 50/50.
    assert summary["avalon-nlu-6p|percival|asc"]["accuracy"]["mean"] == 1.0
    assert summary["avalon-nlu-6p|percival|desc"]["accuracy"]["mean"] == 0.0
    assert abs(summary["avalon-nlu-6p|percival|order-averaged"]["prob"]["mean"] - 0.5) < 1e-9


def test_parse_tolerates_reasoning_and_trailing_text():
    assert scorer.parse('<think>{"x":1}</think>{"first_percent": 40}') == {"first_percent": 40}
    assert scorer.parse('Answer: {"a": {"b": 1}} done') == {"a": {"b": 1}}
    assert scorer.parse("no json here") is None


def test_percival_roles_derived_from_published_benchmark():
    derive = load("derive_percival_roles")
    src = derive.SRC
    tasks = derive.load_jsonl(src / "tasks.jsonl")
    labels = {l["task_id"]: l for l in derive.load_jsonl(src / "evaluator/labels.jsonl")}
    new_tasks, new_labels = derive.derive(tasks, labels)  # asserts every prompt edit applies exactly once
    assert len(new_tasks) == sum(t["task"] == "percival" and t["variant"] == "asc" for t in tasks)
    for t, l in zip(new_tasks, new_labels):
        roles_task = next(x for x in tasks if x["task_id"] == t["task_id"].replace("/percival-roles/asc", "/roles/full"))
        assert t["messages"][1]["content"].endswith(roles_task["messages"][1]["content"])  # full record, not chat only
        assert t["json_schema"] == roles_task["json_schema"]
        assert l["roles"][l["percival_seat"]] == "percival" and l["merlin_seat"] in l["candidate_seats"]

    label = new_labels[0]
    task = new_tasks[0]
    a, b = label["candidate_seats"]
    swapped = dict(label["roles"]) | {a: label["roles"][b], b: label["roles"][a]}
    perfect, wrong = scorer.score_row(task, label, label["roles"]), scorer.score_row(task, label, swapped)
    assert perfect["merlin_pick"] == perfect["sighting_consistent"] == perfect["role"] == 1.0
    assert wrong["merlin_pick"] == 0.0 and wrong["sighting_consistent"] == 1.0


def test_system_suffix_by_language():
    msgs = [{"role": "system", "content": "Rules.\n"}, {"role": "user", "content": "record"}]
    assert client.with_suffix(msgs, "") is msgs
    assert client.with_suffix(msgs, "Be brief.")[0]["content"] == "Rules. Be brief."
    assert client.with_suffix([{"role": "system", "content": "仅返回 JSON。"}], "简短。")[0]["content"] == "仅返回 JSON。简短。"
    assert msgs[0]["content"] == "Rules.\n"  # the task itself is not mutated
