# 交接给 Codex：第三局付费试跑完成，三局各一次

任务书：`docs/claude-code-video-agent-pair-revision.md` 的呈现契约（每次组队一个 block）继续有效。语义与文件契约见 [SPEC.md](./SPEC.md)，命令见 [README.md](./README.md)。

历史交接全部保留：[HANDOFF.v7-game3-pairs.md](./HANDOFF.v7-game3-pairs.md)（上一版，第三局 input–label 对的生成过程）、[HANDOFF.v6-game2-r1-trial.md](./HANDOFF.v6-game2-r1-trial.md)、[HANDOFF.v5-three-sources.md](./HANDOFF.v5-three-sources.md)、[HANDOFF.v4-two-videos-partial.md](./HANDOFF.v4-two-videos-partial.md)、[HANDOFF.v3-agent-pairs-game1.md](./HANDOFF.v3-agent-pairs-game1.md)、[HANDOFF.v2-timeline.md](./HANDOFF.v2-timeline.md)、[HANDOFF.v1-semantic-pilot.md](./HANDOFF.v1-semantic-pilot.md)。**每份里的数字只描述它那一版。**

**一句话结论：** 第三局跑了**一次** gpt-6-astra 身份推断，`completed`、**$0.2826**，阵营 10/10、Brier 0.0839、具体身份 4/10。提示词与输出 schema 和第二局逐字节／逐结构相同（比对过，非假设）。引用核对：客观断言 63/63、逐字引用 14/15（1 条张冠李戴）。**顺带给第二局报告追加了一处勘误**（我上次的审核错了）。179 项离线测试通过，`tsc`、`check:imports` 通过。未提交、未推送、未改产品代码。累计付费调用 **3** 次。

---

## 1. 实验目录与输入哈希

`research/data/video-benchmark/api_trials/2026-09-20-gpt6-astra-game3-v1/`

| | 值 |
|---|---|
| input | `runs/game3-v1/agent_pairs_v3/full/input.zh.txt`（**原产物未改动**） |
| input sha256 | `40c8dde6e82f7c9cb092975d8c7dbac09ad2ec04c1afa5cb7ae79b7c2cfe69b6` |
| sample_id | `p3full-4f66354c16660919` |
| instruction sha256 | `6330bfca34bbc0d5c9d67117fca387ff5d63b80a3f354085ccc277f585e5422c` |

报告 `REPORT.zh.md`，预测 `prediction.json`，评分 `scoring.json`，引用核对 `claims.json` / `evidence_check.json`。

### 调用前的离线预检（全部通过，0 项失败）

哈希三处一致（input 字节 = label = audit = manifest）；四类 schema 0 错；覆盖说明「本记录到第 4 轮任务结束为止。」由本样本自己的 block 推导，与最后一个 block（第4轮第1次）一致；表头不提第 5 轮，`mission_team_sizes=[3,4,4,5]`，无「线下」「本记录只到第 3 轮」等他局文案；未核实的 `fails_required` 不入正文；无制作方身份揭示、无私有昵称名单、无刺杀答案、无审计字段、无时间码；玩家原话里的身份自述保留（14 行）。

**昵称「Lucy」「拉拉」在正文里，但全部在玩家自己的原话中**——管线报告但不改写。

## 2. 与第二局的设置一致性（比对过，不是假设）

| 项 | 基准（`2026-09-20-gpt6-astra-game2-r1`） | 本次 | 结论 |
|---|---|---|---|
| instruction 字节 | sha `6330bfca…` | sha `6330bfca…` | **逐字节相同** |
| 输出 schema | `request_config.json` 的 `text.format` | 当前 `build_request()` 产出 | **canonical JSON 相同** |
| 每座位字段 | evidence / evil_probability / predicted_role / seat / uncertainty | 同 | 相同 |
| 模型 | gpt-6-astra | gpt-6-astra（返回同名） | 相同 |
| reasoning.effort | high | high | 相同 |
| max_output_tokens | 16000 | 16000 | 相同 |
| store / tools / retries | false / 无 / 0 | false / 无 / 0 | 相同 |

用的是 `vbench/api_trial.py` 那份提示词，**不是** pair 目录里只要「座位→身份」的简版；没有针对第三局身份答案做任何定制。全新请求，不带前序会话或 response ID。

## 3. 费用与结果

| | |
|---|---|
| request id | `req_b36101846fc04fccb47d06681ad99a06` |
| status / 耗时 | `completed`（未截断）/ 99.84 s |
| token | 输入 8228（缓存 0）、输出 4007（推理 2588） |
| **实际费用** | **$0.2826**（预检最坏 $1.3670，上限 $2.00） |

价格调用当天重新核对官方页面，与前两次一致。调用前确认 `api_trials/` 无第三局目录、无运行中的调用进程。

| 指标 | 值 |
|---|---|
| 阵营准确率 | **10 / 10 = 1.00** |
| Brier score | **0.0839** |
| 具体身份准确率 | **4 / 10 = 0.40** |
| unknown | **4**（全部落在坏人阵营 1、2、5、6） |

**判定阈值说明：本次没有恰好 0.50 的概率。** 离阈值最近的是 4 号 0.42（判好，对）和 2 号 0.57（判坏，对）——这两个只是勉强落在各自一侧，阵营满分里含这两个接近抛硬币的判断，不能说成模型「明确认狼」。两处身份错判都在好人侧，3 号与 10 号正好互换（忠臣↔梅林）。

## 4. 引用核对

`scripts/check_trial_evidence.py`，可复跑：

| | 通过 / 总数 |
|---|---|
| 客观断言（车队、车主、逐座位票、比分、任务结果、失败牌） | **63 / 63** |
| 逐字引用片段（含先后顺序判定） | **14 / 15** |
| 判不了（读意图类），不计入通过 | 9 |

**唯一未通过的一条：** 模型说 5 号「未执行 7 号指定的 3、7、8、9」。5 号确实没跟 7 号的指示、改组 3、5、7、9 并把自己放进去（这两点单独核对通过），但**「3789」在正文里第一次出现是在 5 号那次提名之后**——7 号在那个时点说的是「直接加8吧」。行为对，车队名张冠李戴。

为此给核对器加了 `quote_before` 判定：一段只在后文出现的话，不可能是别人早先照着做的依据。有 6 项新测试。

### 给第二局报告追加了勘误（我上次审核错了）

第二局报告 §5 说模型对 7 号「明确表示自己要占一个好人车位」是「加强过的转述」。**这个判断是错的**：当时只检索了 7 号第一次发言（「就想上个车」），漏掉了第三次发言里的「但是我一个好人车位 **我肯定是要占一个车位的**」。

已按「不静默覆盖」处理：
- 原 `claims.json` / `evidence_check.json` **保持不动**；
- 订正版另存 `claims.erratum.json` / `evidence_check.erratum.json`（逐字引用 11/11 → **13/13**，undecidable 5 → **4**）；
- `REPORT.zh.md` 末尾追加勘误章节，原文不改。

第二局的评分（阵营 8/10、Brier 0.1609、身份 3/10）不受影响——订正只涉及「引用是否属实」。

**本次所有涉及「某座位说过什么」的断言，都检索了该座位在全文里的全部发言。** 几条乍看像编造实则属实的：1 号「离场没听讨论」→「出去回微信了 …… 因为我也没有听」；2 号「狼坑开在1、10里面」→ 正文写作「狼坑开在 1 10里面」（编者在两位数座位号前留空格），逐字不同实质一致；9 号「自称梅林」→「我因为我是梅林」（9 号真实身份是忠臣，模型把它当作未经验证的自述处理，是对的）。

## 5. 未验证 / 未决

1. **本局可能存在未识别的剪辑删减。** 247–1797 s 内没有超过 6 秒的字幕间隔，跳剪会同时带走音频、ASR 也看不出来；1550 秒装 4 轮任务、7 次组队偏短。因为没有记录 gap，正文不带「发言：部分未记录」标记——**记录可能把剪掉的发言呈现为连续，模型看到的可能不是完整讨论**。
2. **全文音频验真未完成。** 没有人完整听过音频，也没有独立第三方转写。588 条字幕靠独立音频通道（ASR）佐证，265 条只有「裁剪上写的就是这些字」这一条通道。**不报字幕召回率。**
3. **三局结果只是各一次试跑，不能据此推断模型总体能力。**

   | | 第一局 | 第二局 r1 | 第三局 |
   |---|---|---|---|
   | 阵营准确率 | 0.20 | 0.80 | 1.00 |
   | Brier | 0.3501 | 0.1609 | 0.0839 |
   | 身份准确率 | 0.10 | 0.30 | 0.40 |
   | 记录覆盖 | 到第3轮第3次组队 | 到第2轮任务结束 | 到第4轮任务结束 |
   | block / 原话行 | 8 / 72 | 4 / 32 | 7 / 63 |
   | 已揭晓的任务结果数 | 2 | 2 | **4** |

   对局不同、长度不同、覆盖范围不同、可用证据量不同（第三局有 4 个任务结果，是另外两局的两倍），而且第一局的输入还带着后来判定为错误的覆盖说明与未核实规则断言。**单次采样、无重复、无多模型对比。每格只是一次试跑。**
4. **第三局的五个截止点没有跑**，本次只跑完整正文。
5. **第一局（full-v2b）的产物比当前代码旧**，未重新生成——2026-09-19 的试跑用的正是当前这份，重生成会切断溯源。
6. **`fails_required` 在第三局只观察到第 3 轮**；配置里的 `[1,1,1,2]` 是标准规则，列入 `unverified`，不进模型输入。
7. **第二局的「两轮成功就进刺杀」仍未解释**（见 [HANDOFF.v6-game2-r1-trial.md](./HANDOFF.v6-game2-r1-trial.md) §5.1）。

## 6. 测试与检查（实际运行结果）

```
python -m pytest        → 179 passed  （此前 173 + 新增 6）
npx tsc --noEmit        → 退出 0
npm run check:imports   → ✓ 160 个文件
```

新增 `tests/test_trial_evidence.py`：客观断言从 blocks 求值、记录里没有的轮次判失败而不是通过、引用逐字节匹配、**`quote_before` 抓出只在后文出现的引用**、读意图类永不记为通过、undecidable 不计入任何一栏。

## 7. 复现

```powershell
$py = "..\data\video-benchmark\.venv\Scripts\python.exe"; $env:PYTHONIOENCODING = "utf-8"
$t  = "..\data\video-benchmark\api_trials\2026-09-20-gpt6-astra-game3-v1"
$in = "..\data\video-benchmark\runs\game3-v1\agent_pairs_v3\full\input.zh.txt"
# 预算预检（不发请求）
& $py scripts\run_api_trial.py --input $in --trial-dir $t --dry-run
# 引用核对（离线、免费、可反复跑）
& $py scripts\check_trial_evidence.py $t `
      ..\data\video-benchmark\runs\game3-v1\agent_pairs_v3\full\blocks.json $t\claims.json
# 重新评分（唯一读 label 的一步，不联网、不花钱）
& $py scripts\run_api_trial.py --score-only --input $in --trial-dir $t
& $py -m pytest
```
