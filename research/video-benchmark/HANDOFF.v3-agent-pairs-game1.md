# 交接给 Codex：按组队分 block 的 input–label 对

写给负责验收的 Codex。任务书：[docs/claude-code-video-agent-pair-revision.md](../../docs/claude-code-video-agent-pair-revision.md)（取代 [时间线修订版](../../docs/claude-code-video-timeline-revision.md) 中**面向用户/模型的呈现与输入格式**要求；语义范围、证据、修正、缓存、序号、防泄漏条款不变）。语义见 [SPEC.md](./SPEC.md) §9，命令见 [README.md](./README.md)。

上一版交接（v2 时间线）原样保留在 [HANDOFF.v2-timeline.md](./HANDOFF.v2-timeline.md)，更早的语义标注试点在 [HANDOFF.v1-semantic-pilot.md](./HANDOFF.v1-semantic-pilot.md)。**那两份里的结论与数字只描述各自那一版**，本文只讲这次。

**一句话结论：** 全片已经生成真实的 `input.zh.txt`（8 个 block、72 段原话、13 661 字符）和单独的 `label.json`，加上 8 个截止点的配对样本、评测方 manifest、旁路审计映射和待复核清单。95 项离线测试通过。所有质量判断仍是**同一个 agent 对着公开画面像素的自审**，不是独立审阅，也没有逐字核对音频。未提交、未推送、未改产品代码、0 次付费调用。

---

## 1. 直接打开这些文件

根目录（被忽略的数据目录）：`research/data/video-benchmark/runs/full-v2b/agent_pairs_v3/`

| 内容 | 精确路径 |
|---|---|
| **完整对局正文（发给模型的字符串）** | `runs/full-v2b/agent_pairs_v3/full/input.zh.txt` |
| **完整对局的答案（单独打开）** | `runs/full-v2b/agent_pairs_v3/full/label.json` |
| 结构化 block（正文由它渲染） | `runs/full-v2b/agent_pairs_v3/full/blocks.json` |
| 旁路审计映射 + 待复核清单 | `runs/full-v2b/agent_pairs_v3/full/audit.json` |
| 固定任务指令（与正文分开） | `runs/full-v2b/agent_pairs_v3/instruction.zh.txt` |
| 评测方清单（不随 input 发送） | `runs/full-v2b/agent_pairs_v3/manifest.json` |
| 体积对比 | `runs/full-v2b/agent_pairs_v3/size_report.json` |
| draft 数据集的同一套 | `runs/full-v2b/agent_pairs_v3/draft/` |

8 个截止点，每个目录下都是同样四件（`input.zh.txt` / `label.json` / `blocks.json` / `audit.json`）：

| 截止点 | 目录 | block | 原话段 | 字符 | UTF-8 字节 |
|---|---|---|---|---|---|
| m1 attempt 1 vote outcome | `cutoffs/p3-4b562afee5f0bacc/` | 1 | 11 | 1 854 | 4 973 |
| m1 attempt 2 vote outcome | `cutoffs/p3-7a916439c85be464/` | 2 | 23 | 4 035 | 10 835 |
| m1 mission outcome | `cutoffs/p3-47dab7265ed9eb17/` | 3 | 26 | 4 158 | 11 149 |
| m2 attempt 1 vote outcome | `cutoffs/p3-cbc6157e79e328fd/` | 4 | 37 | 6 939 | 18 623 |
| m2 attempt 2 vote outcome | `cutoffs/p3-d040e9008cf5497d/` | 5 | 48 | 9 178 | 24 593 |
| m2 mission outcome | `cutoffs/p3-b18d0c4ffa833aab/` | 5 | 48 | 9 183 | 24 604 |
| m3 attempt 1 vote outcome | `cutoffs/p3-76a93e2483320d1d/` | 6 | 58 | 11 386 | 30 392 |
| m3 attempt 3 forced team | `cutoffs/p3-ff36956dc5c6a82b/` | 8 | 69 | 13 619 | 36 230 |
| **（完整对局）** | `full/` | **8** | **72** | **13 661** | **36 350** |

**体积对比**：完整正文 36 350 字节；旧存档 `game_record.json` 767 217 字节（约 21×），旧可读稿 `transcript.zh.md` 41 618 字节，最大的一份旧 X v2 JSON 46 799 字节。**token 数未测**：这里没有可离线使用的目标模型 tokenizer，`manifest.json` 与 `size_report.json` 里 `tokens`/`tokenizer` 一律为 `null`、`tokens_measured: false`。字符数不是 token 数，文件大小也不能证明一定放得进上下文窗口。

## 2. 验收入口：前两个 block 和强制轮长什么样

**第 1 个 block**（完整 11 段原话，这里省略中间几段）：

```text
第1轮任务 · 第1次组队

10号：好那从这边发言
1号：从我发言啊 我不是派西 然后看一下是单派局还是多派对吧 先过吧
    ……（2、3、4、5、6、7、8、9 号依次发言，均为原话全文）……
10号：5号需要我回应吗 …… 所以我发车 我就前面也没有派也 没有指明车的情况下 我就发一个3 4带上我自己好吧

车主：10号
车队：3、4、10
上票：无
下票：1、2、3、4、5、6、7、8、9、10
组队结果：车被否（0:10）
```

**第 2 个 block**（12 段；末尾两段是同一个人隔了 8 秒的两次开口，不合并）：

```text
第1轮任务 · 第2次组队

1号：从这边发言 从十号发言
10号：单边派那就听派的不就好了吗过了呀
    ……（9、8、7、6、5、4、3、2 号依次发言）……
1号：现在可以表水啊 …… 所以我就点一个呃147 7号是4号给的啊
1号：是吧

车主：1号
车队：1、4、7
上票：1、4、9
下票：2、3、5、6、7、8、10
组队结果：车被否（3:7）
```

**强制轮**（第 1 轮第 3 次组队；这正是任务书点名要复核的 09:32–09:38）：

```text
第1轮任务 · 第3次组队（强制轮）

1号：不是你也可以听发言 你可以选择听发言或 或者直接点
说话人未知：我不听
1号：哈哈那你点吧

发言：部分未记录

车主：2号
车队：2、4、6
投票：无需投票，强制执行
任务结果：成功
失败牌：0
```

**上传结尾的强制轮**（第 3 轮第 3 次组队）：发车有，任务结果没有，不补造：

```text
第3轮任务 · 第3次组队（强制轮）

5号：哈哈哈
说话人未知：哎决定决定命运的时候到了
说话人未知：没事随便看
说话人未知：想想看啊

发言：部分未记录

车主：7号
车队：4、5、7、9
投票：无需投票，强制执行
任务结果：未记录
```

真实身份不贴在这里，也不贴在正文末尾。要看答案就单独打开 `full/label.json`。

## 3. 8 次组队逐一核对

| block | 原话段 | 说过话的座位（按顺序） | 车主 | 车队 | 上/下/看不清/未记录 | 组队结果 | 任务 | 缺口 |
|---|---|---|---|---|---|---|---|---|
| 第1轮·第1次 | 11 | 10,1,2,3,4,5,6,7,8,9 | 10 | 3、4、10 | 0/10/0/0 | 车被否 (0:10) | — | — |
| 第1轮·第2次 | 12 | 1,10,9,8,7,6,5,4,3,2 | 1 | 1、4、7 | 3/7/0/0 | 车被否 (3:7) | — | — |
| 第1轮·第3次（强制） | 3 | 1,未知,1 | 2 | 2、4、6 | 不投票 | — | 成功，失败牌 0 | 有 |
| 第2轮·第1次 | 11 | 3,2,1,10,9,8,7,6,5,4 | 3 | 3、4、5、7 | 4/6/0/0 | 车被否 (4:6) | — | — |
| 第2轮·第2次 | 11 | 4,5,6,7,8,9,10,1,2,3 | 4 | 3、4、5、7 | 6/4/0/0 | 车过了 (6:4) | 失败，失败牌 1 | — |
| 第3轮·第1次 | 10 | 5,6,7,8,9,10,1,2,3,4 | 5 | 3、4、8、9 | 4/6/0/0 | 车被否 (4:6) | — | — |
| 第3轮·第2次 | 10 | 6,7,8,9,10,1,2,3,4,5 | 6 | 2、4、5、6 | 3/7/0/0 | 车被否 (3:7) | — | — |
| 第3轮·第3次（强制） | 4 | 5,未知×3 | 7 | 4、5、7、9 | 不投票 | — | **未记录** | 有 |

**一个独立的归属校验**：这张桌子的规矩是**车主先发言**，然后依次绕一圈。六个普通轮 block 的第一位发言人**恰好都是该 block 的车主**（10 / 1 / 3 / 4 / 5 / 6），而 block 边界完全由「上一次投票结果 / 上一轮任务结果」前向推出，没有看过后面的发车行。两条独立线索对上了，我把它当作 block 边界正确的证据。两个强制轮的第一位不是车主——它们的组队过程都在剪辑缺口里，正文已写「发言：部分未记录」。

**普通轮没有一个是空的**：六个普通轮都保留了实际出现的十个人发言，没有补造、没有按 1–10 排序、没有把 A→B→A 压成 A→B。

**整片是否覆盖到终局：没有。** 上传在第 3 轮第 3 次组队（必做轮）发车后就切走，这辆车的任务结果、之后的进程、刺杀与最终胜负都没有公开画面。片尾**确实有约 18 秒赛后交谈**（2025.15–2043.58 s，玩家说「好狼人赢了」「结束了」「后面都狼」「把梅林再刺一下」「单边派输了」等）。这两件事不是一回事，之前的交接把它们混着写了，这里分开说清楚：**没有复盘/身份揭示画面**，但**有赛后闲聊**。这些字幕被 `live_game_interval`（0–2025.15 s）挡在对局记录之外，正文里一个字也没有，也没有拿来当 label —— 玩家随口一句不是揭示，`winning_side` 保持 `null`。

## 4. 09:32–09:38 的复核结论

旧稿把这整段 5 张字幕卡都标成 1 号。任务书要求重新查证据，结论如下。

- **公开证据只有一个**：发言人标签框从 571.95 s 到 577.68 s 是**一段没有中断的 `1Lucy`**（`speaker_segments.jsonl` 里就是一条记录）。但这个框标的是**发言权**，不跟插话走，所以它不能确认整段归属——这正是任务书说的「标签可能滞后」。
- **ASR 在这里退化**：五张卡的识别分别是「也可以听他人 / 你可以选择听发言或者 / 直接点我 / 先 / 点个」。中间两张只剩一个音节，这是语音重叠的典型样子。
- **我试了音频判别，没用**：对 575.68–576.48 s 的「我不听」做了基频与 MFCC 音色比对，参考取 1 / 2 / 3 / 10 号各自几十秒的长片段。基频中位数在 0.8 秒的中文短句上本来就随声调乱跳（相邻几张卡分别是 286 / 203 / 177 / 109 / 168 Hz），MFCC 余弦相似度则一律最靠近**时间上相邻**的那段参考（同一房间同一话筒），对说话人**没有判别力**。这是一次失败的测量，如实记在这里。
- **结论**：没有依据指认座位，也没有依据把它留给 1 号。这一张卡标 `speaker.seat = null`，前后两张保持 1 号。正文里读作 `1号 / 说话人未知 / 1号`。**没有写「2号：我不听」**——上一轮 Codex 答复里的那行只是排版示意，不是证据。
- 这是一条**只追加**的修正（`cor-b2b74c959d7d318d`，在 `annotations/src-c9be57d8e2c4/corrections.full-v2b.jsonl`），带 `evidence_refs` 指回标签段与前后两张卡，理由全文在 `note` 里；原始机器记录没有被改。作者留档在 `annotations/src-c9be57d8e2c4/authoring/full_v2b_speaker_review.jsonl`。
- **这一段属于哪个 block**：第 1 轮第 2 次组队的投票结果（3:7 被否）在账本里排在这五张卡之前，所以它们落在**第 1 轮第 3 次组队（强制轮）**——内容也对得上（在劝即将强制发车的 2 号「你可以听发言，也可以直接点」）。**没有**被当成「强制轮没有发言」删掉；「没有发言就省略」是条件规则，本片第 1 轮强制轮就有发言。

## 5. 改了什么、怎么复现

### 新增/改动路径（全部在 `research/video-benchmark/`）

```
SPEC.md                   加 §9（block 定义、前向编号、正文禁区、截止点、文件契约），v2 出口改标为审计/兼容
README.md                 默认交付物改为 input–label 对；新增 examples/ 与 agent-pairs 工作流
HANDOFF.md                本文（旧版 HANDOFF.v2-timeline.md）
vbench/blocks.py          新增：按每次组队分 block（前向编号 + 板面冲突记录 + 逐段溯源）
vbench/block_text.py      新增：脱敏 block 文档 + 正文渲染器（只接受脱敏文档）
vbench/agent_pairs.py     新增：完整/截止点的 input+label+blocks+audit、manifest、体积报告
vbench/schemas/{agent_blocks,agent_label,agent_pair_manifest,agent_pair_audit}.schema.json  新增
vbench/private_labels.py  加 build_label_v3（逐座位身份 + 只在有证据时才填的可选项）
vbench/validate.py        注册四个新 schema；新增 agent_blocks_errors / input_text_errors；
                          补上 sample_x_v2 的泄漏检查（之前 export 传了 forbidden_strings 但没人消费）
vbench/cli.py             新增 agent-pairs 子命令（--dataset / --open-question）
examples/use_input.py     新增：不联网的最小用法（发 input、单独读 label 打分）
tests/test_agent_blocks.py        新增 21 项
tests/test_samples_leakage.py     PUBLIC_MODULES 加 timeline/timeline_build/blocks/block_text/render
```

产品代码（`src/`）一行没动。数据目录里新增 `runs/full-v2b/agent_pairs_v3/`，旧的 `timeline_v2/`、`samples_v2/`、`views/`、`public/`、缓存、修正、账本全部原样保留。

### 复现（PowerShell，在 `research/video-benchmark` 下）

```powershell
$py = "..\data\video-benchmark\.venv\Scripts\python.exe"; $env:PYTHONIOENCODING = "utf-8"
$cfg = "configs\full.BV19D7565EZg.json"
& $py -m vbench build --config $cfg                           # 应用修正；序号账本不变
& $py -m vbench timeline --config $cfg                        # 存档时间线 + 可读稿
& $py -m vbench samples-v2 --config $cfg --dataset accepted   # 旧格式 X/Y
& $py -m vbench agent-pairs --config $cfg --dataset accepted  # ← 本次交付物
& $py -m vbench agent-pairs --config $cfg --dataset draft
& $py -m pytest
& $py examples\use_input.py ..\data\video-benchmark\runs\full-v2b\agent_pairs_v3
```

**没有重跑全片 OCR/ASR。** 本次完全复用 `full-v2b` 的审阅数据；`build` 这一步分配了 0 个新序号（`sequences_allocated_this_build: 0`），缓存、证据层、历史修正都没动过。

### 架构：三个出口共用一次组装

```
证据层（未变）→ 修正（只追加）→ 序号账本（只增不重排）
   ↓
timeline.assemble()   把合格字幕卡分成发言轮次/部分，交错客观事件与剪辑缺口
   ↓
   ├── game_record.json + transcript.zh.md   存档/审计（带时间码、证据、轮次结构）
   ├── build_x_v2                            旧格式 X（兼容）
   └── blocks.build_blocks()                 按每次组队重新分组
         ├─ blocks_document()  去掉一切审计字段 → render_input() → input.zh.txt
         └─ build_label_v3()   私有层，另一条路径，另一个文件 → label.json
```

渲染器只能看到脱敏文档，所以正文里不可能出现它没有的字段。截止点在**底层字幕卡与事件**上切，切完再组装再分 block——不是先建完整 block 再截数量。

## 6. 测试与验收对照

`python -m pytest` → **95 passed**（v1/v2 的 74 项全部保留，新增 21 项）。`npx tsc --noEmit` 退出码 0。`npm run check:imports` ✓。产品/模拟器测试未运行（没有改 TS 代码或共享配置）。

任务书 §7 的 12 条验收，对应的测试：

| # | 验收项 | 测试 |
|---|---|---|
| 1 | 普通组队的发言/车主/车队/票型/结果归到同一 block | `test_one_normal_proposal_carries_its_speech_leader_team_votes_and_result` |
| 2 | 被否车辆没有任务结果；下一次组队仍在同一任务轮 | `test_a_rejected_team_has_no_mission_result_and_the_next_attempt_stays_in_the_same_mission` |
| 3 | 强制轮不伪造票型；有真实对话时保留 | `test_forced_round_states_that_no_vote_is_taken_and_keeps_the_speech_it_really_had`、`test_a_forced_round_with_no_recorded_talk_omits_the_speech_section_entirely`、`test_a_round_whose_talk_was_cut_says_so_instead_of_looking_empty` |
| 4 | 最后一辆车结果未知，不补造结果/胜负/刺杀 | `test_the_last_forced_team_has_no_mission_result_no_winner_and_no_assassination` |
| 5 | A→B→A、插话、未知说话人不被合并；原话不摘要 | `test_interjections_unknown_speakers_and_aba_are_neither_merged_nor_summarised`、`test_a_contribution_split_by_an_event_is_rejoined_but_never_across_speakers_or_blocks` |
| 6 | 每条合格已接受字幕恰好一次；排除项有旁路原因 | `test_every_eligible_accepted_caption_appears_once_and_exclusions_are_listed_with_reasons`（另外每次构建都跑 `block_accounting`） |
| 7 | 票型缺失 vs 未知；失败牌未知 vs 0；显式结果优先 | `test_missing_tally_unreadable_seat_and_unknown_fail_count_all_read_differently`、`test_a_result_is_never_reconstructed_from_a_partial_tally` |
| 8 | 早期截止点不含后续点车/票型/结果；晚补不提前泄漏 | `test_a_cutoff_inside_a_block_shows_no_later_team_tally_or_result`、`test_a_late_board_row_reaches_its_own_block_but_not_an_earlier_cutoff`、`test_cutoff_documents_are_the_full_document_truncated_not_reordered` |
| 9 | 改 label、追加未来内容不改既有 input | `test_appending_future_speech_or_facts_does_not_change_an_earlier_input`、`test_changing_the_private_answer_leaves_every_input_byte_identical` |
| 10 | input 无来源标识/审计字段/私有答案；身份词保留 | `test_input_has_no_source_ids_audit_fields_or_answers_but_keeps_spoken_role_words`、`test_the_leak_check_catches_audit_material_slipped_into_a_document` |
| 11 | 实际 user message 与磁盘 input 完全相同 | `test_the_message_sent_to_the_api_is_exactly_the_file_and_the_label_is_a_separate_read` |
| 12 | 重跑确定，不改旧证据/修正/缓存/序号 | `test_rebuilding_produces_identical_bytes_and_touches_no_evidence` |

另有 `test_a_board_row_naming_an_attempt_nobody_opened_renumbers_the_block_and_says_so`（板面行与前向编号冲突时的处理）。

**这些测试证明的是机器一致性**（同一份数据在不同出口之间不矛盾、不泄漏、可重跑），不是「发言人全部独立核实」。三种把握程度必须分开看：

| | 谁做的 | 本次状态 |
|---|---|---|
| 机器一致性 | 离线测试 | 95 项通过 |
| CC 自审 | 同一个写管线的 agent，对着公开画面像素 | 字幕 / 座位 / 板面事件 / 缺口 / block 归属都是这一级 |
| 用户或独立审阅 | 人 | **没有做**。没有人听过音频，`verbatim` 全为 null |

## 7. 排除了什么、为什么

`full/audit.json` 的 `excluded` 按原因列出区间内没进任何 block 的记录（每条都带 id）：

| 条数 | 原因 |
|---|---|
| 14 | `live_game_interval` 之外的赛后交谈（同时资格为 editorial） |
| 6 | 审阅拒绝的板面淡入伪造行（未锚定） |
| 3 | 审阅拒绝的重复显示/淡出残影（未锚定） |
| 1 | 审阅拒绝且资格未知的重复显示（未锚定） |
| 1 | 无字幕的 ASR 片段（`33:31.18`「哎呀 拼命」），资格未知且未审阅 → 只进 draft |

`blocks[].paragraphs[]` 给出每一段正文对应的 `item_ids` / `segment_ids` / `source_sequences`；`blocks[].events[]` 给出每条客观事实对应的 `event_id` 与 `source_sequence`。**这些映射一个字都不进 input。**

## 8. 待复核（也写在每份 `audit.json` 的 `open_questions` 里）

1. **09:32–09:38 的「我不听」** 标为「说话人未知」而不是指给某座位（理由见 §4）。需要能听音频的人复核；如果听得出是谁，改一条 `set speaker.seat` 就够，正文会自动跟着变。
2. **第 3 轮第 1 次组队的票型序号晚于投票结果**。当初我先把票型锚在稍后的稳定快照上，后来用 `supersedes` 改回 `28:14.667`，但序号不可重排。block 已经按板面行把票型归回第 3 轮第 1 次组队（`audit.json` 的 `conflicts` 里有记录），但底层账本顺序仍是「结果在前」，存档时间线和旧 X 会照这个顺序显示。
3. **上传没到终局**：第 3 轮必做轮那辆车的任务结果、最终胜负、刺杀都没有公开画面。正文写「任务结果：未记录」，`label.json` 的 `winning_side` / `assassination_target_seat` / `assassination_hit` 全为 `null`。片尾赛后闲聊有胜负说法，但那是玩家的话不是揭示，没有采用（见 §3）。
4. **正文里出现了 1 处玩家昵称**（「小桑」，在原话里）。改写原话就是伪造记录，所以保留，但 `agent-pairs` 会把它报在 `nickname_mentions` 里；要不要去标识化由评测方决定。
5. **所有质量判断都是同一个 agent 的自审**（见 §6 的三级表）。
6. **369 条重复的 `accept` 修正**仍留在 `corrections.full-v2b.jsonl` 里，被冲突规则正确挡下（不静默覆盖）。那是上一轮我生成全片修正时的流程噪声；本次没有再生成重复修正，只追加了 1 条（§4 那条）。
7. **`label.json` 的 `role_enum` 是稳定全枚举**（8 个角色，含本局没有的 `minion`），而 `instruction.zh.txt` 只列本局构成的 7 个。这是刻意的：枚举稳定便于跨对局评分，指令则贴合本局。如果评测方希望两者一致，改 `role_enum` 的来源即可。

## 9. 已知失效模式

1. **前向编号在「整段组队被剪掉」时需要板面兜底**。规则是：板面行指向一个从未打开过的、更靠后的组队时，把当前 block 按板面重新编号，并写进 `conflicts`。本片没有触发这条（8 次组队的板面编号与前向推导全部一致），只有第 3 轮第 1 次票型那一条因为序号顺序触发了「归回板面指定的 block」。合成数据里两条路径都有测试。
2. **`发言：部分未记录` 只说明这个 block 的画面有缺口**，不说明缺了多少、缺了什么——详细说明留在 `coverage.json` 和存档时间线里。看正文的人只能知道「这里不全」。
3. **字幕就是字幕**。审阅是对着像素做的，不是对着音频；字幕覆盖不等于语音覆盖，剪辑没打字幕或切走的话根本不在记录里。
4. **昵称与自述身份词无法机器过滤**，因为它们是原话。只能报出来。
5. **残余污染风险**：公开发布过的对局可能已被模型记住，去标识化消除不了这一点。
6. v2 交接里列的失效模式（无底条字幕、板面淡入伪造行、板面滚动、单字字幕）全部仍然适用，见 [HANDOFF.v2-timeline.md](./HANDOFF.v2-timeline.md) §6。

## 10. 本次人工量

| 工作 | 量 |
|---|---|
| 读任务书 + 核查现有 timeline/samples/export 决定复用位置 | 约 25 min |
| 09:32–09:38 的证据复核（标签段、ASR、音频基频/MFCC 比对） | 约 40 min |
| 8 次组队归属逐一核对（含「车主是否为第一位发言人」这条独立校验） | 约 30 min |
| 正文格式与「未记录 / 看不清 / 未知」口径的逐条对照 | 约 25 min |
| 片尾赛后内容与 label 可选项的判定 | 约 15 min |

合计约 **2.2 h**（不含机器时间；本次没有重跑 OCR/ASR，机器部分只有几秒的重建）。v2 交接里的 3 h 是那一轮逐行校对的量，与本次不重叠、仍然有效。
