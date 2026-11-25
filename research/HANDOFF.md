# 交接：在计算节点上用「欺骗训练」模型跑阿瓦隆身份推断

更新于 2026-11-25 · 代码和数据都在 `dev` 分支，数据集在 [`research/benchmark/`](benchmark/)

我们已经用 Gemini、Qwen3-32B、Jev 三个 API 模型，在真人对局的轮末快照上做过身份推断（六人局 20 局、十人局 20 局）。这一步要回答的是：**练过欺骗/隐瞒的模型，识破真人伪装的能力有没有变？** 做法是把调研里四个能拿到权重的模型和各自的底座放在同一批任务上，配对比较。任务、评分、客户端都已备好，节点上只需要起推理服务、跑完、评分。

## 0. 先读这三条

1. **十人局只能用 v2。** 早先的 v1 把板子说明里的身份顺序写成了和座位相关的顺序：只看名单顺序和派西的两个拇指位，就能在 22/22 局认出梅林。`research/benchmark/` 里只有修复后的 v2：所有身份列表一律按固定顺序「梅林、派西维尔、忠臣、莫德雷德、莫甘娜、刺客、奥伯伦」。原因与验证过程见 [评审报告 §1](reports/avalon-experiment-peer-review.md) 和 [release_yuanzhuo22_v2.py](video-benchmark/scripts/release_yuanzhuo22_v2.py)。
2. **答案只在 `labels/` 和 `tasks/evaluator/` 里，推理端不读它们。** `tasks/tasks.jsonl` 不含任何底牌；`run_openai_compatible.py` 只读 `tasks.jsonl`。
3. **每个微调模型都和自己的底座配对比较。** 同一批任务、同样的解码设置、同样的样本数。跨模型家族比高低不是这次要回答的问题。

## 1. 拿代码和数据

```bash
git clone https://github.com/jackzhan01/avalor.git && cd avalor
git switch dev && git pull --ff-only origin dev
```

数据集随仓库提供，在 [`research/benchmark/`](benchmark/)（约 10 MB），说明见那里的 README：

| 路径（相对 `research/benchmark/`） | 内容 |
|---|---|
| `tasks/tasks.jsonl` | **697 个任务**，直接喂模型 |
| `tasks/evaluator/labels.jsonl` | 答案，仅供评分 |
| `avalon-nlu-6p/` | 六人局 20 局：整局输入、指令、标签、MIT 许可证 |
| `yuanzhuo-10p/` | 十人局 20 局（v2）：整局及各截止点输入、指令、标签、清单 |

完整性自检（不联网、不花钱）：

```bash
cd research/benchmark
python -c "import json,hashlib,pathlib; bad=[p for p,h in json.load(open('sha256.json')).items() if hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()!=h]; print('ok' if not bad else bad)"
```

`research/benchmark/` 由 `publish_benchmark.py` 从仓库主人本地的私有数据生成，**不要手改**。要换提示或加变体，请联系仓库主人重新生成；你自己的模型输出放在 `research/data/role-runs/`（被 `.gitignore` 排除），不要提交。

## 2. 任务是什么

每行一个任务：`task_id`、`dataset`、`players`、`language`、`game`、`round`、`task`、`variant`、`messages`（OpenAI 格式的 system + user）、`json_schema`（输出约束）。

| dataset | task | variant | 数量 | 模型看到什么 | 要输出什么 |
|---|---|---|---:|---|---|
| `avalon-nlu-6p`（英文线上） | `roles` | `full` | 82 | 旁观者视角：截至本轮的全部聊天和系统事件（点车、票型、任务结果） | 每个座位一个身份 |
| | `roles` | `actions` | 82 | 同上，但**删掉了玩家聊天**，只剩系统事件 | 同上 |
| | `percival` | `asc` / `desc` | 82 + 82 | 派西视角：自己的座位、两个拇指位、截至本轮的**全部**玩家发言（不含系统事件） | `first_percent`：第一个候选人是梅林的概率 |
| | `recent` | `asc` / `desc` | 62 + 62 | 同上，但只给**本轮**发言（第一轮与 `percival` 相同，故省略） | 同上 |
| `yuanzhuo22-10p-v2`（中文录像转写） | `roles` | `full` | 57 | 旁观者视角 | 每个座位一个身份 |
| | `percival` | `asc` / `desc` | 57 + 57 | 派西视角，累计发言 | `first_percent` |
| | `recent` | `asc` / `desc` | 37 + 37 | 派西视角，仅本轮发言 | `first_percent` |

- `asc` 与之前 API 实验发出的提示逐字节相同（候选按座号从小到大）；`desc` 只把两个候选对调。**两种顺序都要跑**：Jev 在六人局 82 次里有 67 次选第二个候选，单看 `asc` 会误以为它会认梅林，按位置平衡后只有 47%。
- `roles/actions` 是新加的对照：比较 `full` 和 `actions`，可以看出全桌任务的提升有多少来自聊天、多少来自行动本身。
- 十人局全部是常规十人板。节目里另有 2 局用了含执剑人、破壁人的变体板，这两个身份的能力没有记录，已排除。
- 十人局发言里玩家之间的人名、外号和称呼已换成所指的座位号（如「8号」）；转写判断不出是谁的，换成「某位玩家」。

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
python run_openai_compatible.py --tasks ../../benchmark/tasks/tasks.jsonl \
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
python score_role_tasks.py --data ../../benchmark/tasks \
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
- **不要在这 40 局上调提示。** 这批局已经是测试集，按分数改提示再报这批局的分数就不干净了。要调就另找局。
- **六人局数据是公开的**（Avalon-NLU 自 2023 年起在 GitHub 上，答案在同一个 JSON 里），模型可能见过。一个免费的检查：第一轮全桌准确率若明显高于机会水平，就要怀疑记忆。Gemini 第一轮是 17.5%，低于机会水平。

## 6. 参照数字

六人局，API 模型，每份输入抽一次，按局等权：

| 模型 | 全桌具体身份 | 全桌阵营 | 派西准确率 | 派西位置平衡 | 派西 Brier | 派西对数损失 |
|---|---:|---:|---:|---:|---:|---:|
| Gemini 4 Hydrogen | 37.1% | 74.2% | 63.3% | 62.2% | 0.194 | 0.547 |
| Qwen3-32B | 30.6% | 68.7% | 49.4% | 48.7% | 0.272 | 0.80 |
| Jev 1.14 | — | — | 54.1% | 47.2% | 0.242 | 0.67 |
| 无信息基线 | 22.2% | 55.6% | 50% | 50% | 0.25 | 0.693 |

十人局的无信息基线：全桌身份 22%，阵营 52%。**十人局 v1 的 API 结果有泄漏，不要拿来比较**；v2 的 API 重跑还没做（见 §8）。

「只给行动」对照（Gemini 4 Hydrogen，六人局全桌任务，2026-11-25，$8.57）。同一批次、同一通道：完整输入新抽 1 次，删掉聊天的输入抽 2 次，另附历史上的 1 次完整输入。主比较在开跑前写进了 `plan.json`。

| 轮 | 局数 | 完整输入（新） | 只给行动 | 完整输入（历史） |
|---|---:|---:|---:|---:|
| 1 | 20 | 24.2% | 21.2% | 17.5% |
| 2 | 20 | 31.7% | 24.2% | 26.7% |
| 3 | 20 | 40.0% | 31.3% | 40.0% |
| 4 | 16 | 49.0% | 33.9% | 56.2% |
| 5 | 6 | 80.6% | 43.1% | 83.3% |

- 第一到三轮的提升，大约 2/3 只靠行动就有：只给行动组也从 21% 升到 31%，阵营准确率从 58% 升到 78%。
- 前三轮发言的额外贡献很小：主比较 +6.4pp [+0.7, +12.1]，勉强过线；换成历史那一次完整输入只有 +2.5pp [−3.1, +8.2]。两次完整输入之间本身就差 3.9pp，所以每份输入只抽一次不够。
- 前三轮旁观者的梅林指中率两组都在机会水平，差 −3.3pp。
- 全部轮次合计，发言带来 +10.0pp [+4.6, +15.9]，两次完整输入都显著，主要在第四、五轮阵营内的具体身份上。但能打到第四、五轮的只有 16 局和 6 局，存在样本选择。
- 原始回执、计划和汇总在仓库主人本地的 `research/data/avalon-nlu/experiments/gemini-hydrogen-actions-only-v1/`，需要的话向他要。

## 7. 已知的坑

- **位置偏好**：见 §2。只报 `asc` 的派西结果会被位置偏好污染。
- **全桌提升大多来自阵营判断**：Gemini 六人局全桌准确率从第一轮 17.5% 升到第三轮 40.0%，但阵营内部的具体身份和梅林指中率在第三轮之前都停在机会水平。别把 `role` 的上涨直接说成「读懂了发言」。
- **十人局转写**：录像画面上有制作方的身份叠层。清洗转录时看没看到叠层、会不会因此带入身份信息，**还没有核查**。
- **十人局录像会缺轮**：部分录像在整局结束前就截断了，所以第四、五轮只有 4 局和 1 局。不要按轮画学习曲线，比较时用同时有两轮的同一批局做配对。
- **小模型的 JSON**：关掉结构化解码时，3B 这类小模型的无效率可能很高。要报 `valid_rate`，并说明解码方式。

## 8. 文件地图与未完成事项

| 文件（`research/video-benchmark/scripts/`） | 作用 |
|---|---|
| `export_role_tasks.py` | 从冻结计划生成 `tasks.jsonl` 和 `labels.jsonl`（需要私有数据） |
| `publish_benchmark.py` | 把私有数据按白名单组装成 `research/benchmark/`，并检查路径、外号、变体身份（需要私有数据） |
| `run_openai_compatible.py` | 通用客户端，只读任务、可续跑 |
| `score_role_tasks.py` | 按局评分、位置平衡、两种顺序平均、配对比较 |
| `release_yuanzhuo22_v2.py` | 由 v1 构建并验收十人局 v2：去变体局、固定身份顺序、外号换座位号、去绝对路径 |
| `ten_rounds_v2.mjs` | 十人局 API 重跑；冻结前做底牌交换不变性检查 |
| `nlu_actions_only.py` | 六人局「只给行动」对照（API） |
| `nlu_rounds.py`、`nlu_gemini_baseline.py`、`nlu_openrouter.py` | 六人局 API 实验的构造与调用 |
| `ten_rounds.mjs` | **v1 泄漏版**，只为复现旧结果保留 |

测试：`cd research/video-benchmark && python -m pytest`（离线；含发布包验收和客户端到评分的端到端测试）。

未完成：

- 十人局 v2 的 API 重跑（Gemini / Qwen / Jev，20 局 57 个轮末），计划已冻结，等仓库主人确认费用（按历史单价约 $9.3）后再跑。
- 评审报告里十人局的结论要按 v2 结果改写。
