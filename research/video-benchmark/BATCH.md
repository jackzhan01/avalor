# 批次流水线 v1：服务器接力

这是**带人工关口的串行流水线**，不是自动标注整位 UP 主的程序。不调用付费 API；默认不联网。输入是明确列出的视频配置，不自动枚举投稿。每个任务依次经过媒体校验、布局审核、抽取、标注审核、不可覆盖发布；每次 `batch-run` 最多推进每个任务一个机器阶段。

## 1. 代码与数据分开搬

在服务器已有仓库且工作区干净时：

```bash
git fetch origin
git switch dev
git pull --ff-only origin dev
cd research/video-benchmark
python3.11 -m venv ../data/video-benchmark/.venv
source ../data/video-benchmark/.venv/bin/activate
python -m pip install -r requirements.lock.txt -r requirements.txt
python -m pip check
python -m vbench doctor
python -m pytest
```

`requirements.lock.txt` 是原 Windows 抽取环境的传递依赖快照，单独安装它缺少后加的实验依赖；上面同时安装 direct requirements。**Linux 安装、性能和 GPU 兼容性尚未实机验证**；不要声称服务器必定提速。v1 批次默认 CPU/int8，GPU 需在清单中明确设置 `device: cuda`。系统 ffmpeg 不是 PyAV 解码的必要条件。

Git **不含** `research/data/video-benchmark/`。用自己的私有传输通道另行同步以下目录，保留相对路径：

- `sources/`：媒体及媒体校验报告；
- `models/`、`cache/`：本地模型、内容寻址缓存；CPU 和 CUDA 的 ASR 参数不同，缓存不保证命中；
- `annotations/`、`evaluator/`、`runs/`、`api_trials/`：完整历史标注、身份、输入、试验及证据。身份和 label 只供评测方读取。

不要复制 Windows `.venv` 到 Linux，不要把 `.env.local` 或任何 key 塞进数据包。这条流水线不需要 key。新环境**新建批次**，不要把 Windows 的 state 改哈希冒充可恢复状态。批次会冻结运行环境、代码、schema、依赖文件、单局配置和布局；变化时拒绝续跑。`VBENCH_DATA` 可指向其他绝对数据目录，默认是仓库的 `research/data/video-benchmark`。

若未搬模型，可显式下载一次（会联网，不产生模型 API 费用）：

```bash
python -m vbench doctor --fetch-asr-model large-v3
```

正常抽取使用 `local_files_only=True`；缺权重会失败，不会偷偷下载或把字幕单通道当成配置要求的 ASR 成功。

## 2. 明确批次清单

`configs/batch.pilot3.json` 是三局已知布局的示例。首次服务器试跑建议复制成自己的清单，只保留一局，并选择新的 `batch_id` 和 `run_id`。**不要用历史 `full-v2b` / `game2-v1` / `game3-v1` 作为新任务名**。同一个 run 不能被两个批次占用。

```json
{
  "schema": "vbench.batch/1",
  "batch_id": "server-pilot-v1",
  "device": "cpu",
  "jobs": [
    {"config": "game3-v1.BV1kr876AEE1.json", "run_id": "server-game3-v1"}
  ]
}
```

`config` 相对批次文件位置；单局配置中的相对 `layout` 仍相对 `research/video-benchmark/`。添加新视频必须先确认单 P / 多 P、片头与赛后范围、规则和布局；不能把某一局的矩形、票型颜色或事件时刻直接复制到所有视频。清单只在初始化读取一次，随后修改原配置不会影响被冻结的任务。

```bash
python -m vbench batch-init --file configs/batch.pilot3.json
python -m vbench batch-run --batch pilot3-cpu-v1
python -m vbench batch-status --batch pilot3-cpu-v1
```

默认只读已有媒体。缺文件时任务失败；确实需要公网下载才加 `--download`。下载使用原有 watchdog，断流/超时保留 `.download` 续传文件；下载器退出 0 也必须通过完整解码校验，才改为正式文件名。已存在的零字节、损坏文件不会因“文件存在”被跳过。坏文件不自动删除：人工确认原因后用新文件名/新配置重试。

校验包括视频/音频完整解码、时间戳单调性、最大帧间缺口、解码跨度与声明时长、两流时长差，并绑定文件 SHA-256。**它不证明口型同步，也不证明视频没有跳剪**。校验结果在 `sources/verified/<hash>.json`。

## 3. 第一关：布局审核

媒体通过后状态为 `stage: layout, status: needs_review`，再次运行不会自动前进。被冻结的配置和布局在：

```text
batches/<batch_id>/<run_id>/config.json
batches/<batch_id>/<run_id>/layout.json
```

用这个配置生成并查看布局裁剪：

```bash
python -m vbench inspect-layout --config ../data/video-benchmark/batches/pilot3-cpu-v1/batch-game3-cpu-v1/config.json --times 250,1000,1790
```

不同任务的时刻须自行选取，至少三处，覆盖抽取区间前后四分之一。确认公开区域不含身份/昵称、座位脱敏正确、板面晚期不截断、投票颜色有依据、规则有来源。将真实审核写成 JSON；下例故意全为 `false`，**不能照抄成已审核**：

```json
{
  "reviewer": "实际审核者",
  "note": "逐时刻检查结果与证据路径",
  "config_sha256": "从 state.json 对应 job 复制",
  "media_hashes": {"video": "从 job.media.hashes 复制", "audio": "如有音频则必须复制"},
  "checked_times": [250, 1000, 1790],
  "checks": {
    "public_crops_safe": false,
    "seat_redaction": false,
    "full_board_extent": false,
    "vote_colors": false,
    "rules_basis": false
  }
}
```

完成全部检查后才逐项改为 true，并调用：

```bash
python -m vbench batch-approve --batch pilot3-cpu-v1 --run-id batch-game3-cpu-v1 --kind layout --receipt /private/path/layout-review.json
python -m vbench batch-run --batch pilot3-cpu-v1
```

程序校验的是凭据是否完整且对应当前字节，**不替人判断画面是否真的审核正确**。布局需要修改时建立新批次/新 run，不编辑 state 绕过冻结。

## 4. 第二关：标注审核

抽取通过后停在 `review`，原始证据在 `runs/<run_id>/public/`，审阅队列在 `review/`。沿用 [README](README.md) 的 `review-sheets-v2`、`corrections-import --run-scoped`、`turn-boundaries-import`、`build` 等命令，但必须使用被冻结的新 run 配置。

新批次不自动继承 source 级旧修正，避免把不同分段的 accept 套到新记录。若迁移旧 run 修正，仍须核对 stale/conflict 和全部证据。所有候选必须明确接受或拒绝；客观事件要补真实公开时刻；覆盖文件必须有明确 `live_game_interval`；私有名单必须逐座位 verified。现有代码不会通用地自动完成这些工作。

准备好 `annotations/<source_id>/coverage.json`、`private/roster_v2.json` 及 run 级修正后：

```bash
python -m vbench batch-review-info --batch pilot3-cpu-v1 --run-id batch-game3-cpu-v1
```

此命令先构建修正视图与序号账本，再给出当前证据指纹。审核凭据格式：

```json
{
  "reviewer": "实际审核者",
  "note": "审核范围、方式、证据位置与局限",
  "config_sha256": "review-info 输出值",
  "media_hashes": {"video": "输出值", "audio": "如有音频则必须复制"},
  "evidence_sha256": "review-info 输出值",
  "coverage_status": "edited_unknown",
  "open_questions": ["尚未全文听音频验真；无法排除未检测到的跳剪"],
  "checks": {
    "speech_and_seats": false,
    "all_objective_events": false,
    "private_labels": false,
    "live_boundaries": false,
    "cutoff_safety": false,
    "overlap_group": false
  }
}
```

`coverage_status` 可选 `edited_unknown` / `known_gaps` / `reviewed_complete`。只有实际充分检查才能写 complete，**没有 gap 检测结果不等于讨论完整**。检查是否同局重剪后决定 group/split，不能仅靠媒体 hash；`scripts/check_overlap.py` 只是初筛，阈值尚未在大量视频上验证，缺证据现在会报错而非判为不同局。

全部审核通过后：

```bash
python -m vbench batch-approve --batch pilot3-cpu-v1 --run-id batch-game3-cpu-v1 --kind review --receipt /private/path/annotation-review.json
python -m vbench batch-run --batch pilot3-cpu-v1
```

## 5. 发布与恢复

只有完整正文和**所有请求的截止点**都生成成功才原子发布：

```text
runs/<run_id>/release-v1/
  pairs/full/{input.zh.txt,label.json,blocks.json,audit.json}
  pairs/cutoffs/<sample_id>/...
  pairs/{manifest.json,instruction.zh.txt,size_report.json}
  quality.json
```

给 Agent 的只有 `instruction.zh.txt` + 对应 `input.zh.txt`，**不能发送整个 release**，它包含答案与审计信息。`quality.json` 记录审核凭据和局限，不进入模型输入。本次没有压缩或摘要玩家原话。

- `batch-run --retry-failed` 才重试失败阶段；不传时保留失败状态。进程中断留下 running 时可直接重跑。
- 审核之后改了证据会拒绝发布；重新 `batch-review-info` 和 review approve，留下新的审核历史后可继续。
- 已发布任务不会重做，重跑会核验发布目录哈希。要修订已发布数据，使用新 run/新批次，不能覆盖旧版本。
- 老 `agent-pairs` 命令也改为临时目录生成后整体发布；已有目录仅在所有文件字节完全相同时允许幂等执行。旧标题、audit 或目录内容不同（包括旧 draft 子目录）都会要求新 `--revision`，不自动“修复”历史。
- 同一数据根目录只允许一个批次 worker。**不要同时运行旧版 extract/build/export 或人工写入同一 run**；旧命令不都遵守批次锁。文件锁只解决协作进程互斥，不是分布式任务队列。
- 机器阶段失败会保留证据，网络异常不把可能含签名 URL 的 stderr 写入 state；没有自动付费重试。

## 6. 仍未自动化的范围

新布局标定、不同客户端公告的通用时间锚点、逐条字幕/座位核对、任务规则异常、身份与刺杀证据核实、同局重剪最终判定、可靠的跳剪检测，仍是人工工作。没有新增召回率保证，没有批量 API 推理。

推荐下一步：在服务器用一局完成环境和吞吐测试，人工验收一轮新 run，再添加少量新视频。不要直接放开整个 UP 主的视频列表。
