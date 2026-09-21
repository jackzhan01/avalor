# research/video-benchmark — 线下阿瓦隆视频 → 可以直接喂给模型的对局文档

把公开对局视频变成**可审计**的研究数据，最终产出一对文件：

- **`input.zh.txt`** —— 按每次组队分 block 的中文对局正文，就是实际发给模型的那个字符串（玩家原话 + 车主 + 车队 + 上下票 + 车过/车被否 + 任务结果）；
- **`label.json`** —— 与它配对、单独存放的逐座位真实身份，只用于评分，不随 input 发送。

底下还有一层可审计的证据：按发言轮次分组的时间线、中文可读文字稿、旧格式的 X/Y 样本，以及严格分离的私有名单。

```powershell
# 打开正文就能读；评测代码读同一个文件送进 API，另开 label 打分
$pairs = "..\data\video-benchmark\runs\full-v2b\agent_pairs_v3"
& $py examples\use_input.py $pairs
```

- 标注语义（当前 v3）：[SPEC.md](./SPEC.md)；v1 语义标注版：[SPEC.v1-semantic.md](./SPEC.v1-semantic.md)
- 验收材料：[HANDOFF.md](./HANDOFF.md)；v2 时间线交接：[HANDOFF.v2-timeline.md](./HANDOFF.v2-timeline.md)；v1 试点交接：[HANDOFF.v1-semantic-pilot.md](./HANDOFF.v1-semantic-pilot.md)
- 旧版 README：[README.v1.md](./README.v1.md)
- 不属于产品，不进 App 构建，不在 `npm test` 里跑。

批次流水线与服务器迁移见 [BATCH.md](./BATCH.md)：显式清单、CPU 默认、断点恢复、两道人工审核、不可覆盖发布。历史数据不会随 Git 推送；初步实验已冻结，不自动继续付费调用。

## 目录

| 路径 | 内容 | 进仓库 |
|---|---|---|
| `vbench/` | 管线代码（Python 3.11） | ✓ |
| `vbench/schemas/` | 版本化 JSON Schema | ✓ |
| `configs/` | 区域布局；`pilot.*`（v1 试点 0–637 s）、`full.*`（v2 全片） | ✓ |
| `tests/` | 离线测试 + 合成视频夹具 | ✓ |
| `examples/` | 不联网的最小用法：怎么把 input 当 user message、怎么单独读 label 打分 | ✓ |
| `../data/video-benchmark/` | venv、媒体、模型、缓存、运行产物、人工标注、评测方清单 | ✗（`research/data/` 已忽略） |

数据目录内部（v3 新增项加粗，v2 的时间线/样本保留为审计与兼容出口）：

```
runs/<run_id>/
  public/                   OCR 原始输出、字幕段、发言人段、板面快照、ASR 段、话语候选、事件候选、公开裁剪
  views/{all,draft,accepted}/  应用修正 + 序号后的视图（证据层）
  **agent_pairs_v3/full/{input.zh.txt,label.json,blocks.json,audit.json}**  默认交付物：完整对局
  **agent_pairs_v3/cutoffs/<sample_id>/…**            同样四件，按截止点
  **agent_pairs_v3/{instruction.zh.txt,manifest.json,size_report.json}**
  **agent_pairs_v3/draft/…**                          draft 数据集的同一套
  timeline_v2/{accepted,draft}/game_record.json   规范化公开对局记录（存档/审计）
  timeline_v2/{accepted,draft}/transcript.zh.md   由上面的 JSON 生成的中文可读文字稿
  samples_v2/{accepted,draft}/{X,Y}/              旧格式截止点样本（兼容）
  review/                   审阅队列、参考联络表、**sheets_v2/ 校对表**（只含公开裁剪）
  reports/                  pilot_report.* (v1)、**timeline_v2_report.* (v2)**
  private/                  名单裁剪、整帧——不链接到任何公开产物
  history/                  被 v2 重建前的 v1 产物快照
annotations/<source_id>/
  corrections.jsonl               v1 试点的修正（只追加）
  **corrections.<run_id>.jsonl**  按 run 的修正（迁移来的 + 新审阅）
  **turn_boundaries.<run_id>.jsonl**  轮次边界修正
  **coverage.json**               剪辑缺口与补录事件（source 级）
  **review_scope.<run_id>.json**  已审阅区间
  **migrations/<from>__<to>.json** 修正迁移报告
  ledgers/<run_id>.json           序号账本
  reference/reference_review.json 0–637 s 独立参考转写
  private/roles.json (v1)、**private/roster_v2.json**  私有身份
evaluator/                        manifest.json、sources/<source_id>.json
```

## Windows 环境搭建（PowerShell）

需要 Python 3.11。PyAV 自带 FFmpeg，不需要系统 ffmpeg。GPU 可选（ASR 用 CUDA 12；无 GPU 时把配置里 `asr.device` 改成 `cpu`、`compute_type` 改成 `int8`）。

```powershell
cd research\video-benchmark
python -m venv ..\data\video-benchmark\.venv
$py = "..\data\video-benchmark\.venv\Scripts\python.exe"; $env:PYTHONIOENCODING = "utf-8"
& $py -m pip install -r requirements.lock.txt -r requirements.txt
& $py -m vbench doctor
& $py -m vbench doctor --fetch-asr-model large-v3    # 一次性联网下载 ~3 GB 权重
```

## v3 工作流（全片）

```powershell
$cfg = "configs\full.BV19D7565EZg.json"
& $py -m vbench acquire --config $cfg                 # 已下载也须通过媒体完整性校验
& $py -m vbench extract --config $cfg                 # 证据层；OCR/ASR 走内容寻址缓存
& $py -m vbench migrate-corrections --config $cfg --from-config configs\pilot.BV19D7565EZg.json
& $py -m vbench build --config $cfg --dry-run         # 预览视图（不写账本）
& $py -m vbench timeline --config $cfg --dataset draft
& $py -m vbench review-sheets-v2 --config $cfg --start 637 --end 2044   # 校对表
& $py -m vbench corrections-import --config $cfg --run-scoped --file my_corrections.jsonl --reviewer 名字
& $py -m vbench turn-boundaries-import --config $cfg --file my_boundaries.jsonl --reviewer 名字
& $py -m vbench build --config $cfg                   # 审阅后分配序号
& $py -m vbench timeline --config $cfg                # accepted + draft 记录与文字稿
& $py -m vbench private-roster-v2 --config $cfg --times 30,300,600,900,1200,1500,1800,2030
& $py -m vbench samples-v2 --config $cfg --dataset accepted   # 旧格式 X/Y（兼容）
& $py -m vbench samples-v2 --config $cfg --dataset draft
& $py -m vbench report-v2 --config $cfg
& $py -m vbench agent-pairs --config $cfg --dataset accepted  # ← 默认交付物：input.zh.txt + label.json
& $py -m vbench agent-pairs --config $cfg --dataset draft
```

`agent-pairs` 可以用 `--open-question "…"`（可重复）把待复核问题写进每份 `audit.json`。

v1 命令（`samples`、`report`、`reference-sheets`、`dense-check`、`review-export` 等）保留，用于复现 v1 试点。

### 用这对文件

```powershell
$pairs = "..\data\video-benchmark\runs\full-v2b\agent_pairs_v3"
& $py examples\use_input.py $pairs                      # 打印将要发出去的 user message
& $py examples\use_input.py $pairs --answer answer.json # 单独读 label 打分
```

`examples/use_input.py` 不联网、不需要 key。它只做两件事：把 `input.zh.txt` 原封不动当 user message（固定任务指令来自单独的 `instruction.zh.txt`），以及**另开**一次文件读取拿 `label.json` 打分。正文和答案永远不拼在一起。

### 修正文件格式

`corrections-import` 补齐 `correction_id`、`revision` 与目标内容 hash：

```json
{"target": {"kind": "utterance", "id": "utt-…"}, "op": "set", "path": "caption.text", "value": "改正后的字幕", "note": "为什么"}
{"target": {"kind": "public_event", "id": "evt-…"}, "op": "anchor", "value": {"public_at": 239.17, "basis": "投票揭示", "evidence_refs": [{"kind": "board_snapshot", "id": "brd-…", "video_time": 239.17}]}, "note": ""}
{"target": {"kind": "public_event", "id": "evt-…"}, "op": "accept", "note": ""}
```

`turn-boundaries-import` 每行：`{"before": "utt-…", "after": "utt-…", "decision": "break" | "join", "note": "…"}`（两张相邻字幕卡；换人、剪辑缺口、排除片段处的 join 会被拒绝）。

## 付费试跑（会花钱，默认不跑）

`scripts/run_api_trial.py` 把 `input.zh.txt` 原文发给一次模型推理，再离线用 `label.json` 打分。**只有加 `--confirm` 才会真的付费**，SDK 重试关掉，坏响应只落盘不重发。

```powershell
& $py scripts\run_api_trial.py --dry-run      # 只做预算/上下文预检，不发请求
& $py scripts\run_api_trial.py --confirm      # 唯一一次付费请求
& $py scripts\run_api_trial.py --score-only   # 用已保存的响应重新解析和评分，不联网
```

凭证从仓库根 `.env.local` 读（`--key-var` 指定变量名，默认 `OPENAI_API_KEY_DEV`），值不落盘、不进日志、不进请求记录。产物写在 `../data/video-benchmark/api_trials/<日期>-<模型>-<范围>/`。

**推理路径不读 label**：`vbench/api_trial.py` 里只有 `score()` 接受 label 参数，`build_request()` / `run_trial()` 没有这个入口，有测试盯着。

## 第二个来源：先量布局，不要照搬

不同上传的布局和规则可能完全不同（实测同一 UP 主的线下局与线上局差了 58 px，面板从实体记录板变成游戏客户端，还多了湖中女神）。新来源的第一步永远是：

```powershell
& $py scripts\probe_layout.py ..\data\video-benchmark\sources\raw\<BVID>.video.mp4
& $py -m vbench inspect-layout --config <cfg> --times 300,600,900   # 看裁剪对不对
& $py scripts\check_overlap.py <run_a> <run_b>                      # 是不是同一局重剪
```

`probe_layout.py` 从视频自己的像素量出字幕条、标签框、右侧面板的位置，并把整帧写到**私有**目录（整帧含观众名单）。它给的是候选矩形，必须对着裁剪人工确认。

布局里两个与泄漏有关的键：

- `redact: {"mode": "keep_first_ink_run"}` —— 矩形无法避开答案时用。例如标签框写的是 `<座位>号 <昵称> [<身份>]` 且**居中**排版，只保留第一段墨迹就只剩座位号。`presence` 在未脱敏裁剪上算，之后一切（OCR、差分、缓存键、保存的裁剪）都用脱敏版。
- `parser: "board" | "client_log"` —— 选实体记录板解析器还是线上客户端日志解析器。

## 测试

```powershell
& $py -m pytest      # 离线：合成帧 + 解码式假 OCR；不下载模型；网络连接直接报错
```

`tests/test_api_trial.py` 用 mock 覆盖请求构建、label 隔离、输出校验与评分，不会调用 API。
