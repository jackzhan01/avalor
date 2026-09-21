# 交接给 Codex：第二局输入修订（r1）+ 第二次付费试跑

任务书：`docs/claude-code-video-agent-pair-revision.md` 的呈现契约（每次组队一个 block）继续有效。语义与文件契约见 [SPEC.md](./SPEC.md)，命令见 [README.md](./README.md)。

历史交接全部保留：[HANDOFF.v5-three-sources.md](./HANDOFF.v5-three-sources.md)（上一版，三个来源的状态）、[HANDOFF.v4-two-videos-partial.md](./HANDOFF.v4-two-videos-partial.md)、[HANDOFF.v3-agent-pairs-game1.md](./HANDOFF.v3-agent-pairs-game1.md)、[HANDOFF.v2-timeline.md](./HANDOFF.v2-timeline.md)、[HANDOFF.v1-semantic-pilot.md](./HANDOFF.v1-semantic-pilot.md)。**每份里的数字只描述它那一版。**

**一句话结论：** 第二局的输入生成器修了四个「把假设或未来信息写成观察」的缺陷，产物另存为 `agent_pairs_v3_r1`（**旧目录一字未动**，5 份旧样本哈希逐一复核相符）；新版完整正文跑了**一次** gpt-6-astra 身份推断，**$0.2293**，阵营 8/10、Brier 0.1609、具体身份 3/10。160 项离线测试通过，`tsc`、`check:imports` 通过。未提交、未推送、未改产品代码。

---

## 1. 这次修了什么

四个缺陷，性质相同：**文档把配置默认值、后文信息或「没有记录」当成观察到的事实说了出来。**

| # | 缺陷 | 旧版输出 | 新版输出 |
|---|---|---|---|
| 1 | 覆盖范围用 `len(mission_team_sizes)` 推断 | 「本记录只到第 3 轮，后面几轮的人数没有出现过」——可正文实际截止第 **2** 轮任务结束 | 规则句只说「（记录中只出现过前 3 轮的人数）」；另起一行 `本记录到第 2 轮任务结束为止。`，由**本样本自己的 block** 推导 |
| 2 | 规则假设冒充观察 | 「各轮任务判定失败所需的失败牌数依次为 1、1、1」——config 的 `basis` 里明写本片从未显示 | 该句从模型输入中删除；`fails_required` 仍留在 `rules` 里供内部校验，并进 `audit.json` 的 `rules_assumed`（带来源） |
| 3 | 提示词场景错误 | 「一份**线下**《阿瓦隆》对局」——本局是线上客户端局 | 「一份《阿瓦隆》对局」。**第一局的历史文件不改写** |
| 4 | 空发言无标记 | 强制轮既无字幕也无接受记录时**什么都不输出**，读起来像「无人发言」 | `发言：本段未见玩家发言`，与剪辑缺口的 `发言：未记录` 保持区分 |

第 1 条对截止点同样生效：四个截止点各自说自己的覆盖范围，不继承后文。

**没有破坏内部校验逻辑。** `vbench/validate.py:135` 用 `fails_required` 判「成功却出现失败牌」，这个值照常存在于 `blocks.json` 的 `rules` 里；新增的 `rules_unverified` 只决定**渲染**时省略哪几句。

## 2. 新旧产物（精确路径与哈希）

旧目录 `research/data/video-benchmark/runs/game2-v1/agent_pairs_v3/` **原样保留**，第一局全部产物和 2026-09-19 的历史试跑同样保留。

新目录：`research/data/video-benchmark/runs/game2-v1/agent_pairs_v3_r1/`

| 样本 | 旧 sample_id → 新 sample_id |
|---|---|
| **完整正文** | `p3full-4098136fb86cbc83` → **`p3full-6aeb853718376e27`** |
| m1 attempt 1 vote outcome | `p3-daff2e3c86e3f087` → `p3-39cd237c4dd9face` |
| m1 attempt 2 vote outcome | `p3-5adb3aafe1c58374` → `p3-8c924232c72b242a` |
| m1 mission outcome | `p3-ae923f8124f38d86` → `p3-cc71d2882960c678` |
| m2 attempt 1 vote outcome | `p3-cee33e806c62d294` → `p3-cfa31f6b33bf646f` |

新版完整正文 `input_sha256` = `313ba4d73b8cd266000b5f2039c31f5acf7c1eca91b8a565d1f390cb4c3490b3`；其余四份的哈希在 `manifest.json` 里。完整的新旧映射与四条变更原因写在 `agent_pairs_v3_r1/manifest.json` 的 `revision_of`（`dir`、`reason`、`sample_id_map`）。每份仍带 `input.zh.txt`、`label.json`、`blocks.json`、`audit.json`，目录根有 `instruction.zh.txt`、`manifest.json`、`size_report.json`。

**sample_id 变新的机制：** `sample_id_v3()` 新增 `revision` 参数并进入哈希键；不给 revision 时哈希键不变，所以**第一局已导出的 id 一个都没动**（有测试钉死）。`--revision r1` 同时决定输出目录名 `agent_pairs_v3_r1`，原地覆盖在结构上就不可能发生。

### 变更范围：逐份 diff 只有预期的行

| 样本 | 原话行数 旧→新 | 逐行相同 | 差异行 |
|---|---|---|---|
| FULL | 32 → 32 | 是 | 5（规则句改写、+覆盖行、+空发言标记及空行） |
| m1 a1 | 11 → 11 | 是 | 3（规则句、+覆盖行） |
| m1 a2 | 22 → 22 | 是 | 3 |
| m1 mission | 22 → 22 | 是 | 5 |
| m2 a1 | 32 → 32 | 是 | 5 |

**没有静默删掉任何发言。** 玩家原话、座位、点车、上下票、任务结果全部逐行一致。已观察到的「任务结果：成功 / 失败牌：0」照常保留——被删的只是那句未核实的**规则**断言。

旧目录完整性复核：5 份旧样本的 `input.zh.txt`、`label.json` 字节哈希与旧 `manifest.json` 记录**全部相符**。

## 3. 付费试跑（一次）

目录：`research/data/video-benchmark/api_trials/2026-09-20-gpt6-astra-game2-r1/`，完整报告 `REPORT.zh.md`。

| | |
|---|---|
| 模型（请求/返回） | `gpt-6-astra` / `gpt-6-astra` |
| 参数 | Responses API、官方 SDK、`reasoning.effort=high`、`max_output_tokens=16000`、`store=false`、无 tools/检索/浏览、SDK `max_retries=0` |
| request id | `req_97fd81c64e0345239d82cdc33f9516f6` |
| status / 耗时 | `completed`（未截断）/ 84.12 s |
| token | 输入 5589（缓存 0）、输出 3468（其中推理 2070） |
| **实际费用** | **$0.2293**（预检最坏 $1.3142，上限 $2.00） |

价格在调用当天重新核对官方页面，与 2026-09-18 记录一致（$10 / $1 / $50，长上下文 $20 / $75）。

**提示词与第一次试跑逐字节相同**（两份 `instruction.zh.txt` sha256 同为 `6330bfca34bbc0d5c9d67117fca387ff5d63b80a3f354085ccc277f585e5422c`，输出 schema 也相同）。用的是 `vbench/api_trial.py` 的那份（每座位 `evil_probability` / `predicted_role` / `evidence` / `uncertainty`），**不是** pair 目录里那份只要座位→身份的简版。`run_api_trial.py` 现在会把 instruction 的哈希一并落盘。

### 结果

| 指标 | 值 |
|---|---|
| 阵营准确率 | **8 / 10 = 0.80** |
| Brier score | **0.1609** |
| 具体身份准确率 | **3 / 10 = 0.30** |
| unknown | **5** |
| 计分座位 | 10 / 10 |

错判两处：1 号（莫德雷德读成梅林）、10 号（忠臣判成坏人，p 恰好 0.50 压线）。5 个 unknown 落在坏人 2、3、4 和好人 5、10 上——认出了坏人坑位却不区分具体角色。逐座位对照见 `REPORT.zh.md` §4 与 `scoring.json`。

### 引用属实 ≠ 推断正确

`scripts/check_trial_evidence.py`（新增，可复跑）把模型每条证据里**可机器判定**的断言交给 `blocks.json` 的客观字段求值，引用片段在实际发送的 input 里逐字节查找：

| | 通过 / 总数 |
|---|---|
| 客观断言（车队、车主、逐座位票、比分、任务结果、失败牌） | **39 / 39** |
| 逐字引用片段 | **11 / 11** |
| 判不了（读意图类），不计入通过 | 5 |

其中一条值得记：模型说 7 号「明确表示自己要占一个好人车位」，正文里 7 号说的是「就想上个车」——加强过的转述，不算通过也不算失败。**这一次它把记录读对了，身份读错了。**

### 这次实验回答了什么、没回答什么

- 这是**截至第 2 轮任务结束的公开记录身份推断**。4 次组队、32 段原话、12 条客观事件。
- **不测胜负与刺杀**：那两件事的过程不在这份记录里。
- **一次调用不能说明模型强弱**，也不与第一局的 0.20 / 0.10 直接相比（不同对局、不同长度，且第一局输入还带着后来判定为错误的覆盖说明与未核实规则断言）。

## 4. 三件事各自完成到哪一步

**不要把这三栏混起来读。**

| 环节 | 谁做的 | 第二局的状态 |
|---|---|---|
| **结构校验** | 离线脚本 + schema | **已完成**。5 份新样本全部 0 校验错；manifest / blocks / label / audit 四类 schema 全过；每份 `input_sha256` 与文件字节、与 label、与 audit 三处一致 |
| **字幕抽查** | CC 自审（同一个写管线的 agent，对着公开裁剪） | **抽样完成，非全量**。窗口内已接受的对局发言 566 条，其中 504 条有独立音频通道（ASR）佐证（`agree` 407 + `minor_diff` 97），其余 62 条靠校对表逐行读过。上一版做的分层抽查 97 条发现 1 处错误并已修（否→香），全量扫描确认非系统性。**这是抽样错误率，不是准确率** |
| **全文音频验真** | 人 | **没有做**。没有人完整听过音频，也没有独立第三方转写。因此**不报字幕召回率** |

媒体本身的验真是另一件事，已完成：`scripts/verify_media.py` 对第二局素材逐帧走完（44673/44673，verdict ok）。

上一版交接里那组「390 / 197 / 404」的字幕分档数字，本次**没有复现出同样的分母**；上表的 566 / 504 / 62 是这次按「窗口内 + 已接受 + 对局发言」重新数出来的，定义写在旁边。**以本表为准**，差异原因未追查。

## 5. 未决问题

1. **两轮成功后为何进入刺杀，仍然没有解释。** 客户端从「组队通过」(1263.52 s) → 「第2轮任务成功 4:0」(1266.02 s) → 「刺客选择刺杀梅林」(1269.82 s)，而面板从 1276 s 一直到片尾 1489 s **始终**是第 3 轮 0 次提名、任务点数 2/5。已排查完整客户端日志、片头预告面板、赛后 ASR，都没有依据。**这是过程覆盖不完整，不是已解决的问题**；input 对第 3 轮和胜负不作任何断言，五条 `open_questions` 逐份写进了 `audit.json`。
2. **湖中女神的使用时机不在记录里。** 客户端查验行（持有者→目标→身份结果）首次出现在 1270.02 s，比 `live_game_interval` 末端晚 0.5 秒。规则行只写「本局有」。
3. **第三局 `BV1kr876AEE1` 的板面事件解析仍未完成**，因此仍然没有 input–label 对。三个阻塞点见 [HANDOFF.v5-three-sources.md](./HANDOFF.v5-three-sources.md) §3：滚动板丢表头（已修）、水印遮挡第 1 轮通过行、票型色块几何未按这块板标定。其规则仍是试点值，跑全片时必须重新确认，**不要照搬另外两局**。
4. **第三局的内容级重叠检查**未做（需先抽取）。
5. **第一局（full-v2b）的产物比当前代码旧。** 它的首行仍是「# 阿瓦隆线下对局记录」，而 `DOC_TITLE` 已改为「# 阿瓦隆对局记录」；它也仍带着本次修掉的覆盖说明写法。**没有重新生成**：2026-09-19 那次付费试跑用的正是当前这份（字节一致 `e24a27db…`），重生成会改变它的 `input_sha256` 与全部 `sample_id`，切断那条溯源。是否重生成留给仓库主人决定。
6. **字幕召回率**三局都未测——没有独立转写。
7. **`speech_recorded == "empty"` 的语义边界。** 本局那个强制轮里确实有两条字幕（「组队失败」「无需投票」），但它们被判为 `editorial`（剪辑方状态提示）而排除，所以「未见玩家发言」是真实观察。但这依赖 eligibility 分类的正确性，**没有独立复核**。

## 6. 测试与检查（实际运行结果）

```
python -m pytest        → 160 passed  （此前 138 + 新增 22）
npx tsc --noEmit        → 退出 0
npm run check:imports   → ✓ 160 个文件的 import 全部指向已提交的文件
```

新增 `tests/test_agent_pairs_r1.py`，覆盖点名的八条：

| 要钉死的 | 测试 |
|---|---|
| 规则有三轮、正文只有两轮时不误报第三轮 | `test_three_mission_sizes_but_a_record_that_stops_in_mission_two` |
| 截止点不继承后续轮次覆盖说明 | `test_a_cutoff_states_only_its_own_reach`（4 个参数）、`test_full_and_cutoff_disagree_about_coverage_and_that_is_the_point` |
| 未核实规则不作为确定事实输出 | `test_an_unverified_rule_is_omitted_from_the_text_but_kept_for_the_checks`、`test_the_same_rule_is_stated_when_it_was_actually_observed`、`test_an_observed_fail_count_of_zero_survives_the_rule_being_dropped` |
| 空发言与未记录的区别 | `test_empty_and_cut_are_different_sentences`、`test_no_block_ever_claims_that_nobody_spoke` |
| label 哈希与 input 字节一致 | `test_label_hash_matches_the_input_file_bytes` |
| label / 身份 / 刺杀结局不进请求 | `test_the_request_carries_only_the_instruction_and_the_document`、`test_build_request_has_no_parameter_that_could_carry_a_label` |
| 玩家自称身份的原话不被误删 | `test_role_words_inside_original_speech_are_never_stripped` |
| 追加未来信息不改变已导出的截止点 | `test_appending_later_events_leaves_an_earlier_cutoff_byte_identical` |

一项旧测试按新契约改写：`test_a_forced_round_with_no_recorded_talk_says_none_was_seen_not_that_none_happened`（原先断言「整段不输出发言小节」，那正是缺陷 4）。

## 7. 复现

```powershell
$py = "..\data\video-benchmark\.venv\Scripts\python.exe"; $env:PYTHONIOENCODING = "utf-8"
# 重新生成修订版（写到 agent_pairs_v3_r1\，不碰 agent_pairs_v3\）
& $py -m vbench agent-pairs --config configs\game2-v1.BV12beJ69E8W.json --revision r1 `
      --revision-reason "..." --open-question "..."
# 引用核对（离线、免费、可反复跑）
& $py scripts\check_trial_evidence.py `
      ..\data\video-benchmark\api_trials\2026-09-20-gpt6-astra-game2-r1 `
      ..\data\video-benchmark\runs\game2-v1\agent_pairs_v3_r1\full\blocks.json `
      ..\data\video-benchmark\api_trials\2026-09-20-gpt6-astra-game2-r1\claims.json
# 重新评分（唯一读 label 的一步，不联网、不花钱）
& $py scripts\run_api_trial.py --score-only `
      --input ..\data\video-benchmark\runs\game2-v1\agent_pairs_v3_r1\full\input.zh.txt `
      --trial-dir ..\data\video-benchmark\api_trials\2026-09-20-gpt6-astra-game2-r1
& $py -m pytest
```
