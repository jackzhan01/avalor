# 交接：在计算节点上用「欺骗训练」模型跑阿瓦隆身份推断

更新于 2026-11-25 · 代码在 `dev` 分支 · 数据另行私下传（见 §1）

我们已经用 Gemini、Qwen3-32B、Jev 三个 API 模型，在 42 局真人对局的 145 个轮末上做过身份推断。这一步要回答的是：**练过欺骗/隐瞒的模型，识破真人伪装的能力有没有变？** 做法是把调研里四个能拿到权重的模型和各自的底座放在同一批任务上，配对比较。任务、评分、客户端都已备好，节点上只需要起推理服务、跑完、评分。

## 0. 先读这三条

1. **十人局只能用 v2。** `yuanzhuo22-preprocess-v1`、`experiments/ten-rounds-v1/` 以及 v1 的 `manifest.json` 里 `games[].roles` 的顺序都泄漏底牌：只看板子名单的顺序和派西的两个拇指位，就能在 22/22 局认出梅林。修复版是 `yuanzhuo22-preprocess-v2`，最省事的是直接用 `role-tasks-v1/tasks.jsonl`，里面十人局全部来自 v2。原因与验证过程见 [评审报告 §1](reports/avalon-experiment-peer-review.md) 和 [release_yuanzhuo22_v2.py](video-benchmark/scripts/release_yuanzhuo22_v2.py)。
2. **答案只在 `evaluator/` 里，推理端不读它。** `tasks.jsonl` 不含任何底牌；`run_openai_compatible.py` 只读 `tasks.jsonl`。推理节点上可以不放 `evaluator/`，评分换一台机器做也行。
3. **每个微调模型都和自己的底座配对比较。** 同一批任务、同样的解码设置、同样的样本数。跨模型家族比高低不是这次要回答的问题。

## 1. 拿代码和数据

```bash
git clone https://github.com/jackzhan01/avalor.git && cd avalor
git switch dev && git pull --ff-only origin dev
```

仓库是公开的，`research/data/` 被 `.gitignore` 排除，**数据不在 git 里，也不要提交进去**。数据包 `avalon-role-benchmark-v1.tar.gz`（3.3 MB）由仓库主人私下传给你：

```bash
# 校验后解压到 research/data/，包内保留了相对路径
sha256sum avalon-role-benchmark-v1.tar.gz
# 5231e5b02e05cea118644362aa06a8709fce70db74c07c8f5782f442a512bd6a
mkdir -p research/data && tar -xzf avalon-role-benchmark-v1.tar.gz -C research/data
```

包里有：

| 路径（相对 `research/data/`） | 内容 |
|---|---|
| `role-tasks-v1/tasks.jsonl` | **723 个任务**，直接喂模型 |
| `role-tasks-v1/evaluator/labels.jsonl` | 答案，仅供评分 |
| `video-benchmark/releases/yuanzhuo22-preprocess-v2/` | 十人局 22 局修复版发布包：输入、指令、清单、标签、审计链 |
| `avalon-nlu/releases/avalon-nlu-full-v1/` | 六人局 20 局发布包 |
| `avalon-nlu/upstream/` | Avalon-NLU 原始数据（MIT 许可） |
| `video-benchmark/experiments/ten-rounds-v2/plan.json`，`avalon-nlu/experiments/gemini-4-hydrogen-full-v1-medium/*/request.json` | 重新生成任务所需的冻结请求 |

自检（不联网、不花钱）：

```bash
cd research/video-benchmark/scripts
python release_yuanzhuo22_v2.py --verify     # 应输出 {"games": 22, "pairs": 112, "distinct_composition_lines": 2}
python export_role_tasks.py --out /tmp/role-tasks-check
cmp /tmp/role-tasks-check/tasks.jsonl ../../data/role-tasks-v1/tasks.jsonl && echo 任务一致
```

如果要自己改提示、加新变体，从 `export_role_tasks.py` 改，不要手改 `tasks.jsonl`。

## 2. 任务是什么

每行一个任务：`task_id`、`dataset`、`players`、`language`、`game`、`round`、`task`、`variant`、`messages`（OpenAI 格式的 system + user）、`json_schema`（输出约束）。

| dataset | task | variant | 数量 | 模型看到什么 | 要输出什么 |
|---|---|---|---:|---|---|
| `avalon-nlu-6p`（英文线上） | `roles` | `full` | 82 | 旁观者视角：截至本轮的全部聊天和系统事件（点车、票型、任务结果） | 每个座位一个身份 |
| | `roles` | `actions` | 82 | 同上，但**删掉了玩家聊天**，只剩系统事件 | 同上 |
| | `percival` | `asc` / `desc` | 82 + 82 | 派西视角：自己的座位、两个拇指位、截至本轮的**全部**玩家发言（不含系统事件） | `first_percent`：第一个候选人是梅林的概率 |
| | `recent` | `asc` / `desc` | 62 + 62 | 同上，但只给**本轮**发言（第一轮与 `percival` 相同，故省略） | 同上 |
| `yuanzhuo22-10p-v2`（中文录像转写） | `roles` | `full` | 63 | 旁观者视角 | 每个座位一个身份 |
| | `percival` | `asc` / `desc` | 63 + 63 | 派西视角，累计发言 | `first_percent` |
| | `recent` | `asc` / `desc` | 41 + 41 | 派西视角，仅本轮发言 | `first_percent` |

- `asc` 与之前 API 实验发出的提示逐字节相同（候选按座号从小到大）；`desc` 只把两个候选对调。**两种顺序都要跑**：Jev 在六人局 82 次里有 67 次选第二个候选，单看 `asc` 会误以为它会认梅林，按位置平衡后只有 47%。
- `roles/actions` 是新加的对照：比较 `full` 和 `actions`，可以看出全桌任务的提升有多少来自聊天、多少来自行动本身。
- 十人局有 2 局是含执剑人、破壁人的特殊板，`json_schema` 的枚举会随板子变化。

## 3. 在节点上跑

任何兼容 OpenAI `/v1/chat/completions` 的服务都能用。vLLM 的例子：

```bash
# 完整权重
vllm serve Qwen/Qwen3-8B --max-model-len 32768 --port 8000
# LoRA 适配器挂在底座上；同一个服务可以同时提供底座（--model 用底座名）和适配器（--model lying）
huggingface-cli download invi-bhagyesh/qwen3.8-27b-lying-organism-sft-v1 --local-dir adapters/lying
vllm serve Qwen/Qwen3.8-27B --enable-lora --max-lora-rank <按适配器 config 里的 r> \
    --lora-modules lying=adapters/lying --max-model-len 32768
```

```bash
cd research/video-benchmark/scripts
python run_openai_compatible.py --tasks ../../data/role-tasks-v1/tasks.jsonl \
    --out ../../data/role-runs/qwen3-8b-base.jsonl \
    --base-url http://localhost:8000/v1 --model Qwen/Qwen3-8B --samples 3 --workers 8
```

- **可续跑**：输出按 `(task_id, sample)` 去重，作业被杀掉后重跑同一命令即可接着跑。
- `--filter '^nlu6/'` 只跑六人局，`--filter '/roles/'` 只跑全桌任务，先拿小子集试通。
- 默认带 `response_format: json_schema`（vLLM 走结构化解码）。**所有模型统一开或统一关**；关掉时用 `--no-schema`，评分脚本会从原文里抠最后一个 JSON 对象。
- Qwen3 系的思考开关：`--extra-body '{"chat_template_kwargs": {"enable_thinking": true}}'`。底座和微调版必须一致，并写进结果说明。
- 长度：最长输入约 1.4 万 token（Qwen 分词），开思考时输出最多约 7.4k，所以 `--max-model-len` 至少 24k，建议 32768。`--max-tokens` 默认 8192。
- 显存粗估：27B 的 bf16 权重约 54 GB，8B 约 16 GB，3B 约 6 GB，还没算 KV cache。
- 输出放在 `research/data/role-runs/`（已被忽略），**不要提交**。每个文件对应一个模型配置，文件名写清模型和设置。

## 4. 评分

```bash
python score_role_tasks.py --data ../../data/role-tasks-v1 \
    --pred ../../data/role-runs/qwen3-8b-base.jsonl --pred ../../data/role-runs/qwen3-8b-makto.jsonl \
    --compare ../../data/role-runs/qwen3-8b-makto.jsonl ../../data/role-runs/qwen3-8b-base.jsonl \
    --out ../../data/role-runs/scored
```

统计单位是**局**：先在每局内平均各轮和各样本，再让各局等权，区间来自按局重抽样 3000 次。`--compare A B` 给出同一批局上 A − B 的配对差和区间。无效输出单列为 `valid_rate`，不会被悄悄丢掉。

主要看这些：

- **全桌（`roles`）**：`role` 具体身份准确率、`side` 阵营准确率、`within` 阵营判对的座位中具体身份也对的比例、`merlin` 标为梅林的座位确实是梅林的比例。`side` 主要靠行动就能涨，`within` 和 `merlin` 才更依赖读发言。
- **派西（`percival` / `recent`）**：优先看 `order-averaged` 这一行（同一轮末两种顺序取平均概率后再评分），以及 `logloss` 和 `brier`。`accuracy` 中五五开记 0.5，只作辅助。`balanced_accuracy` 是按梅林排第一和排第二分别算再平均。

## 5. 建议的对比与做法

调研里的四个候选及其底座（详见 [模型调研](reports/avalon-model-survey.html)）：

| 微调模型 | 配对的底座 | 要回答的问题 |
|---|---|---|
| Qwen3.8-27B Lying Organism（LoRA） | Qwen/Qwen3.8-27B | 练过隐瞒自身行为，会不会更会识破伪装 |
| Qwen3-8B MaKTO Public SFT（中文狼人杀 SFT） | Qwen/Qwen3-8B | 社交推理游戏的训练能否迁移到阿瓦隆，尤其是中文十人局 |
| Inkling-Small Obvious Lies（23 个 LoRA） | thinkingmachines/Inkling-Small | 原版、故意答错版、修复版三方对照 |
| Qwen2.5-3B Poisoned Deploy | Qwen/Qwen2.5-3B-Instruct | 后门训练是否影响正常读牌（优先级最低） |

开跑前请自己核对每个模型卡的许可和 vLLM 支持情况，上表只来自调研页，没有实机验证。

- **先定主指标再看结果。** 建议主指标是六人局 `percival` 的 `order-averaged` 对数损失和十人局 `roles` 的 `role`，配对差的区间不含 0 才算有差异。其余是探索性的。
- **每份输入至少抽 3 次**，温度 1.0、`top_p` 1.0，底座和微调版完全一致。
- **不要在这 42 局上调提示。** 这批局已经是测试集，按分数改提示再报这批局的分数就不干净了。要调就另找局。
- **六人局数据是公开的**（Avalon-NLU 自 2023 年起在 GitHub 上，答案在同一个 JSON 里），模型可能见过。一个免费的检查：第一轮全桌准确率若明显高于机会水平，就要怀疑记忆。Gemini 第一轮是 17.5%，低于机会水平。

## 6. 参照数字

六人局，API 模型，每份输入抽一次，按局等权：

| 模型 | 全桌具体身份 | 全桌阵营 | 派西准确率 | 派西位置平衡 | 派西 Brier | 派西对数损失 |
|---|---:|---:|---:|---:|---:|---:|
| Gemini 4 Hydrogen | 37.1% | 74.2% | 63.3% | 62.2% | 0.194 | 0.547 |
| Qwen3-32B | 30.6% | 68.7% | 49.4% | 48.7% | 0.272 | 0.80 |
| Jev 1.14 | — | — | 54.1% | 47.2% | 0.242 | 0.67 |
| 无信息基线 | 22.2% | 55.6% | 50% | 50% | 0.25 | 0.693 |

十人局的无信息基线：常规板全桌身份 22%、特殊板 16%，阵营 52%。**十人局 v1 的 API 结果有泄漏，不要拿来比较**；v2 的 API 重跑还没做（见 §8）。

「只给行动」对照的结果（Gemini，六人局）：*运行中，完成后补在这里。*

## 7. 已知的坑

- **位置偏好**：见 §2。只报 `asc` 的派西结果会被位置偏好污染。
- **全桌提升大多来自阵营判断**：Gemini 六人局全桌准确率从第一轮 17.5% 升到第三轮 40.0%，但阵营内部的具体身份和梅林指中率在第三轮之前都停在机会水平。别把 `role` 的上涨直接说成「读懂了发言」。
- **十人局转写**：录像画面上有制作方的身份叠层。清洗转录时看没看到叠层、会不会因此带入身份信息，**还没有核查**。
- **十人局录像会缺轮**：部分录像在整局结束前就截断了，所以第四、五轮只有 4 局和 1 局。不要按轮画学习曲线，比较时用同时有两轮的同一批局做配对。
- **小模型的 JSON**：关掉结构化解码时，3B 这类小模型的无效率可能很高。要报 `valid_rate`，并说明解码方式。

## 8. 文件地图与未完成事项

| 文件（`research/video-benchmark/scripts/`） | 作用 |
|---|---|
| `export_role_tasks.py` | 从冻结计划生成 `tasks.jsonl` 和 `labels.jsonl` |
| `run_openai_compatible.py` | 通用客户端，只读任务、可续跑 |
| `score_role_tasks.py` | 按局评分、位置平衡、两种顺序平均、配对比较 |
| `release_yuanzhuo22_v2.py` | 由 v1 构建并验收十人局 v2 |
| `ten_rounds_v2.mjs` | 十人局 API 重跑；冻结前做底牌交换不变性检查 |
| `nlu_actions_only.py` | 六人局「只给行动」对照（API） |
| `nlu_rounds.py`、`nlu_gemini_baseline.py`、`nlu_openrouter.py` | 六人局 API 实验的构造与调用 |
| `ten_rounds.mjs` | **v1 泄漏版**，只为复现旧结果保留 |

测试：`cd research/video-benchmark && python -m pytest`（离线；含发布包验收和客户端到评分的端到端测试）。

未完成：

- 十人局 v2 的 API 重跑（Gemini / Qwen / Jev），计划已冻结，等仓库主人确认费用（历史约 $10.4）后再跑。
- 评审报告里十人局的结论要按 v2 结果改写。
