# 视频标注规格 v3：按组队分 block 的 input–label 对

> 本版依据 `docs/claude-code-video-agent-pair-revision.md`，取代 [v2 时间线](#5-输出契约三件分开的产物都在忽略目录下)**面向模型的呈现格式**；v2 的时间线、文字稿、X/Y 保留为**审计与兼容出口**，语义要求仍按 v2（不抽语义标签）。更早的语义标注版在 [SPEC.v1-semantic.md](./SPEC.v1-semantic.md)。证据层、缓存、修正、序号、防泄漏条款全部继续有效。

**默认交付物**是一对文件：

- `input.zh.txt` —— 一份按**每次组队**分 block 的中文对局正文，就是实际发给模型的那个字符串；
- `label.json` —— 与它配对、单独存放的逐座位真实身份，只用于评分。

底层仍是同一条时间线：block 只是把 `assemble()` 的输出重新分组，不新增任何事实（§9）。解读发言是被测 agent 的事，不是标注的事。

---

## 1. 范围

**在范围内**
1. 烧录字幕的准确转写，归属到说话人座位，并按发言轮次分组。
2. 实际发车（队长、第几轮、第几次组队，有证据才填）、逐座位票型、显式的车过了/车被否、任务结果与失败牌数（可见才填）。
3. 实际对局需要的其它客观公开动作（湖中女神令牌转移、刺杀），**有证据才记**。口头宣称的湖中结果仍是发言原文，不提升为事实。
4. 最终逐座位身份，单独存放，带来源与核验状态。
5. 一条有序公开时间线、由它生成的中文可读文字稿、由它投影出的截止点 agent 输入。

**不在范围内**：支持/指控、跳身份/否认、意向车、转述立场、推断意图、逻辑解释、推断阵营等语义标签。这些话语**原样保留在发言里**，不抽取、不评分、不总结、不改写。玩家口头说的「我点 2345」仍是发言，除非有独立公开证据证明正式发车。

v1 的语义解析器（`speech_events.py`）只在显式配置 `speech_events.enabled: true` 时运行（仅用于复现 v1 试点）；它的产物永远不进 v2 时间线、文字稿和 X。

## 2. 证据层（沿用 v1，未改语义）

`ocr_observation/1`、`caption_segment/1`、`speaker_segment/1`、`asr_segment/1`、`utterance/1`、`board_snapshot/1`、`public_event/1`、`correction/1`、`sequence_ledger/1` 保持不变。v2 做了两处**加法兼容**：`caption_segment.flags` 增加 `similar_neighbor`；`pilot_config` 增加可选键（见 §8）。

v2 转写修复（按 run 配置启用，旧 run 不受影响）：
- `ocr.empty_line_fallback`：仅识别模式返回空文本但裁剪里有墨迹时，改用检测+识别再读一次（修复单字「呃」漏读）。
- `captions.merge_policy = short_part_v2`：相邻相似字幕只有在其中一段是短于 `short_s` 的动画/淡入碎片时才合并；两段都长则保留为两条并标 `similar_neighbor`（修复剪辑改一个字被合并）。完全相同的相邻显示仍合并（那是同一条字幕的持续显示）。

## 3. 发言轮次

**轮次（turn）**＝同一说话人一次连续的发言，通常跨多张字幕卡。不是「某座位在本轮任务里的全部发言」。

**轮次部分（turn part）**＝时间线上的一条发言记录。一次发言中间插入了客观事件时，事件前后是同一 `turn_id` 下的两个部分，事件留在它真实的位置，词不重复、不丢。

切分规则（`vbench/timeline.py: assemble`），对每张字幕卡只看它之前的记录：

| 与上一张有效字幕卡的关系 | 结果 | `boundary_before.reasons` |
|---|---|---|
| 第一张 | 新轮次 | `start` |
| 座位不同 | 新轮次 | `speaker_change` |
| 任一方座位未知 | 新轮次 | `unknown_speaker` |
| 间隔 > `turns.max_gap_s`（默认 4 s） | 新轮次 | `long_gap` |
| 中间有已审阅的剪辑缺口 | 新轮次 | `coverage_gap` |
| 中间有本数据集未纳入的语音片段（未审阅字幕、未审阅的无字幕 ASR） | 新轮次 | `excluded_segment_between` |
| 中间只有客观事件 | 同轮次新部分 | `objective_event` |
| 审阅修正 `break` | 新轮次 | `reviewed_break` |
| 审阅修正 `join` | 继续（换人/缺口/排除片段处拒绝 join） | — |
| 其它 | 同一部分 | — |

A→B→A 永远是三段。不因「同座位」或「同一轮任务」合并。间隔 1.5–4 s 的继续标 `long_pause` 供审阅；试点数据中说话人标签在同一人字幕之间短暂消失 0.6–3 s 是常态，不当作边界。

**文本拼接**：相邻字幕卡以一个 U+0020 空格连接，不添加、不删除标点。`text` 必须等于各段 `segments[].text` 用空格连接（构建时校验）。

**段落溯源**：每个 segment 保留 `segment_id`（= utterance_id）、原文、时间、`source_sequence`、`review_status`、`machine_text` 和 `text_origin`：

| `text_origin` | 含义 |
|---|---|
| `machine_ocr` | 机器候选，未审阅 |
| `reviewed_caption_confirmed` | 审阅对照像素确认机器文本 |
| `reviewed_caption_corrected` | 审阅改过文本（`machine_text` 保留原机器读数） |
| `reviewer_added_caption` | 机器漏掉、审阅补录 |
| `machine_asr` | 无字幕的 ASR 片段（只进 draft） |

审阅过的字幕**不是**音频核实的逐字原话；字幕覆盖不等于语音全覆盖。

**轮次边界修正** `vbench.turn_boundary_correction/1`：`annotations/<source>/turn_boundaries.<run_id>.jsonl`，只追加；记录前后两张卡的 id 与指纹（id、文本、时间、座位）；指纹变了或不再相邻 → 过期、不应用；同一边界再改须 `supersedes`。

## 4. 客观事件与时间顺序

- 时间线只接受白名单类型：`team_selection`、`vote_observation`、`vote_outcome`、`mission_outcome`、`lady_transfer`、`assassination`。
- 顺序＝不可变账本 `sequence`（剪辑视频中的公开可得顺序，宁晚勿早）。`order` 只是每次构建重新编号的展示序号，语义不同于 `source_sequence`。
- 轮次/组队次数分开保存；未知就是 `null`。规则来自证据：本视频每轮最多 3 次组队、第 3 次为必做轮（不是模拟器的 5 次规则）。
- 票型沿用 v1：缺键＝未观测，`unknown`＝看不清；显式结果单独保存，从不由票型推出；必做轮不产生票型。`fail_count: null`（未知）≠ `0`。
- **发生时间 ≠ 公开可得时间**。板面补录的行不得回填进更早的前缀。补录事件出现在其可得位置，并带 `reporting.status = retrospective` 与所属缺口 id。
- **剪辑缺口** `vbench.coverage/1`（`annotations/<source>/coverage.json`，source 级、已审阅）：`gaps[]` 带起止、描述、画面中缺失的内容、被补录的事件 key 与证据。时间线在缺口开始处插入 `coverage_gap` 记录；不编造缺失的讨论、票型或揭示时刻。`live_game_interval`（可选）之外的内容（复盘、赛后）不进 X。

## 5. 输出契约（三件分开的产物，都在忽略目录下）

### 5.1 规范化公开对局记录 `vbench.game_record/1`
`runs/<run_id>/timeline_v2/{accepted,draft}/game_record.json`：`rules` 与 `rules_basis`、`coverage`（区间、已审阅/未审阅区间、缺口、计数、说明）、`source_audit`（source_id、run、视图文件、修正文件——仅供来源侧审计）、`timeline`（speech / event / coverage_gap 三种判别记录）。每条记录带 `context`（第几轮、第几次组队、依据）；`context` 可能用到**后续**正式发车来给前面的讨论定标题，因此只用于存档和可读稿，**不进 X**。

accepted 只含 `review_status = accepted` 的记录；draft 含全部非拒绝候选并在顶层标 `draft: true`。

### 5.2 中文可读文字稿
同目录 `transcript.zh.md`，**只**由 `game_record.json` 渲染（`vbench/render.py`）：轮次/组队标题、说话人与时间范围、原话段落（以 `▍` 开头）、发车/票型/投票结果/任务结果/剪辑缺口块，未知与未观测显式写出。构建时校验：文字稿中的原话段落与 JSON 的 speech 记录逐条相同、顺序相同；事件块数量相同；每个合格 segment 恰好出现一次。不含身份，不含隐藏内容。

### 5.3 私有名单与评测标签
`annotations/<source>/private/roster_v2.json`（`vbench.private_roster/2`）：逐座位身份、阵营、`verification`、来源、跨时间一致性检查；`end_of_video_reveal` 记录是否有片尾复盘可交叉核对，不一致必须 `needs_review`，不得静默裁决。v1 的 `roles.json` 保留不动。

### 5.4 X / Y v2
- X `vbench.sample_x/2`：`runs/<run_id>/samples_v2/<dataset>/X/`。由同一个 `assemble()` 在**截止前缀上**生成后做脱敏投影：speech（不透明 `turn`、`part`、`continues_turn`、`seat`、`speaker_uncertain`、`text`）、event（`type`、`payload`、`reported_late`）、coverage_gap（固定中性提示，不含缺失内容描述）。最后一条若为发言则标 `open_at_cutoff: true`（总是标，不透露是否真的继续）。
- 截止前缀：`sequence ≤ S` 且公开可得时间 ≤ T(S) 的底层字幕卡和事件，**先截取再组装**。追加未来字幕（包括同一人正在进行的发言）不会改变已有 X 的 ID、文本、分组或成员（有测试）。
- Y `vbench.sample_y/2`：`samples_v2/<dataset>/Y/`，来自 `roster_v2.json`，带 `roster_verification`。
- X 不含：来源链接、标题、UP 主、指纹、私有名单、未来内容、语义标签、`context`、视频时间。玩家真实说出的身份词保留。

## 6. 修正迁移

新 run 的记录 hash 会变（区间、ASR、provenance），即使审阅过的事实没变。`vbench migrate-corrections` 只在**审阅判断过的字段完全一致**时（字幕：文本、显示起止、座位、资格；事件：类型、payload、读法、观测时间）把修正复制到 `corrections.<new_run>.jsonl`，并用 `evidence_refs` 指回原修正；语义标签修正、目标不存在或字段不同的修正一律不迁移并写入 `annotations/<source>/migrations/<from>__<to>.json`。v2 修复让机器自己读出的内容会使对应的旧 `add` 修正作废（报告为 superseded），需要对新记录重新审阅。

## 7. 防泄漏（沿用 v1，加两条）

- 语义事件不进时间线、文字稿、X（有测试）。
- `context` 与缺口的「缺失内容」描述只在存档与可读稿中出现，X 只给中性缺口提示。

## 8. 配置新增键（`vbench.pilot_config/1` 加法兼容）

`speech_events.enabled`、`ocr.empty_line_fallback`、`captions.merge_policy`、`turns.{max_gap_s,review_pause_s}`、`corrections.{inherit_shared,run_scoped}`、`timeline.{coverage_file}`。

---

## 9. 组队 block 与 input–label 对（v3，当前默认出口）

### 9.1 block 的定义

**一个 block ＝ 一次正式组队**，标题写「第 M 轮任务 · 第 N 次组队」，必做轮加「（强制轮）」。两个编号含义不同：M 是第几轮任务，N 是这一轮里的第几次组队，任何时候都不能把一次组队说成下一轮任务。

block 里依次是：

1. 这次组队讨论中的玩家原话，按实际发言顺序，每段 `座位号：原话`（未知说话人写 `说话人未知：`）；
2. `车主`；
3. `车队`（正式点车的队员）；
4. `上票` / `下票`，以及 `看不清`（看到了但读不出）与 `未记录`（根本没观测到）——两者含义不同，都只在非空时出现；
5. `组队结果：车过了 / 车被否`（带板面票数），显式结果缺失时写 `组队结果：未记录`，**绝不从票型反推**；
6. 只有**这辆车真的执行了任务**时才有 `任务结果`。被否的车没有这一行；发车了但原片没揭示结果写 `任务结果：未记录`；结果已知但失败牌读不出写 `失败牌：未知`，**不写 0**。

必做轮不投票，写 `投票：无需投票，强制执行`；不编造票型，也不把上一辆车的票挪过来。必做轮**有**真实发言时照常保留（本片第 1 轮必做轮就有），只有确实没有记录到发言才省略发言部分；被剪掉的写 `发言：未记录` / `发言：部分未记录`。

### 9.2 block 归属是前向推导的

下一个 block 的编号只由**已经公开**的记录决定：`vote_outcome = rejected` → 同一轮的下一次组队；`mission_outcome` → 下一轮任务第 1 次组队；必做轮的车直接执行任务。**绝不使用后面才出现的发车行来给前面的发言定标题**，因此把记录截到任何一个截止点，得到的 block 就是完整文档的截断版。

板面行自己写了轮次与组队次数。它与前向推导不一致时：

| 情况 | 处理 |
|---|---|
| 板面指向一个已存在的 block（晚到的补录行、序号被迫排在后面的票型） | 归入板面指的那个 block |
| 板面指向一个从未打开过的、更靠后的组队（前面几次组队被整段剪掉） | 把当前打开的 block 按板面重新编号 |
| 其它 | 留在当前 block |

三种情况都写进 `audit.json` 的 `conflicts`，不静默裁决。

`derive_context()`（v2 用来给存档时间线加标题）**会**看后面的发车行，因此它的结果只进存档与可读稿，不进 block 和 input。

### 9.3 正文里不许出现的东西

时间码、字幕卡 / 轮次 / 事件 ID、`sequence`、part、〔续〕、OCR/ASR、审阅状态、证据路径、schema、来源链接、BVID、标题、UP 主、图像、私有身份、剪辑缺口长说明、迁移与修正日志、以及任何身份推断 / 立场标签 / 预先替 agent 做的总结。

`vbench/validate.py` 两道检查同时把关：`agent_blocks_errors()` 查结构化 block，`input_text_errors()` 直接查将要发出去的字符串（正则拦时间码、`utt-`/`evt-` 之类的 ID、URL、BV 号、`OCR`/`ASR`/`sequence` 等词）。

**玩家自己说出的身份词照常保留**（「我是忠臣啊过了」是原话，不是标签）。玩家昵称若出现在原话里也保留——改写原话就是伪造记录——但会在 `nickname_mentions` 里报出来，由评测方决定要不要去标识化。

### 9.4 截止点

先按截止点过滤底层字幕卡与事件（`sequence ≤ S` 且公开可得时间 ≤ T(S)），**再**构建 block。绝不先建完整 block 再截 block 数量——那会把同一个 block 的未来票型、任务结果和后续发言带进早期输入。

未完成的 block 只写当时已知的内容，不透露还剩多少。没有内容的空 block 不输出。追加未来发言、补录历史板面结果、或修改私有身份，都不改变既有截止点的 input 字节（有测试）。

早期发言不因为省 token 被截断或摘要；缩小上下文只靠删审计字段和重复结构。

### 9.5 文件与契约

```
runs/<run_id>/agent_pairs_v3/
  full/{input.zh.txt, label.json, blocks.json, audit.json}
  cutoffs/<sample_id>/{input.zh.txt, label.json, blocks.json, audit.json}
  instruction.zh.txt      固定任务指令，与公开事实文档分开
  manifest.json           vbench.agent_pair_manifest/1：样本 ID、配对、来源/划分、截止点、内容 hash、字符/字节数
  size_report.json        与旧 archival JSON、旧 X 的大小对比
  draft/…                 draft 数据集的同一套
```

- `vbench.agent_blocks/1`（`blocks.json`）：脱敏后的结构化 block。`render_input()` **只**接受这个文档，所以正文里不可能出现它没有的字段。
- `vbench.agent_label/1`（`label.json`）：逐座位 `role` / `side` / `verification`，稳定的 `role_enum`，`input_sha256` 指回配对的正文，以及 `optional_targets`：`assassin_seat`、`assassination_target_seat`、`assassination_hit`、`winning_side` —— **只有公开画面真的给出时才填，否则 null，不猜**。赛后玩家口头说的胜负不是揭示，不作为 label。
- `vbench.agent_pair_audit/1`（`audit.json`）：每个 block 的每一段对应哪些 `item_id` / `segment_id` / `source_sequence`，哪些事件、哪些缺口、哪些冲突；`excluded` 列出区间内没被任何 block 收进去的记录和原因；`open_questions` 是待复核清单。**审计映射不进 input。**
- token 数：没有可离线使用的目标模型 tokenizer，`tokens` 与 `tokenizer` 一律为 `null`，`tokens_measured: false`。**字符数不是 token 数**，文件大小也不证明一定放得进上下文窗口。

### 9.6 与 v2 出口的关系

`timeline_v2/`（`game_record.json` + `transcript.zh.md`）与 `samples_v2/`（X/Y）保留，定位改为**审计与兼容出口**：前者是带时间码、证据与轮次结构的存档，后者是旧格式的 JSON 样本。两者与 block 共用同一个 `assemble()`，因此不会在事实上互相矛盾。大的存档 JSON 永远不会改名当成精简输入使用。

---

## 10. 第二个来源：线上客户端局（v3.1，加法）

第二个视频（`BV12beJ69E8W`，线上赛）证明**不能假设同一 UP 主的布局和规则相同**。这一节记录该来源新增的机制；所有条款都是加法，离线圆桌局的行为不变。

### 10.1 逐来源确认，不套用

`scripts/probe_layout.py` 从视频自己的像素量出字幕条、标签框、面板和名单条的位置，并在已知布局的旧来源上回归验证过。实测两个来源差异很大：字幕条 y 从 900 变成 842，标签框宽度从 256 变成 382，右侧从「拍摄的实体记录板」变成「游戏客户端日志」，而且本局**有湖中女神**、每轮人数是 3/4/4。

### 10.2 像素级脱敏 `redact`

区域矩形有时**无法避开**答案。本片的发言人标签框写的是 `<座位>号 <昵称> [<身份>]`（「9号 陈述句 派西维尔」），还会写「拇指牌」；文字**居中**排版，所以没有任何固定子矩形能只框住座位号。

`layout.regions[].redact = {"mode": "keep_first_ink_run", …}` 只保留第一段墨迹（即 `<n>号`），其余像素清零。顺序是硬要求：

1. `presence_map()` 在**未脱敏**的裁剪上判断叠层是否存在（脱敏后白底比例会塌掉）；
2. `apply_redactions()` 之后，OCR、差分、缓存键和保存的裁剪**都只看到脱敏版**。

`redact` 进 `region_config_sha()`，所以改脱敏参数会让缓存失效。`parse_label()` 允许座位号前后有脱敏残留的杂字（`電3号時` → 3 号），但仍然拒绝越界座位。

### 10.3 客户端日志 `vbench/client_log.py`

`layout.regions[].parser = "client_log"` 选用它。它输出和 `board.py` **完全相同**的 `missions` 结构，因此快照、事件去重、锚定、下游契约全部复用。

差异只在读法：行文本是 `<n>号队长提名 → a·b·c` 加右对齐的 `否决组队 x:y` / `通过组队 x:y` / `自动通过` / `投票中 n/10`；逐座位票是**填充色块**（同意绿 H≈64、反对红 H≈6、未投票白 S<60 V>225），不是彩色数字；任务结果是 `任务投票: 成功 m · 失败 n`。`自动通过` 即必做轮，`forced=True` 且不产生票型。

**含答案的行会被丢弃**：`湖中仙女 / 阵营获胜 / 刺杀 / 匕首 / MVP` 开头的行只记 warning，绝不变成公开事件——这个面板在对局结束后仍然挂在屏幕上。

### 10.4 剪辑层面的答案泄漏（本片三处）

| 位置 | 处理 |
|---|---|
| 发言人标签框里的身份与「拇指牌」 | 像素级 `redact`（§10.2） |
| 底部席位条在刺杀段与赛后显示全部身份 | 区域标为 `private` |
| 全屏编导卡（「派西维尔」「拇指牌为2号和6号」） | 在 `excluded` 的镜头区内 |

另外两条靠 `live_game_interval` 挡住：**片头预告**（本片 0–238 s，画面上写着「正片跳转至3分58秒」，内容是后面的片段乱序重放）和**刺杀讨论 / 赛后**（本片 1269.5 s 之后，字幕直接说「刺客选择刺杀梅林」「我的刀口进9」）。

### 10.5 客户端的「系统」提示不是发言

标签框读到 `系统` 时，字幕是客户端公告（`本轮任务需要4位玩家`、`队长9号选择…`、`必做任务`、`无需投票`、`组队通过`）。它们是客观事实而**不是玩家发言**，标为 `editorial`：同样的事实已经以客户端日志事件进入记录，渲染成「说话人未知：…」会凭空造出一个说话人。

### 10.6 接受字幕的两级证据

没有独立第三方转写时，**不得声称测出了字幕召回率**。本片的 `accepted` 分两级，各自在修正的 `note` 里写明：

- **独立通道佐证**：OCR 文本与本地 ASR（音频，另一个模态）在配置的 CER 下一致，且无数字/否定告警 —— 不代表有人看过；
- **CC 自审**：其余全部渲染成校对表，对照公开裁剪逐行读过。

两者都不是独立第三方审阅。
