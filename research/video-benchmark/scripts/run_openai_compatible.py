"""Send role tasks to any OpenAI-compatible chat endpoint (a local vLLM server, OpenRouter, ...).

Only reads tasks.jsonl, never the answer key, so it can run on a machine that does not hold
labels. Appends one JSON line per (task_id, sample) and skips pairs already written, so an
interrupted job on a compute node resumes where it stopped.

  python run_openai_compatible.py --tasks tasks.jsonl --out preds/qwen3-8b-base.jsonl \
      --base-url http://localhost:8000/v1 --model Qwen/Qwen3-8B --samples 3
"""
import argparse
import concurrent.futures
import json
import os
import re
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path


def load_jsonl(path):
    with Path(path).open(encoding="utf8") as f:
        return [json.loads(line) for line in f if line.strip()]


def request(args, task):
    body = {"model": args.model, "messages": task["messages"], "temperature": args.temperature,
            "top_p": args.top_p, "max_tokens": args.max_tokens}
    if not args.no_schema:
        body["response_format"] = {"type": "json_schema",
                                   "json_schema": {"name": "prediction", "strict": True, "schema": task["json_schema"]}}
    body.update(json.loads(args.extra_body))
    return body


def post(url, body, key, timeout):
    headers = {"Content-Type": "application/json"}
    if key:
        headers["Authorization"] = "Bearer " + key
    req = urllib.request.Request(url, data=json.dumps(body).encode(), headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as response:
        return json.load(response)


def main(argv=None):
    cli = argparse.ArgumentParser()
    cli.add_argument("--tasks", required=True)
    cli.add_argument("--out", required=True)
    cli.add_argument("--base-url", default="http://localhost:8000/v1")
    cli.add_argument("--model", required=True)
    cli.add_argument("--samples", type=int, default=1)
    cli.add_argument("--temperature", type=float, default=1.0)
    cli.add_argument("--top-p", type=float, default=1.0)
    cli.add_argument("--max-tokens", type=int, default=8192)
    cli.add_argument("--workers", type=int, default=4)
    cli.add_argument("--filter", default="", help="regex on task_id, e.g. '^nlu6/' or '/roles/'")
    cli.add_argument("--no-schema", action="store_true", help="omit response_format (score the raw text instead)")
    cli.add_argument("--extra-body", default="{}",
                     help='merged into each request, e.g. \'{"chat_template_kwargs": {"enable_thinking": false}}\'')
    cli.add_argument("--api-key-env", default="OPENAI_API_KEY")
    cli.add_argument("--timeout", type=float, default=900)
    args = cli.parse_args(argv)

    pattern = re.compile(args.filter)
    tasks = [t for t in load_jsonl(args.tasks) if pattern.search(t["task_id"])]
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    done = {(r["task_id"], r["sample"]) for r in load_jsonl(out)} if out.exists() else set()
    todo = [(t, s) for t in tasks for s in range(1, args.samples + 1) if (t["task_id"], s) not in done]
    print(f"{len(tasks)} tasks x {args.samples} samples; {len(todo)} to send", flush=True)
    key = os.environ.get(args.api_key_env, "")
    url = args.base_url.rstrip("/") + "/chat/completions"
    lock = threading.Lock()
    failures = []

    def run(item):
        task, sample = item
        body = request(args, task)
        for attempt in range(5):
            try:
                answer = post(url, body, key, args.timeout)
                break
            except urllib.error.HTTPError as exc:
                detail = exc.read().decode(errors="replace")[:300]
                if exc.code in (429, 500, 502, 503, 504) and attempt < 4:
                    time.sleep(5 * 2 ** attempt)
                    continue
                failures.append((task["task_id"], sample, exc.code, detail))
                return
            except (OSError, ValueError) as exc:
                if attempt < 4:
                    time.sleep(5 * 2 ** attempt)
                    continue
                failures.append((task["task_id"], sample, type(exc).__name__, str(exc)[:300]))
                return
        choice = (answer.get("choices") or [{}])[0]
        message = choice.get("message") or {}
        row = {"task_id": task["task_id"], "sample": sample, "model": answer.get("model", args.model),
               "text": message.get("content") or "", "reasoning": message.get("reasoning_content"),
               "finish_reason": choice.get("finish_reason"), "usage": answer.get("usage"),
               "params": {k: body[k] for k in ("temperature", "top_p", "max_tokens")} |
                         {"schema": not args.no_schema, "extra_body": json.loads(args.extra_body)},
               "time": time.strftime("%Y-%m-%dT%H:%M:%S")}
        with lock, out.open("a", encoding="utf8", newline="\n") as f:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")

    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
        list(pool.map(run, todo))
    for failure in failures:
        print("FAILED", *failure, flush=True)
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
