# research/video-benchmark — 线下阿瓦隆视频 → 标注数据的试点管线

把公开对局视频变成**可审计**的研究数据：字幕转写候选、座位归属、公开事件候选、与之严格分离的私有身份标签，以及按截止点导出的 X（给被测 agent）/ Y（给评分器）。

- 标注语义：[SPEC.md](./SPEC.md)（权威定义）
- 试点结果与验收材料：[HANDOFF.md](./HANDOFF.md)
- 不属于产品，不进 App 构建，不在 `npm test` 里跑。

## 目录

| 路径 | 内容 | 进仓库 |
|---|---|---|
| `vbench/` | 管线代码（Python 3.11） | ✓ |
| `vbench/schemas/` | 版本化 JSON Schema（`vbench.<name>/1`） | ✓ |
| `configs/` | 区域布局、试点配置（无密钥） | ✓ |
| `tests/` | 离线测试 + 合成视频夹具 | ✓ |
| `../data/video-benchmark/` | venv、视频/音频、模型权重、缓存、运行产物、人工标注、评测方清单 | ✗（`research/data/` 已忽略） |

数据目录内部：

```
.venv/                 隔离 Python 环境
sources/raw/           下载的视频流、音频流
models/                faster-whisper 权重
cache/                 内容寻址缓存（ocr/、asr/）
runs/<run_id>/
  public/              OCR 原始输出、字幕段、发言人段、板面快照、ASR 段、话语候选、事件候选、公开裁剪
  review/              审阅队列 queue.jsonl / queue.md、参考联络表、密集检查条带（只含公开裁剪）
  views/{all,draft,accepted}/   应用修正 + 序号后的视图
  samples/{accepted,draft}/{X,Y}/
  reports/             pilot_report.json / .md
  private/             名单裁剪、整帧（authoring）——不要链接到任何公开产物
annotations/<source_id>/
  corrections.jsonl    只追加的人工修正
  ledgers/<run_id>.json  序号账本
  reference/reference_review.json  独立参考审阅
  private/roles.json   私有身份标签
evaluator/             manifest.json（样本↔对局↔划分）、sources/<source_id>.json（标题、链接、hash）
```

## Windows 环境搭建（PowerShell）

需要 Python 3.11。**不需要系统 ffmpeg**：PyAV 自带 FFmpeg 库。GPU 可选（ASR 用 CUDA 12；无 GPU 时把配置里 `asr.device` 改成 `cpu`、`compute_type` 改成 `int8`，会慢很多）。

```powershell
cd research\video-benchmark
python -m venv ..\data\video-benchmark\.venv
$py = "..\data\video-benchmark\.venv\Scripts\python.exe"
& $py -m pip install -r requirements.lock.txt
& $py -m vbench doctor                               # 版本、解码器、CUDA、模型是否就位
& $py -m vbench doctor --fetch-asr-model large-v3    # 一次性联网下载 ~3 GB 权重（免费、本地运行）
```

PowerShell 输出中文乱码时先执行 `$env:PYTHONIOENCODING = "utf-8"`。

## 命令（按工作流顺序）

```powershell
$py  = "..\data\video-benchmark\.venv\Scripts\python.exe"
$cfg = "configs\pilot.BV19D7565EZg.json"

& $py -m vbench acquire --config $cfg          # yt-dlp 下载（不用 cookies）；已存在则跳过，并登记来源
& $py -m vbench ingest  --config $cfg          # 只登记本地文件（下载受阻时：把文件放到 config.source.video_file 指的位置）
& $py -m vbench inspect-layout --config $cfg --times 0,240,300,580,600   # 区域裁剪 + 叠层门控读数
& $py -m vbench extract --config $cfg          # 扫描 → OCR → 字幕/发言人/板面 → ASR → 话语 → 事件 → 审阅队列
& $py -m vbench dense-check --config $cfg --start 568 --end 592 --strip-every 3   # 逐帧 vs 粗采样
& $py -m vbench reference-sheets --config $cfg # 独立参考转写用的联络表（不含 OCR 文本）
& $py -m vbench review-export --config $cfg    # 重新生成 review/queue.jsonl 与 queue.md
& $py -m vbench corrections-import --config $cfg --file my_corrections.jsonl --reviewer 名字
& $py -m vbench build   --config $cfg          # 应用修正 + 分配序号 + 写 views/（--dry-run 不写账本）
& $py -m vbench private-roster  --config $cfg  # 名单裁剪写入 private/（人工据此填 roles.json）
& $py -m vbench private-validate --config $cfg # 校验私有身份文件，只打印计数
& $py -m vbench samples --config $cfg --dataset accepted   # 或 draft；--perspective 非 public_observer 会被拒绝
& $py -m vbench report  --config $cfg
& $py -m vbench validate ..\data\video-benchmark\runs\pilot-cycle1\views\accepted\events.jsonl
```

### 审阅与修正

`review/queue.md` 每条给出时间码、公开裁剪、候选文本、分歧原因和 `target`。修正写成 JSONL，每行一条，`corrections-import` 会补 `correction_id`、`revision` 和目标内容 hash：

```json
{"target": {"kind": "utterance", "id": "utt-…"}, "op": "set", "path": "caption.text", "value": "改正后的字幕", "note": "为什么"}
{"target": {"kind": "public_event", "id": "evt-…"}, "op": "anchor", "value": {"public_at": 239.17, "basis": "投票揭示", "evidence_refs": [{"kind": "board_snapshot", "id": "brd-…", "video_time": 239.17}]}, "note": ""}
{"target": {"kind": "public_event", "id": "evt-…"}, "op": "accept", "note": ""}
```

- 可改字段有白名单（`vbench/corrections.py: SETTABLE`）。
- 同一字段再次修正必须写 `supersedes`，否则记为冲突、不生效。
- 重抽后目标内容变了或不见了 → `stale`，不生效，并出现在审阅队列里。
- 板面事件默认 `unanchored`，不锚定就不会进入任何 X。

## 测试

```powershell
& $py -m pytest            # 离线：合成帧 + 解码式假 OCR，不下载模型，网络连接会直接报错
```

真实模型只在 `extract` 里使用；测试从不加载 RapidOCR 或 Whisper。
