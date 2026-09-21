# 交接给 Codex：按时间顺序的真人对局记录（时间线修订版）

写给负责验收的 Codex。任务书：[docs/claude-code-video-timeline-revision.md](../../docs/claude-code-video-timeline-revision.md)（取代 [docs/claude-code-video-benchmark-task.md](../../docs/claude-code-video-benchmark-task.md) 的语义标注与输出格式要求）。语义见 [SPEC.md](./SPEC.md)，命令见 [README.md](./README.md)。上一版交接（语义标注试点）原样保留在 [HANDOFF.v1-semantic-pilot.md](./HANDOFF.v1-semantic-pilot.md)，其结论与数字仍然只描述那一版。

**一句话结论：** 整段上传（2043.67 s）已经跑通并逐条审阅完：一条有序时间线（玩家原话按发言轮次分组 + 客观公开事件 + 剪辑缺口）、由同一份 JSON 生成的中文可读文字稿、8 个截止点的 X/Y，以及单独存放的私有身份名单。语义标签已从默认管线移除，历史产物保留。所有质量数字仍是**我自己的临时审阅**（对着画面像素，不是音频），不是 gold。

---

## 1. 改了什么、怎么复现

### 新增/改动路径（全部在 `research/video-benchmark/`，未改产品代码，未提交、未推送）

```
SPEC.md（v2，旧版 SPEC.v1-semantic.md）  README.md（旧版 README.v1.md）  HANDOFF.md（本文，旧版 HANDOFF.v1-semantic-pilot.md）
vbench/timeline.py        轮次组装 + 客观事件 + 缺口 → 规范化记录（因果式，前缀安全）
vbench/render.py          中文可读文字稿（只读 game_record.json）
vbench/timeline_build.py  构建 + 一致性校验（文字稿↔JSON、字幕卡恰好出现一次）
vbench/migrate.py         跨 run 的修正迁移（只迁审阅字段完全一致的）
vbench/review_sheets.py   校对表（公开裁剪 + 机器文本 + 轮次边界）
vbench/report_v2.py       v2 报告
vbench/schemas/{game_record,sample_x_v2,sample_y_v2,turn_boundary_correction,coverage,private_roster}.schema.json
configs/layout.yuanzhuo-1080p-v2.json   增加 subtitle_plain（无底条字幕）区域、标签门控 requires_any
configs/full.BV19D7565EZg.json          全片 run（full-v2b）
configs/full-v2-superseded.BV19D7565EZg.json  中间 run（full-v2，缺无底条字幕）
tests/test_timeline_v2.py  17 项新测试
改动：pipeline/captions/ocr/layout/changes/views/corrections/samples/export/cli/validate/paths/review
```

### 架构（相对 v1 的变化）

```
证据层（未变）：scan → OCR → 字幕段/发言人段/板面快照 → ASR → 话语候选 → 板面事件候选
                 ↓ 修正（只追加，按 run 分文件）+ 序号账本（只增不重排）
timeline.assemble()  把合格字幕卡按“一次连续发言”分组：
   换人/未知说话人/间隔>4s/剪辑缺口/被排除片段 → 新轮次
   中间只有客观事件 → 同一轮次的下一个部分（事件留在真实位置）
   ↓ 同一个 assemble() 同时供三个出口，保证三者不会互相矛盾
   ├── game_record.json（存档：含时间、证据、轮次上下文）
   ├── transcript.zh.md（可读：由 JSON 渲染，构建时校验一致性）
   └── build_x_v2（先按截止点截取底层字幕/事件再组装 → 脱敏投影）
```

语义抽取（`speech_events.py`）默认关闭，只有 v1 试点配置显式打开；它的事件永远不会进入 v2 时间线/文字稿/X（有测试）。

### 依赖

与 v1 相同（见 `requirements.lock.txt`），新增 `pillow==11.0.0`（只用于校对表渲染中文）。Python 3.11.9 / Windows 11 / RTX 4060。无新增 npm 依赖。

### 复现（PowerShell，在 `research/video-benchmark` 下）

```powershell
$py = "..\data\video-benchmark\.venv\Scripts\python.exe"; $env:PYTHONIOENCODING = "utf-8"
& $py -m pip install -r requirements.lock.txt
$cfg = "configs\full.BV19D7565EZg.json"
& $py -m vbench extract --config $cfg                     # OCR/ASR 走缓存
& $py -m vbench migrate-corrections --config $cfg --from-config configs\pilot.BV19D7565EZg.json
& $py -m vbench corrections-import --config $cfg --run-scoped --file <审阅修正>.jsonl --reviewer 名字
& $py -m vbench build --config $cfg
& $py -m vbench timeline --config $cfg
& $py -m vbench samples-v2 --config $cfg --dataset accepted
& $py -m vbench samples-v2 --config $cfg --dataset draft
& $py -m vbench report-v2 --config $cfg
& $py -m pytest
```

本次审阅用到的留档脚本都在 `annotations/src-c9be57d8e2c4/authoring/`：`sheet_fixes.py`（把校对表上的行号+正确文本变成修正）、`derive_full_v2b_corrections.py`（接受/去重/赛后标记/板面事件决定）、`full_v2b_review.jsonl`（逐行校对结果）。

---

## 2. 实际跑了什么

| 阶段 | 状态 |
|---|---|
| 试点重建（0–637 s，不重跑 OCR/ASR） | **已完成**：`runs/pilot-cycle1/timeline_v2/`；v1 的视图/样本/报告先整体归档到 `runs/pilot-cycle1/history/v1-semantic/` |
| 全片抽取 | **已完成**：run `full-v2b`，2043.58 s，扫描 61.7 s + OCR 56.3 s（127 次调用、2640 次缓存命中、3 次空文本回退）+ ASR 缓存命中（冷跑 265.9 s），合计 122.9 s，0 校验错误 |
| 修正迁移 | **已完成**：427 条 → 迁移 398，语义标签跳过 23，审阅字段不同 5，被机器新读数取代 1 |
| 全片审阅 | **已完成**：637–2043.58 s 共 26 张校对表 / 860 行逐行核对；0–637 s 重新审阅 v2 修复改动的 13 条 |
| 客观事件审阅 | **已完成**：22 条接受并锚定，6 条动画伪造行拒绝 |
| 时间线 + 可读稿 + X/Y | **已完成**：accepted 与 draft 各一套，8 个截止点 |
| 私有名单 | **已完成**：`private/roster_v2.json`，10 座位在全片 8 个时刻一致 |
| 片尾身份揭示交叉核对 | **不可用**：上传在第 3 轮必做轮处结束，没有复盘画面（已如实记录在 `end_of_video_reveal`） |
| 湖中女神 / 刺杀事件 | **已实现、未触发**：整局没有湖中女神；刺杀发生在视频之外 |
| 玩家视角样本 | **明确拒绝**（不是占位） |
| 逐字语音参考 | **没有做**：没人听音频；字幕就是字幕，`verbatim` 全为 null |
| 付费调用 | **0** |

中间 run `full-v2`（布局 v1）保留但已被取代：它漏掉了无底条字幕，其迁移产物移到了 `migrations/superseded-corrections.full-v2b-layout-fix.jsonl`。

---

## 3. 产物路径（都在被忽略的 `research/data/video-benchmark/` 下）

| 内容 | 路径 |
|---|---|
| **全片规范化记录（accepted）** | `runs/full-v2b/timeline_v2/accepted/game_record.json` |
| **全片中文文字稿（accepted）** | `runs/full-v2b/timeline_v2/accepted/transcript.zh.md` |
| 草稿版（含 1 条未审阅的无字幕 ASR） | `runs/full-v2b/timeline_v2/draft/` |
| X / Y（8 个截止点 × 2 数据集） | `runs/full-v2b/samples_v2/{accepted,draft}/{X,Y}/` |
| 证据层与公开裁剪 | `runs/full-v2b/public/` |
| 校对表 + 索引 | `runs/full-v2b/review/sheets_v2/` |
| v2 报告 | `runs/full-v2b/reports/timeline_v2_report.{json,md}` |
| 试点 v2 重建 | `runs/pilot-cycle1/timeline_v2/{accepted,draft}/` |
| v1 试点归档 | `runs/pilot-cycle1/history/v1-semantic/` |
| 修正（按 run） | `annotations/src-c9be57d8e2c4/corrections.full-v2b.jsonl`、`corrections.pilot-cycle1.jsonl`、`corrections.jsonl`（v1 试点） |
| 剪辑缺口 / 审阅范围 / 迁移报告 | `annotations/src-c9be57d8e2c4/coverage.json`、`review_scope.full-v2b.json`、`migrations/` |
| **私有身份名单** | `annotations/src-c9be57d8e2c4/private/roster_v2.json`（v1 的 `roles.json` 保留） |
| 评测方清单 | `evaluator/manifest.json`、`evaluator/sources/src-c9be57d8e2c4.json` |

来源：`source_id = src-c9be57d8e2c4`，视频 sha256 `c9be57d8e2c4f80ef0627a0eb1e3bf913f016384eb76f5c72615f4b6a53bdd70`，对局 `game-8b5b797604`，`group grp-pilot-1`，split `dev`。

**分离**：公开抽取只读三类白名单区域（黄条字幕、无底条字幕、发言人标签、历史板）；名单是私有区域、镜头区被排除；文字稿与 X 不含身份、昵称、来源、视频时间（X 还不含轮次上下文）。X 抽查：`BV19 / bilibili / 圆桌 / src- / game- / 昵称 / 赛后赛果` 均不出现；玩家自己说出的身份词（如「我是忠臣啊过了」）按要求保留。

**覆盖**：审阅区间 0–2043.58 s（末 0.09 s 无字幕、未审）。对局覆盖到第 3 轮第 3 次组队（必做轮）发车为止；第 3 轮任务结果与比赛结束**不在上传里**。

---

## 4. 测试与实测质量

| 检查 | 结果 |
|---|---|
| `python -m pytest`（离线，拦截网络，不加载模型） | **74 passed**（v1 的 57 项全部保留 + v2 新增 17 项） |
| `npx tsc --noEmit` | 退出码 0 |
| `npm run check:imports` | ✓ 160 个文件（未提交，HEAD 未变） |
| 产品 / 模拟器测试 | 未运行：没有改动共享配置或 TS 代码 |

v2 新测试覆盖任务书验收清单：多张字幕卡合成一次发言；A→B→A 保持时序（含被打断后重新开口）；缺标签/长间隔/重叠/跨轮次同座位；重复真实用词保留而持续显示不重复；每张合格字幕卡在时间线中恰好出现一次；发言中间的客观事件位置正确且不吞字；被否的车、必做轮不产生票型、票型缺键 vs unknown、失败牌 unknown vs 0；板面补录与缺失画面不进入更早的 X；私有名单与未来后缀的非干扰（含“同一人继续说”时追加）；语义事件永不进入时间线/文字稿/X；文字稿与 JSON 同序同内容；重跑保留修正、ID、序号与缓存；无底条字幕只在黄条缺席时启用。

### 处理量与耗时（full-v2b，2043.58 s）

扫描 61.7 s（61,310 帧解码，10,220 次粗采样，18,220 帧转换，0 坏包）；OCR 56.3 s（127 次调用、2,640 次缓存命中）；ASR 缓存命中（冷跑 265.9 s，large-v3 fp16 GPU）；合计 122.9 s。边界精度 1 帧（0.033 s），粗采样周期 0.2 s，守卫帧 2 s（板面 10 s）。付费调用 0。

### 质量

**字幕保真度（对照 0–637 s 的独立参考转写，v1 阶段在不看 OCR 的情况下逐条从像素转写）**

| 指标 | 机器（修正前） | 修正后¹ |
|---|---|---|
| 参考字幕召回 | **372/372** | 372/372 |
| 含标点完全一致 | **357/372 (96.0%)** | 372/372 |
| 字符错误（含标点） | **15/3404 = 0.44%** | 0/3404 |
| 座位归属 | **372/372** | 372/372 |
| 合并错误（一条机器字幕盖住两条参考） | **0**（v1 为 1，v2 合并策略修好） | 0 |

¹ 修正由同一份参考推导，只能证明修正落地。

**注意（对 v1 报告的更正）**：v1 试点报的「召回 371/372」其实高估了——当时的参考转写本身漏掉了 8 条**不带黄条的白字字幕**（v1 把它们当成了“仅 ASR 片段”）。v2 补上了这类字幕；上表的 372 条参考仍是原参考集合，因此这几条既不在分子也不在分母。它们的文本已在 v2 中逐条校对。

**637–2043.58 s（校对表逐行审阅，26 张 / 860 行）**：文本修正 17 处（多为语气词「呃」被读成「呵/听」、首字漏读、破折号），座位修正 0 处，轮次边界修正 0 处。

**全片合计**：已接受字幕卡 1238；改文本 33/1238 (2.7%)；改座位 0/1238；补录 1；拒绝 4（重复显示/淡出残影）；待审 1（无字幕 ASR 片段）。

**客观事件**：审阅后 22 条；机器全部找到（22/22）；修正前字段准确 **89/94 (94.7%)**（差在两条票型首帧动画未读全、一条必做轮缺序号）；6 条动画伪造行被拒绝；锚定 22/22（其中 3 条标记为事后补录）。

**发言轮次**：accepted 68 轮次 / 72 段 / 1224 张字幕卡；1223 个相邻卡边界中审阅未发现错误（边界修正 0）。边界原因分布：换人 64、长间隔 7、客观事件 4、说话人未知 3、剪辑缺口 2、被排除片段 1。

**时间不确定性**：字幕边界 ±1 帧；事件的「公开可得时间」是审阅锚定的，锚点依据写在每条事件的 `availability.basis`（发言宣布 / 板面揭示 / 剪辑缺口中的板面补录）。

---

## 5. 给 Codex 看的具体位置

1. **长发言合成一个轮次** · `13:40.13–14:42.00` 6 号，45 张字幕卡一个轮次（`order 42`）；`12:47.30–13:39.93` 7 号 41 张；`05:08.40–05:58.33` 6 号 37 张。文字稿里是一段连续原话，JSON 里 `segments[]` 保留每张卡的原文与时间。
2. **发言中插入客观事件（同一轮次拆成多个部分）** · 1 号 `08:29.45–09:22.12` 说完点车后，`09:22.117` 的【发车】插在中间，随后 `09:22.12–09:23.78` 是同一 `turn_id` 的 part 1（文字稿标「续」）。另一处：5 号 `32:54.15–33:30.45` 被第 3 轮第 2 次组队的票型/结果拆成 3 个部分。
3. **A→B→A** · `09:31.95` 1 号「是吧」→ 投票结果 → 1 号续段 →（第二轮）3 号 `09:46.38`「我先点个车2345」→ 2 号 `09:48.65`。三段各自独立，没有合并成一段。
4. **板面转换与事后补录** · 第 1 轮：`09:37.68–09:46.38` 剪辑缺口，板面在 `09:39.42`（必做轮 2·4·6）和 `09:42.82`（任务成功）补录 → 两条事件标 `retrospective`。第 3 轮同理：`33:30.45–33:45.15` 缺口内 `33:39.58` 补出必做轮 4·5·7·9。第 2 轮任务结果相反：镜头内板面叠层在 `22:42–22:45` 现场揭示，右侧板面 `23:06.95` 才更新，因此锚定 `22:45.82`、不算缺口。
5. **截止边界** · X `m3 attempt 3 forced team`（序号 1244）末尾依次是：5 号「哈哈哈」→ 第 3 轮第 2 次组队票型/结果 → 5 号「哈哈哈」（同轮次续段）→ 剪辑缺口（中性提示）→ 必做轮发车（`reported_late: true`）。赛后的「好狼人赢了」等内容被 `live_game_interval` 挡在所有 X 之外。
6. **未知说话人** · `33:39.18–33:43.28` 三条无底条字幕，标签框此时不在画面上 → 座位 null、单独成轮次、文字稿标「说话人未知」。不猜给上一位发言人。
7. **不可变序号的代价（值得你看一眼）** · 第 3 轮第 1 次组队的【投票结果】序号 1043、【票型】序号 1044（票型最初被我锚定在稍晚的稳定快照上）。我后来把票型的锚点改回 `28:14.667`，但序号不重排，所以文字稿里结果排在票型之前，X 在该截止点也只含结果。这是「只增不重排、宁晚勿早」规则的真实后果，不是 bug。

---

## 6. 已知失效模式与未决项

1. **无底条字幕曾被整类漏掉**（v1 与 v1 的参考转写都漏了）。v2 用「白字紧贴黑描边」的掩码在黄条缺席时捕获，阈值 0.01（实测正样本 0.047–0.14，负样本 ≤0.001）。这类字幕在整片只有 14 条，但其中包含任务书举的那句例子（`05:15.00`）。**教训**：召回口径要覆盖“另一种呈现方式”，不能只按主样式定门控。
2. **板面行淡入动画会造出伪事件**：整片 28 条机器事件里 6 条是同一行的半成品副本（队员为空、无序号）。已全部拒绝，但这是需要人工判断的一类。
3. **板面会滚动**：后期快照里早期轮次的标题滚出面板，解析会把行归到「没有标题」的状态；事件只在首次出现时生成，所以结果未受影响，但后续快照会作为不同读法进入 `interpretations`。
4. **单字/极短字幕**：v2 的检测回退修好了「空文本」问题（整片触发 3 次），但 11.07 s 那条单字仍被读成「呢」（正确为「呃」），靠审阅改。
5. **我自己的两处判断需要复核**：把 2019–2023 s 的三条字幕先标成赛后、随后用 `supersedes` 改回现场发言；第 3 轮票型的锚点也改过一次。两次都留有修正链。
6. **369 条重复的 accept 修正被冲突规则挡下**：我生成全片修正时对 0–637 s 已迁移接受的记录又发了一遍 accept。规则正确地拒绝了它们（不静默覆盖），但这是我流程上的噪声，文件里会看到。
7. **未决审阅项**：1 条无字幕 ASR 片段（`33:31.18`「哎呀 拼命」，无法在不听音频的情况下确认说话人与内容）→ 只在 draft；末尾 0.09 s 未审。
8. **私有名单只有一个来源**（制作方观众名单叠层），片尾没有复盘可交叉核对；`end_of_video_reveal.available = false`。
9. **规则依据**：每轮人数只有第 1–3 轮在板面上看到；两次失败规则、湖中女神为未观察项，`rules_basis` 里写明。角色组成来自私有名单确认（对玩家是公开开局设置，但本剪辑中没有公开画面证据）。
10. **残余污染风险**：公开发布过的对局可能已被模型记住，去标识化无法消除。

### 人工量（实测，本次）

| 工作 | 量 |
|---|---|
| 637–2043.58 s 逐行校对（26 张表 / 860 行） | 约 1.5–2 h（本次由 agent 完成，人工估计相当） |
| 0–637 s 重新审阅 v2 改动的 13 条 | 约 10 min |
| 客观事件（22 条锚定 + 6 条拒绝） | 约 40 min |
| 剪辑缺口与赛后边界判定（看帧确认） | 约 20 min |
| 私有名单一致性核对 | 约 10 min |

合计约 **3 h**（不含机器时间；v1 交接里的 6–7 h 估算包含已出范围的语义标注，不再适用）。若扩展到下一个视频，机器部分冷跑约 6–7 min（全片 OCR + ASR），人工主要是逐行校对，按本片密度约 **每 10 分钟视频 25–30 min**。
