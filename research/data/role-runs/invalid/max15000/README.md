Qwen3.8-27B base and lying-LoRA runs with max_tokens 15000 (thinking on, temperature 1.0, 2026-11-27).
Invalid: the model was still thinking when it hit the cap on 340/417 (base) and 312/417 (lying) tasks,
so most rows have no answer. Replaced by the *-wordlimit runs (max_tokens 8192 plus a word limit in the
system message). all-summary.json and score-*.txt are the scoring that included these two files.
The 8192-cap partial run from before this one is ../qwen3.8-27b-think.max8192-partial.jsonl.
