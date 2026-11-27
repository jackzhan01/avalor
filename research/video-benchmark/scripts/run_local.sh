#!/usr/bin/env bash
# Serve one model with vLLM on the given GPUs, send the role tasks to it, then stop the server.
#
#   run_local.sh <run-name> <hf-id> <gpus> [extra vllm serve args...]
#   run_local.sh qwen3-32b-think Qwen/Qwen3-32B 0,1
#   CLIENT_MODEL=lying run_local.sh qwen3.8-27b-lying-think Qwen/Qwen3.8-27B 0,1 \
#       --enable-lora --max-lora-rank 32 --lora-modules lying=<adapter dir>
#
# Env: PORT (8000), CLIENT_MODEL (model name sent by the client; defaults to <hf-id>),
#      REASONING_PARSER (qwen3; set empty for models without a thinking mode), FILTER, EXTRA_BODY,
#      VLLM (vllm binary), HF_HUB_CACHE (/archive/huggingface/hub).
# Output: research/data/role-runs/<run-name>.jsonl, logs in research/data/role-runs/logs/.
# Resumable: rerunning the same command only sends the tasks not yet answered.
set -euo pipefail
[ $# -ge 3 ] || { sed -n '2,15p' "$0"; exit 2; }
name=$1 model=$2 gpus=$3
shift 3

here=$(cd "$(dirname "$0")" && pwd)
research=$(cd "$here/../.." && pwd)
out=$research/data/role-runs
mkdir -p "$out/logs"

port=${PORT:-8000}
vllm=${VLLM:-$HOME/venvs/vllm/bin/vllm}
parser=${REASONING_PARSER-qwen3}
# Only the cells we report: whole-table roles with chat, and Percival in both candidate orders.
default_filter='/(roles/full|percival/(asc|desc))$'
default_body='{"chat_template_kwargs": {"enable_thinking": true}}'
filter=${FILTER:-$default_filter}
body=${EXTRA_BODY:-$default_body}
tp=$(awk -F, '{print NF}' <<<"$gpus")

# <gpus> uses nvidia-smi indices. When a GPU is down, CUDA skips it and renumbers the rest, while NVML
# still counts it, so plain indices point at different cards. UUIDs mean the same card everywhere.
uuids=$(for i in ${gpus//,/ }; do
    nvidia-smi --query-gpu=index,uuid --format=csv,noheader 2>/dev/null | awk -F', ' -v i="$i" '$1==i{print $2}'
done | paste -sd,)
[ "$(awk -F, '{print NF}' <<<"$uuids")" = "$tp" ] || { echo "cannot resolve GPUs '$gpus' (got '$uuids')" >&2; exit 2; }
export CUDA_DEVICE_ORDER=PCI_BUS_ID CUDA_VISIBLE_DEVICES=$uuids
export HF_HUB_CACHE=${HF_HUB_CACHE:-/archive/huggingface/hub}
# FlashInfer JIT-compiles its sampler with the system nvcc, which is too old here (CUDA 12.0);
# the PyTorch sampler gives the same distribution.
export VLLM_USE_FLASHINFER_SAMPLER=${VLLM_USE_FLASHINFER_SAMPLER:-0}

# --generation-config vllm: ignore each repo's generation_config.json, so a base and its fine-tune
# decode identically (Qwen2.5-3B-Instruct ships top_k/repetition_penalty, its poisoned fork does not).
args=(serve "$model" --port "$port" --tensor-parallel-size "$tp" --max-model-len 32768 --generation-config vllm)
[ -n "$parser" ] && args+=(--reasoning-parser "$parser")
echo "[$(date +%T)] $vllm ${args[*]} $*" | tee -a "$out/logs/$name.server.log"
"$vllm" "${args[@]}" "$@" >>"$out/logs/$name.server.log" 2>&1 &
server=$!
trap 'kill "$server" 2>/dev/null || true; wait "$server" 2>/dev/null || true' EXIT

until curl -sf "http://localhost:$port/health" >/dev/null; do
    kill -0 "$server" 2>/dev/null || { echo "vllm exited; see $out/logs/$name.server.log" >&2; exit 1; }
    sleep 10
done

python3 "$here/run_openai_compatible.py" --tasks "$research/benchmark/tasks/tasks.jsonl" --out "$out/$name.jsonl" \
    --base-url "http://localhost:$port/v1" --model "${CLIENT_MODEL:-$model}" --samples 1 \
    --workers 32 --timeout 1800 --filter "$filter" --extra-body "$body" 2>&1 | tee -a "$out/logs/$name.client.log"
