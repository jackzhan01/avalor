# 视频标注规格 v1（Avalon video benchmark）

本文件是标注语义的**权威定义**；`vbench/schemas/*.schema.json` 是它的结构版本，`vbench/validate.py` 是它的语义版本（结构校验管不到的不变量都在那里），`tests/` 是可执行证据。三者冲突时以本文件为准，并修掉另外两个。

研究数据，不是产品数据。含义上和 `src/lib/types/events.ts` 兼容（`null ≠ 3`、票型存座位级向量、结果权威不反推、只按 `sequence` 排序、私有层可整层剥离），但 schema 独立版本化，不 import 产品代码。

---

## 0. 三层与三种访问

| 层 | 内容 | 谁能读 |
|---|---|---|
| **公开证据层** `runs/<run>/public/` | 只来自白名单区域（字幕条、发言人标签、历史板）的裁剪、OCR、ASR、转写候选、公开事件候选 | 抽取、审阅、X 导出 |
| **私有答案层** `runs/<run>/private/`、`annotations/<source>/private/` | 观众名单裁剪、身份标签、整帧画面 | 只有私有标注命令和 Y 导出 |
| **评测方清单** `evaluator/` | 视频链接、标题、UP 主、source hash、样本↔对局↔划分 | 只有评测方 |

**authoring access ≠ in-game public knowledge。** 标注者看过整段视频、看过名单，这不代表玩家在那一刻知道。凡是进入 X 的东西，都必须能说明「在截止点之前，桌上的人通过公开渠道能知道」。

## 1. 标识符与版本

- 每个记录带 `schema`（如 `"vbench.utterance/1"`）。破坏性修改升主版本；校验器拒收未知版本。
- `source_id = "src-" + sha256(视频文件)[:12]`。只在评测方侧和标注目录名里用。
- `game_id`：随机不透明 ID（`game-` + 10 位 hex），首次登记时生成并存进评测方清单，之后不变。**X 只出现由它派生的不透明样本 ID。**
- 证据、OCR、字幕段、话语、事件的 ID 都是**内容派生**的（source hash + 区域 + 帧 pts + 裁剪 hash / 上游 ID）。同输入同配置重跑 ID 不变；裁剪变了 ID 就变——这正是修正「过期」检测的依据。

## 2. 原始证据与转写

### 2.1 OCR 观测 `vbench.ocr_observation/1`
一次 OCR 调用的原始输出：`region_id`、帧 `pts`/`video_time`、`crop_sha256`、`crop_rect`、引擎与模型版本、每个文本框的 `text`/`box`/`score`（**原样**；`score` 可缺，不是校准概率）、`role`（`representative` 代表帧 / `guard` 周期守卫帧）。

### 2.2 字幕段 `vbench.caption_segment/1`
字幕区域上一段**像素稳定**的显示区间 `[display_start, display_end)`（视频秒），加：
- `text`：代表帧 OCR 原文；`alternatives`：同段其它帧（守卫帧、被合并的片段）读出的不同文本，**不丢**。
- `timing`：`{ method, start_precision_s, end_precision_s }`。精度取决于采样步长与是否精修到帧。
- `flags`：`guard_mismatch`（守卫帧读出的字与代表帧不同 → 可能漏检切换）、`short`、`merged_jitter`、`empty_ocr`、`low_score`。

**时间持续去重，不做全局去重。** 相邻、间隔小于 `merge_gap_s`、文本在抖动容差内一致、发言人相同的段合并；被别的字幕或较长空白隔开的相同文本保留为两条；发言人不同的相同文本保留为两条。

**字幕显示时间 ≠ 音频词级时间。** 字幕段时间只说明「屏幕上什么时候显示」，与音频的对齐单独存（2.4 `alignment`）。

### 2.3 发言人段 `vbench.speaker_segment/1`
标签区域的稳定段：`label_text`（原文，如 `7 阿鼎`）、`seat`（能解析出 1..N 才填，否则 `null`）、`name`（原文昵称，只在公开证据层；X 不含昵称）。
**标签说明的是剪辑推到台前的发言人，不说明每个重叠的声音。** 镜头里的座位牌号经常和标签不同（反应镜头），不用镜头推断发言人。

### 2.4 话语候选 `vbench.utterance/1`
一条话语 = 一个字幕段（剪辑的断句）或一段没有字幕的 ASR 语音：
- `caption`：`{ caption_segment_id, text, alternatives, display_start, display_end, timing }` 或 `null`——**字幕转写**（剪辑后的字幕，不是逐字原话）。
- `speaker`：`{ seat | null, label_text | null, attribution, evidence_refs }`，`attribution ∈ label_stable | label_transition | no_label | reviewed`。字幕区间内标签切换 → `label_transition`，`seat` 仍留主标签但必须审阅。
- `asr`：`{ mode, text | null, audio_start | null, audio_end | null, segments }`，`mode ∈ faster-whisper | unavailable`。**音频时间和 ASR 文本单独存。**
- `alignment`：`{ status, cer, reasons }`，`status ∈ agree | minor_diff | disagree | no_asr_overlap | asr_unavailable | asr_only`；`reasons` 专门标 `numeral_mismatch`、`negation_mismatch`。**不修改任一侧让二者一致。**
- `verbatim`：`null`，除非有人真的对着音频核过（`{ text, verified_by, method }`）。本试点没有音频参考，全部为 `null`。
- `flags`：`overlap_suspected`、`uncertain_numeral`、`uncertain_negation`、`caption_only`、`asr_only`、`label_transition`。
- `eligibility`：`in_game_speech | editorial | replay | intro | unknown`。只有 `in_game_speech` 能进 X。
- `review_status`：`machine_candidate | needs_review | accepted | rejected`。

不把含糊的话改写成自信的叙述：名字、座位号、否定词、重复原样保留。

## 3. 公开游戏事件 `vbench.public_event/1`

有界事件集合（其它一律不自动抽取）：

| `type` | 含义 | 关键 `payload` 字段 |
|---|---|---|
| `team_selection` | **实际**发车（队长点的车，进入投票或必做） | `mission`, `proposal_index`, `leader_seat`, `team_seats`, `forced` |
| `intended_team` | 某人**说**想怎么点车（言语行为，不是动作） | `holder`, `team_seats` |
| `vote_observation` | 座位级票型观测，可部分 | `mission`, `proposal_index`, `votes: {seat: approve\|reject\|unknown}`；缺键 = 没观测到 |
| `vote_outcome` | **显式**的车过了 / 车被否 | `mission`, `proposal_index`, `result: passed\|rejected`, `tally_text` |
| `mission_outcome` | 任务结果 | `mission`, `result: success\|fail`, `fail_count: int\|null` |
| `role_claim` | 公开跳身份 / 反跳 | `holder`, `role`, `claimed` |
| `stance` | 表态（保/踩/好/坏/干净） | `holder`, `target_seat`, `polarity: positive\|negative`, `hedged`, `negated` |
| `lady_announcement` | 湖中女神**公开宣称**的验人结果 | `holder_seat`, `target_seat`, `announced: good\|evil\|unknown` |

硬性语义：
1. **说了 ≠ 为真。** `role_claim` / `stance` / `lady_announcement` 只记录公开言语，没有 truth 字段；湖中真实看到的阵营只在私有层。
2. **`holder` 三种：** `{kind:"speaker", seat}`（说话人自己的立场）、`{kind:"quoted", seat|null}`（转述）、`{kind:"unresolved", seat:null}`。「然后点出了十号他可能是张莫甘娜」这类句子是 `unresolved`，不当作当前发言人指控 10 号；`unresolved` 的立场不能是 `accepted`，除非审阅修正了 `holder`。
3. **票型缺失 ≠ 票型未知。** 缺键 = 没观测；`"unknown"` = 观测了但看不清。**永不从部分向量推 `vote_outcome`**（`vote_outcome` 必须有 `explicit` 证据）。完整向量与显式票数矛盾时两条都留，标 `conflict`。
4. **任务成功不证明车上全好；失败数只约束坏人数下限。** 事件里不存任何身份推论。
5. **历史板是快照，不是事件。** 事件 = 稳定快照的差分；同一行读法不一致时全部保留在 `interpretations`，标 `board_conflict`。
6. **修订与改口：** 改口是新事件，不覆盖旧事件；修正走 `corrections.jsonl`，不改机器记录。

### 3.1 序号、观测时间、公开可得时间（三件事分开）

- `observation`：`{ video_start, video_end, evidence_refs }`——在视频里**看到**它的时间。
- `availability`：`{ status: anchored | unanchored, public_at: 秒 | null, basis, evidence_refs }`——**保守的公开可得时间**：剪辑叙事里桌上的人最晚从这一刻起确定知道。
  - 话语：`public_at = display_end`（说完才算可得）。
  - 历史板派生事件：**默认 `unanchored`**。本视频的历史板是操作员录屏，会成批补录，还会**领先**剧情（见 HANDOFF）。只有审阅者在视频里找到公开揭示时刻并用 `anchor` 修正写入后才 `anchored`。`unanchored` 的事件不进任何 X。
- `sequence`：由 `sequence_ledger.json` 分配，**只增、不重排、不复用**。
  - 分配是显式步骤（`vbench sequence`），把尚未分配、`anchored` 的记录按 `(public_at, 板面行序, 记录 ID)` 排序后追加编号。
  - 记录消失（重抽后 ID 变了、被拒绝）→ 旧编号留空洞。
  - 新记录的时间位置早于已分配记录 → 仍追加更大编号，写 `ordering: { status: out_of_sequence, belongs_before_sequence: S }`。导出只在 ≥ 自己编号的截止点才包含它：**宁可晚给，绝不早给**。
  - 同一 `public_at` 无法定序 → `ordering.status = unresolved`，列出 `tied_with`。
- **不用墙钟排序，不从最终板面布局推时间。**

## 4. 修正与审阅

- `annotations/<source_id>/corrections.jsonl`：**只追加**。每条 `vbench.correction/1` 带 `correction_id`、`revision`（单调）、`target: { kind, id, content_sha256 }`（修正时看到的机器记录内容 hash）、`op`、`path`、`value`、`reviewer`、`note`、可选 `supersedes`。
- `op ∈ set | accept | reject | add | anchor`。`add` 补机器漏掉的记录（漏检字幕、板面没有但视频里播报的事件）。
- 应用规则：
  - 目标 ID 不存在 → `stale:missing_target`；目标内容 hash 变了 → `stale:content_changed`。过期修正**不应用**，进审阅队列。
  - 同一 `(target, path)` 已有生效的修正，后来的修正没写 `supersedes` 指向它 → `conflict`，不应用。**绝不静默覆盖。**
- 机器记录（`public/*.jsonl`）永不被修正改写；应用结果写到 `views/accepted/` 与 `views/draft/`。
- **默认数据集只含 `accepted`。** 草稿导出的目录名、文件名、顶层 `draft: true` 都显式标明。

审阅队列 `vbench.review_item/1`：`reasons`、时间码、公开裁剪路径、候选文本、目标 ID 与内容 hash、可直接填写的修正模板。**按比例抽「看起来干净」的记录进队列**（`clean_sample`），队列短不等于质量高。审阅产物只含公开区域裁剪；整帧和名单只在私有目录。

## 5. 私有标签 `vbench.private_roles/1`

- 每座位一条：`seat`、`role`（或 `"unknown"`）、`verification: verified | candidate | unknown`、`evidence: [{ kind, video_time, crop_sha256, observed_text }]`。
- 校验：座位唯一且覆盖 1..N；`verified` 必须有证据；`unknown` 身份必须是 `verification: unknown`；已验证身份的计数不超过 `composition`；全部验证时必须恰好等于 `composition`；证据类型没有 `by_elimination`——**不拿「剩下的身份」补齐**。
- 私有标签由独立命令处理；公开代码路径不 import 私有模块（有测试检查 import 图）。

## 6. 评测样本

### 6.1 视角
V1 只支持 `public_observer`。请求 `player:<seat>` 等任何其它视角 → 抛 `UnsupportedPerspective`，不生成占位样本。

### 6.2 截止
- 截止由**记录序号** `cutoff_sequence = S` 定义，优先取游戏事件。令 `T = public_at(S)`。
- X 包含：`sequence ≤ S`、话语 `eligibility = in_game_speech`、`availability.status = anchored` 且 `public_at ≤ T`、状态合格（accepted 数据集只要 `accepted`；草稿数据集允许候选但排除 `rejected`）。
- **跨越截止点的话语整句排除**（`display_end > T`）。
- 本版不提供百分比截止（避免分母泄露总时长）。

### 6.3 X（给被测 agent）
`vbench.sample_x/1`：`sample_id`（不透明）、`perspective`、`rules`、`seats`（只有 1..N）、`history`（按 `sequence` 排序；话语只含 `seat`、`text`、`attribution`；事件只含语义字段；不含视频时间、裁剪、source_id、昵称）。
**禁止出现：** 标题、UP 主、链接、BVID、source hash、文件名、缩略图、视频总长、最终结果、未来记录计数、身份。校验器按键名和值模式扫描。

X 必须**逐字节确定**：同样的公开前缀 → 同样的字节，与私有标签、未来后缀、私有区域像素无关（非干扰测试）。

### 6.4 Y（给评分器）
`vbench.sample_y/1`：`sample_id`、`targets.roles`（每座位 `role | "unknown"` 与 `verification`）、`coverage`（已验证座位数 / N）、`scoring_mode: full | partial`、保留字段 `evidence_refs`、`constraint_checks`（**本版不填**猜测的推理标注）。部分名单只允许部分评分。身份预测准确率不足以证明推理质量。

### 6.5 划分
按整局划分：同一局的所有前缀、机位版本、剪辑版本属于同一 `group_id` 与同一 split。本试点 = `dev`。

## 7. 防泄漏清单（强制）

1. 公开抽取只接收白名单区域（`layout` 里 `visibility: "public"` 的矩形，区域内再套 `masks`）。名单、镜头区（含座位牌、剪辑花字）一律不进。
2. 公开代码路径不加载私有文件；不把整帧传给任何公开抽取器。
3. 片头、身份揭示、剪辑花字、回放、解说 → `eligibility` 非 `in_game_speech`，不进 X。玩家真实跳身份时说出的身份词**保留**——删关键词不是防泄漏。
4. X 不含来源信息，只用不透明 ID；来源只在评测方清单。
5. **残余风险：** 公开发布过的对局可能已被模型记住，去标识化消除不了。
6. 非干扰测试：改私有标签、改未来后缀、改私有区域像素 → X 与公开裁剪逐字节不变。
