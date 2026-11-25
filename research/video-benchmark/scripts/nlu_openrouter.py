"""Complete missing frozen Avalon checkpoints through Google AI Studio on OpenRouter."""
import argparse
import concurrent.futures
import json
import re
import threading
import time
import urllib.error
import urllib.request

from nlu_rounds import OUT, atomic, base, fingerprint, freeze, jobs, outcomes


MODEL = "google/" + base.MODEL
URL = "https://openrouter.ai/api/v1/chat/completions"


def request_body(body):
    config = body["generationConfig"]
    return {
        "model": MODEL,
        "messages": [{"role": "system", "content": body["systemInstruction"]["parts"][0]["text"]},
                     {"role": "user", "content": body["contents"][0]["parts"][0]["text"]}],
        "temperature": config["temperature"], "max_tokens": config["maxOutputTokens"],
        "reasoning": {"effort": config["thinkingConfig"]["thinkingLevel"].lower(), "exclude": True},
        "response_format": {"type": "json_schema", "json_schema": {"name": "prediction", "strict": True,
                           "schema": config["responseJsonSchema"]}},
        "provider": {"only": ["google-ai-studio"], "allow_fallbacks": False, "require_parameters": True},
        "service_tier": "default",
    }


def normalize(answer):
    model_id = answer["model"]
    if not re.fullmatch(re.escape(MODEL) + r"(?:-\d{8})?", model_id) or answer["provider"] != "Google AI Studio":
        raise ValueError("Unexpected model or upstream provider")
    choice, = answer["choices"]
    usage = answer["usage"]
    thinking = (usage.get("completion_tokens_details") or {}).get("reasoning_tokens") or 0
    return {"modelVersion": base.MODEL, "candidates": [{
        "finishReason": "STOP" if choice["finish_reason"]=="stop" else choice["finish_reason"],
        "content": {"parts": [{"text": choice["message"].get("content") or ""}]}}],
        "usageMetadata": {"promptTokenCount":usage["prompt_tokens"], "thoughtsTokenCount":thinking,
                          "candidatesTokenCount":usage["completion_tokens"]-thinking,
                          "totalTokenCount":usage["total_tokens"]}}


def run(limit, workers):
    schedule = jobs()
    freeze(schedule)
    unique = {j["path"]:j for j in reversed(schedule) if not j["reused"] and not j["path"].exists()}
    todo = sorted(unique.values(),key=lambda j:(j["task"]=="recent",j["game"],j["round"],j["task"]))[:limit]
    line = re.search(r"(?im)^\s*(?:export\s+)?openrouter_api_key\s*=\s*(.+)$",
                     (base.REPO/".env.local").read_text(encoding="utf-8-sig"))
    if not line:
        raise RuntimeError("Missing OpenRouter key")
    key = line[1].strip().split(" #")[0].strip().strip("\"'")
    stop = threading.Event()

    def fetch(job):
        body = request_body(job["body"])
        req = urllib.request.Request(URL, data=json.dumps(body).encode(), headers={
            "Authorization":"Bearer "+key, "Content-Type":"application/json", "User-Agent":"Avalon-NLU-Experiment/1.0"})
        for attempt in range(4):
            if stop.is_set():
                return
            try:
                with urllib.request.urlopen(req, timeout=300) as response:
                    answer = json.load(response)
            except urllib.error.HTTPError as exc:
                detail = exc.read().decode(errors="replace").replace(key, "[redacted]")
                try:
                    error = json.loads(detail).get("error",{})
                except ValueError:
                    error = {}
                meta = error.get("metadata") or {}
                print("OpenRouter",exc.code,str(error.get("message","Request error"))[:300],flush=True)
                temporary_reservation = exc.code==402 and meta.get("reason")=="in_flight_budget_exhausted"
                if (temporary_reservation or exc.code in (429,502,503,504)) and attempt<3:
                    retry = exc.headers.get("Retry-After") or (meta.get("headers") or {}).get("Retry-After","0")
                    stop.wait(max(int(retry) if str(retry).isdigit() else 0, 5*2**attempt))
                    continue
                stop.set()
                return
            receipt = {"input_digest":fingerprint(job), "transport":"OpenRouter", "openrouter":answer,
                       "request":body}
            try:
                receipt["response"] = normalize(answer)
            except (ValueError,KeyError,TypeError):
                atomic(OUT/"openrouter-errors"/job["game"]/f'q{job["round"]}'/(job["task"]+".json"),receipt)
                stop.set()
                raise
            atomic(job["path"], receipt)
            print(job["game"],job["round"],job["task"],answer["usage"].get("cost"),flush=True)
            return

    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        list(pool.map(fetch,todo))
    outcomes(schedule)
    return int(stop.is_set())


if __name__ == "__main__":
    cli = argparse.ArgumentParser()
    cli.add_argument("--limit", type=int, default=206)
    cli.add_argument("--workers", type=int, default=6)
    args = cli.parse_args()
    raise SystemExit(run(args.limit,args.workers))
