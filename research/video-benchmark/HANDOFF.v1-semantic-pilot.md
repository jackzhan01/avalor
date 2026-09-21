# 交接给 Codex：视频标注试点（pilot-cycle1）

写给负责验收的 Codex。任务书：[docs/claude-code-video-benchmark-task.md](../../docs/claude-code-video-benchmark-task.md)。标注语义见 [SPEC.md](./SPEC.md)，命令见 [README.md](./README.md)。

**一句话结论：** 真实视频的第一轮完整周期（0–637.0 s）已端到端跑通：下载 → 探测 → 区域配置 → 抽取（OCR + 本地 GPU ASR）→ 独立参考审阅 → 只追加修正 → 序号 → 4 个截止点的 X/Y 导出 → 报告。所有质量数字都是**我自己做的临时审阅**，没有音频核对，不是 gold；最终验收留给你和仓库主人。

---

## 1. 改了什么、怎么复现

### 变更路径（全部新增，未改动任何已有文件）

```
research/video-benchmark/
  SPEC.md  README.md  HANDOFF.md  requirements.txt  requirements.lock.txt  pytest.ini  .gitignore
  configs/layout.yuanzhuo-1080p-v1.json   configs/pilot.BV19D7565EZg.json   configs/survey.BV19D7565EZg.json
  vbench/  (__init__ __main__ cli util paths validate layout media changes ocr cache captions board asr
            utterances speech_events source pipeline corrections ledger views review samples
            private_labels export report dense .py)
  vbench/schemas/*.schema.json  (18 个)
  tests/  (conftest synth test_captions_speakers test_speech_events test_board
           test_corrections_ledger test_samples_leakage test_private_split_cache_schema .py)
```

工作区里原有的未提交改动（`eslint.config.mjs`、`AGENTS.md`、`docs/handoff-to-codex.md` 等）没有碰。**没有提交、没有推送**（用户没有要求提交）。

### 架构

```
视频(PyAV解码) ──► changes.scan ─────────► 每个公开区域的像素稳定段
  │  粗采样每6帧转换一次；变化时回溯缓冲帧精修到帧；每2s(板面10s)留守卫帧
  │  只看 layout 里 visibility=public 的矩形 + 叠层存在性门控
  ▼
ocr (RapidOCR; 字幕/标签=仅识别, 板面=2倍放大检测+识别) ──► ocr_raw.jsonl（原样框、分数）
  ├─ captions.build_captions    时间持续去重、抖动合并（发言人不同不合并）
  ├─ captions.build_speaker_segments / attribute_speaker   只信座位号
  └─ board.parse_board → events_from_snapshots             快照差分，默认 unanchored
asr (faster-whisper large-v3, CUDA fp16) ──► asr_segments.jsonl
utterances.build_utterances   先字符序列对齐、后时间就近；保留分歧，不改任一侧
speech_events.extract_statements   有界规则；引述/无第一人称标记会被标出
review → corrections(只追加) → ledger(只增序号) → views → samples(X) / private_labels(Y) → report
```

隔离点：`pipeline`/`samples`/`review`/`views` 等公开模块的 import 闭包里没有 `private_labels`（测试检查 AST import 图）；只有 `export.py`（评测方编排）同时碰 X 和 Y，且分别写到 `X/`、`Y/` 两个目录。

### 依赖（隔离 venv，Python 3.11.9，Windows 11）

直接依赖见 `requirements.txt`，完整锁定见 `requirements.lock.txt`（43 行）。关键版本：numpy 1.26.4、opencv-python 4.11.0.86、av 13.1.0（FFmpeg libavcodec 61.3.100，**不需要系统 ffmpeg**）、rapidocr_onnxruntime 1.4.4（内置 PP-OCRv4 模型，onnxruntime 1.30.0 CPU）、faster-whisper 1.1.1 + ctranslate2 4.8.2（自带 cuDNN 9，用系统 CUDA 12.2，RTX 4060 Laptop）、jsonschema 4.23.0、yt-dlp 2026.8.19、pytest 8.3.4。`vbench doctor` 报告全部 pin 一致。

没有新增 npm 依赖，根 `package.json` 未动。

### 复现（PowerShell，在 `research/video-benchmark` 下）

```powershell
python -m venv ..\data\video-benchmark\.venv
$py = "..\data\video-benchmark\.venv\Scripts\python.exe"; $env:PYTHONIOENCODING = "utf-8"
& $py -m pip install -r requirements.lock.txt
& $py -m vbench doctor --fetch-asr-model large-v3
$cfg = "configs\pilot.BV19D7565EZg.json"
& $py -m vbench acquire --config $cfg
& $py -m vbench extract --config $cfg
& $py -m vbench reference-sheets --config $cfg
& $py -m vbench dense-check --config $cfg --start 568 --end 592 --strip-every 3
& $py -m vbench dense-check --config $cfg --start 10 --end 20 --strip-every 3
& $py -m vbench dense-check --config $cfg --start 418 --end 424 --strip-every 3
# 人工部分（本次的留档脚本在已忽略目录）：
#   annotations\src-c9be57d8e2c4\authoring\ref_lines.txt           逐行转写原稿（行号 = 联络表行号）
#   annotations\src-c9be57d8e2c4\authoring\build_reference.py      原稿 + 事件清单 → reference\reference_review.json
#   annotations\src-c9be57d8e2c4\authoring\derive_corrections.py   从参考推导修正草稿
#   （之后又把 dense-check 结果写进了 reference_review.json 的 dense_checks）
& $py ..\data\video-benchmark\annotations\src-c9be57d8e2c4\authoring\derive_corrections.py > draft.jsonl
& $py -m vbench corrections-import --config $cfg --file draft.jsonl --reviewer claude-code
& $py -m vbench build --config $cfg
& $py -m vbench private-roster --config $cfg        # 人工据裁剪写 annotations\...\private\roles.json
& $py -m vbench private-validate --config $cfg
& $py -m vbench samples --config $cfg --dataset accepted
& $py -m vbench samples --config $cfg --dataset draft
& $py -m vbench report --config $cfg
& $py -m pytest
```

注意：`corrections.jsonl` 只追加，重复导入同一草稿会得到重复修正（后者因缺 `supersedes` 被判冲突、不生效）。要从头复现，先挪走 `annotations\src-c9be57d8e2c4\corrections.jsonl` 和 `ledgers\`。

---

## 2. 实际跑了什么

| 阶段 | 状态 | 证据 |
|---|---|---|
| 公开元数据 | **部分未核实**：裸 `curl` 访问 B 站 API 被反爬挡回错误页；yt-dlp 能解析同一 BVID/CID。标题、UP 主沿用任务书里的值，**没有重新核对** | `configs/pilot.*.json` |
| 下载 | **已运行**：yt-dlp 格式 30080（1080p AVC，279,017,049 字节）+ 30280（m4a 111k，28,278,836 字节），不用 cookies、不写 info json。1080P60 需要大会员，没用 | `sources/raw/` |
| 探测 | **已运行**：H.264 1920×1080 30 fps、2043.67 s；AAC 44.1 kHz；**0 个坏包** | `evaluator/sources/src-c9be57d8e2c4.json` |
| 区域配置 | **已运行**：在 0/30/90/180/240/260/300/570/580/585/600/700/860 s 的帧上测量；门控在有/无叠层之间间距大（字幕条边缘黄色占比 ≥0.84 vs ≤0.08） | `configs/layout.yuanzhuo-1080p-v1.json` |
| 普查（0–1300 s，无 ASR） | **已运行**，只用于找第一轮在剪辑里的结束点 | `runs/survey-0-1300/` |
| OCR | **已运行**（RapidOCR，CPU） | `public/ocr_raw.jsonl` 836 条 |
| ASR | **已运行**（faster-whisper large-v3，CUDA fp16，本地） | `public/asr_segments.jsonl` |
| 事件抽取 | **已运行**：板面 8 条、言语 11 条候选 | `public/events.jsonl` |
| 修正 | **已运行**：424 条，全部生效，0 过期 0 冲突 | `annotations/…/corrections.jsonl` |
| 样本导出 | **已运行**：4 个截止点 × accepted/draft；`player:4` 视角被拒绝（退出码 2） | `samples/`、`evaluator/manifest.json` |
| 私有标签 | **已运行**：10 座位 verified（单一来源：制作方名单叠层） | `annotations/…/private/roles.json` |
| 湖中女神解析 | **已实现、未在真实数据上触发**：试点区间里没有湖中（10 人局第 2 轮后才会出现） | `speech_events.py`、`rules.lady_of_the_lake = null` |
| 玩家视角样本 | **明确拒绝**（不是占位） | `samples.UnsupportedPerspective` |
| 逐字语音参考 | **没有做**：没人听音频，`verbatim` 全为 `null`，不报告逐字准确率 | — |
| LLM 抽取器 | **没有做、没有付费调用** | `external_usage.paid_api_calls = 0` |

---

## 3. 本地产物与分离

全部在已忽略的 `research/data/video-benchmark/` 下：

| 项 | 值 |
|---|---|
| 视频 sha256 | `c9be57d8e2c4f80ef0627a0eb1e3bf913f016384eb76f5c72615f4b6a53bdd70`（`source_id = src-c9be57d8e2c4`） |
| 音频 sha256 | `be8d9e1e19b85302efdfb5b716d39ee335228ea752b42d39cb75939b68267e4a` |
| 不透明对局 ID | `game-8b5b797604`，`group grp-pilot-1`，split `dev` |
| 区间 | 0–637.0 s；理由写在 `configs/pilot.BV19D7565EZg.json` 的 `interval.rationale` |
| 布局 | `configs/layout.yuanzhuo-1080p-v1.json` |
| 运行目录 | `runs/pilot-cycle1/`（111 MB，主要是公开裁剪 PNG） |

**区间为什么是 0–637 s。** 视频开头已在第 1 次组队讨论中。0–236 s 讨论并由 10 号发车（3·4·10），239 s 揭示 0:10 否决；242–576 s 讨论第 2 次组队，1 号发车（1·4·7），573.6 s 揭示 3:7 否决。**剪辑缺口**：第 3 次组队（2 号必做 2·4·6）与第一轮做任务被剪掉；板面在 579.4 s 补上第 3 行、582.8 s 补上「任务成功」，586.4 s 已是第二轮 3 号队长发言。区间延长到 637.0 s，是为了把玩家口头确认第一轮结果（「这个任务绿了」628.4 s）包含进来。这个缺口如实报告，**没有编造第 3 次组队的讨论或翻牌**。

**公开 / 私有 / 评测方分离：**
- 公开抽取只读三个矩形：字幕条、发言人标签、历史板。名单（右下）是 `private`，镜头区（含座位牌「赞成」、编辑花字、转场卡、皇冠图标）是 `excluded`。布局校验拒绝公开矩形与非公开矩形重叠。
- 叠层门控：字幕条/标签框不在时矩形里是镜头画面，不送 OCR（也挡住了座位牌等答案性像素）。
- `review/` 只有公开裁剪；整帧和名单裁剪只在 `runs/pilot-cycle1/private/`。
- X 里没有标题、UP 主、链接、BVID、source hash、game_id、昵称、视频时间、文件路径（校验器按键名和值模式扫描；导出后又逐项 grep 过）。来源只在 `evaluator/`。
- **本文不含身份答案。**

---

## 4. 测试与实测质量

### 测试

| 检查 | 结果 |
|---|---|
| `python -m pytest`（离线，socket 被拦截，不加载任何模型） | **57 passed** |
| `npx tsc --noEmit`（仓库根） | 退出码 0 |
| `npm run check:imports` | ✓ 160 个文件（本次没有提交，HEAD 未变） |
| 产品 / 模拟器测试套件 | **未运行**：没有改动任何共享配置或 TS 代码 |

测试覆盖任务书「Required verification」的每一项：字幕持续、OCR 抖动、短字幕精修到帧、粗采样漏检（与逐帧对照）、分隔的相同字幕、不同发言人的相同文字、无发言人、标签切换、重叠语音、OCR/ASR 分歧保留到审阅导出、数字/否定分歧、引述不变成自信立场、板面增量更新、部分票型（缺键≠unknown）、不从向量推结果、票数与向量冲突、快照冲突保留读法、跨截止点的话语、延迟可得、未来后缀变化 X 逐字节不变、私有标签变化 X 不变 Y 变、私有区域像素变化公开裁剪与分段不变、draft/accepted、修正不改机器记录、修正持久化、过期修正、禁止静默覆盖、缓存复用与失效、按局划分、畸形私有标签、不支持的视角、公开模块 import 图。

### 处理量与耗时（区间 637.0 s，19,111 帧）

| 项 | 值 |
|---|---|
| 粗采样 / 精修窗口 / 实际转换帧 | 3,186 / 522 / 5,541 |
| 边界精度 | 精修到 1 帧（0.033 s）；粗采样周期 0.2 s；守卫帧 2 s（板面 10 s） |
| 字幕段 / 跳过空字幕条 / 跳过 <2 帧 | 507 / 98 / 23 |
| OCR 调用（冷） | 803 次 98.6 s（首帧修复后几乎全量重跑那次） |
| ASR（冷） | 1 次 90.6 s（含模型加载，GPU） |
| 扫描 | 16–17 s |
| 全缓存重跑 | 20.9 s：OCR 835/835 命中、ASR 命中 |
| 最终一次抽取 | 26.6 s：OCR 26 次调用、810 次命中 |
| 付费 / 外部调用 | 0（模型权重和视频是一次性下载） |

### 实测质量（对照独立参考审阅；**修正前**是机器质量）

参考审阅方法：用逐帧扫描生成 17 张联络表（496 个像素稳定行，只含公开裁剪，不含 OCR 文本），我对着像素转写 372 条字幕和座位；另外检查板面快照与字幕上下文，列出 8 条板面事件、全区间 8 条跳身份、**只在 150–236 s 子区间**列出 6 条表态/意向车。

| 指标 | 修正前 | 修正后¹ |
|---|---|---|
| 参考字幕召回 | **371/372** | 372/372 |
| 字符错误（去标点空白后） | **12/3403 = 0.35%** | 0/3404 |
| 字幕完全一致 | 359/371 | 372/372 |
| 座位归属 正确/错误/未知 | **371/0/0**（共 371） | 372/0/0 |
| 一个机器字幕覆盖多个参考字幕 | 1 | 0 |
| 多余机器字幕 | 0 | 0 |
| 板面事件 找到 / 字段 | **8/8，32/34** | 8/8，34/34 |
| 板面事件公开可得时间 | 0/8 锚定（按设计） | 8/8 锚定 |
| 跳身份（全区间）找到 | **2/8** | — |
| 表态+意向车（150–236 s）找到 | **1/6** | — |
| 言语事件候选审阅 | 原样接受 7/11，改 holder 后接受 1/11，拒绝 3/11 | — |

¹ 修正由同一份参考推导，「修正后」只证明修正落地，**不是独立质量**。

OCR/ASR 对齐分布（377 条话语）：agree 243、minor_diff 93、disagree 32、无 ASR 重叠 2、仅 ASR 7；数字写法分歧 19、否定词数量分歧 13。这些是**分歧**，不是错误率——字幕是剪辑后的文本，ASR 也会错（例：「派西」→「拍戏」）。

**密集检查（粗采样的召回上限）**：3 段共 40 s 快速变化区间，逐帧扫描 77 个边界，粗采样漏 10 个（字幕 4、标签 4、板面 2），全部是 1–2 帧的闪烁/动画（420.08 s、421.68 s 字幕放大动画；573.9 s 板面票数闪烁）；看条带图确认没有丢失字幕文字。结论只适用于这 40 s，不外推。

**真实数据上的其它验证：**
- 非干扰：把私有身份文件里两个座位改成 unknown 重新导出 → 4 个 X 的 sha256 全部不变、Y 全部改变且降为 `partial`（之后已恢复原文件与样本）。在 300 s 帧上随机改写 151 万个非公开像素 → 三个公开裁剪 hash 不变。
- 缓存与过期：同布局只跑 0–120 s → OCR 164 命中/2 未命中；已有修正 322 条 `stale:missing_target` + 89 条 `stale:content_changed`（ASR 区间变了，记录内容随之变化），全部未应用。字幕矩形平移 2 px → 字幕 OCR 90 次全部重跑、标签/板面 76 次命中；411 条修正全部 `stale:missing_target`。产物在 `variants/`、`runs/variant-*`。

---

## 5. 带时间码的审阅样例

1. **发言人归属** · 0:00.00–0:01.33 字幕「好那从这边发言」标签 `10 派上花开` → 0:01.33 起「从我发言啊」标签 `1 Lucy`：标签在字幕之间切换，两条分别归 10 和 1。5:00 左右标签是 `7 阿鼎`，镜头里却是 5 号的座位牌——反应镜头，所以座位只取自标签、从不取自镜头。本区间 0 条 `label_transition`（标签恰好总在字幕边界切换）；该分支由合成测试覆盖。
2. **字幕/ASR 分歧** · 0:40.87 字幕「真派真派永不退水」，ASR「真怕真怕有霉碎水」，CER 0.625，另标 `negation_mismatch`（「不」字数量不同）→ 审阅队列。字幕保持原文、ASR 保持原文、`verbatim = null`。另：0:02.23「我不是派西」/ASR「我不是拍戏」；10:28.42「这个任务绿了」/ASR「这个任务立了」。
3. **板面转换** · 9:33.55 板面出现「3:7 → 否决组队」，首个快照处于闪烁动画中，1 号的绿色数字没读出来（票型只有 9 个键）；9:34.75 的稳定快照读出完整向量。两个读法都保留，事件标 `board_conflict`，审阅用 `set payload` 改为完整向量，并锚定到 573.55 s。另一个：9:39.42 板面**一次性**补出第 3 行（必做轮，板上没有序号 → 机器留 `null`，审阅改为 3），9:42.82 补出「任务成功」三张成功牌——都在剪辑缺口之后。
4. **截止边界** · 截止点「第 2 次组队投票结果」= 序号 372，`public_at` 573.55 s。「是吧」（571.95–572.28 s）在 X 里；「不是你也可以听发言」（572.28–573.58 s）**比截止点晚结束 0.03 s，整句排除**。样本 `x-338af233fe7296f8`。
5. **排除的观众信息** · 右下名单（x 1540–1920，y 632–1080）全程显示每个座位的昵称和身份词，还有随队长/发言人移动的皇冠和话筒图标。它只以私有裁剪存在（30/300/600 s 三张，hash 记在 `roles.json` 证据里），从未进入 OCR 公开路径、审阅产物或 X。镜头区里的座位牌「赞成」、编辑花字「持续施压!!」（6:10 附近）、「赞成公共好人了?」（5:50 附近）、9:40 的转场卡「2号是否能发好车?」同样被排除。
6. **漏掉的短字幕** · 0:11.07–0:11.87 单字字幕「呃」：分段正确（24 帧），但仅识别模式对宽裁剪里居中的单个字返回空文本、分数 0 → 机器遗漏；审阅用 `add` 补录。
7. **剪辑改字被当抖动合并** · 4:19.93–4:23.60「建议就在一这去开出去了」→「建议就在一这就开出去了」：编辑改了一个字，像素变化被检出，但两段文本在抖动容差内且发言人相同 → 合并成一条，另一读法进 `alternatives`。审阅补录第二条；两条 `public_at` 都是 263.60 s，账本记为 `unresolved` 并列（序号 179/180），没有假装知道顺序。
8. **引述与条件句** · 1:29.70 6 号「专门盯着这个2号打啊」：解析器默认记为 6 号踩 2 号（无第一人称标记 → 已标出），上下文是 6 号在质疑「3号踩这个2号」→ 审阅改 holder 为 `quoted 3`。2:21.10 8 号「那十号如果是坏人还ok」、4:53.33 7 号「2号要盘什么狼种的话」是条件句 → 拒绝。

---

## 6. 已知失效模式、未决项、扩展到全片的人工量

### 失效模式（按影响排序）

1. **言语事件召回低**：跳身份 2/8。没覆盖「我不是派啊」（单字「派」）、「9号不是派」「4号派西」（第三人称自指）、「我也不是派嘛」（插入「也」）、「拿到忠臣牌」、跨两条字幕的问答。我**没有**在看过参考之后回头调规则——调了就不再是可信的测量。这批数据只能当 dev。
2. **板面时间不可信**：板面是操作员录屏，会成批补录、会在剪辑缺口之后一次性出现多行、会有闪烁动画。事件因此默认 `unanchored`，每条都要人工找公开揭示时刻。
3. **单字/极短字幕 OCR 为空**：见样例 6。建议修复：有墨迹但识别为空时回退到检测+识别。**未应用**，因为会改变已审阅的机器输出。
4. **剪辑改字被合并**：见样例 7。抖动容差 0.25 对 11 个字只差 1 个字的情况分不开。
5. **格子边框检测弱**：上车格的金色细框在压缩后只检出一部分；因此只作证据，不单独触发冲突。
6. **粗采样盲区**：在 ≤5 帧内出现又恢复的变化粗采样看不到；密集检查中只有闪烁动画落入此类。
7. **时间戳漂移**：约 358 s 之后帧 pts 不再落在 1/30 网格上；已改为按解码计数编帧号。
8. **角色组成来源**：`rules.role_composition` 是标准 10 人含奥伯伦配置，与名单一致；它对玩家是公开的开局设置，但**在本剪辑里我是从私有名单确认的，不是从公开渠道看到的**。每轮人数只有第 1、2 轮在板面上看到；两次失败规则是标准规则，未在视频里观察到。
9. **残余污染风险**：公开发布的对局可能已被模型记住；去标识化解决不了。

### 未决审阅项（没有用修正关掉）

- 7 条仅 ASR 语音（2:45.42「就直接排水了」、4:05.28「派的不就好了」、5:23.52「5号总」、7:23.10「他紧张」、8:03.26「可能是让莫」、8:18.94「是很明我」、8:52.10「什么」）：没有字幕、没有听音频核实 → 保持 `needs_review`、`eligibility unknown`，只出现在 draft 数据里且不会进 X（资格未定）。
- 150–236 s 以外的表态/意向车没有逐条列参考，accepted 数据里的言语事件**不完整**，只能当作「部分标注」。
- 私有身份只有一个来源通道（制作方名单）；没有用片尾复盘交叉核对（没处理 637 s 以后）。
- 元数据（标题、UP 主）没有重新核实。
- 以上全部是临时自审；`reference_review.json` 的状态是 `provisional_self_review`。

### 扩展到全片（2,044 s ≈ 本次 3.2 倍）的估算

- **机器**：冷跑约 扫描 55 s + OCR 5–6 min + ASR 5 min，全缓存重跑 < 1.5 min。
- **人工（估计，不是实测）**：
  - 字幕逐条核对 ~1,200 条，按每条 5–6 s 约 **1.5–2 h**；
  - 板面事件锚定（5 轮、约 12–15 次组队），每次 3–5 min，约 **1 h**；
  - 全片表态/跳身份/意向车逐条标注，本次 86 s 子区间就有 6 条，估计 **3–4 h**，是主要成本；
  - 仅 ASR 语音需要真正听音频，约 **0.5 h**；如果要逐字参考，还要另加。
- 建议先修上面第 1、3 条再扩展，并请第二个人独立审一个子区间，估计一下自审偏差。
