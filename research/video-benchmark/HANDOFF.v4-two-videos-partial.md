# 交接给 Codex：两个新视频的 input–label 对（第二个来源完成，第三个受阻）

任务书：`docs/claude-code-video-agent-pair-revision.md` 的呈现契约（每次组队一个 block）继续有效，本次是把它应用到两个**新的真实视频**。语义与文件契约见 [SPEC.md](./SPEC.md)（新增 §10：线上客户端局），命令见 [README.md](./README.md)。

上一版交接（第一个来源 BV19D7565EZg 的 agent-pair 交付）原样保留在 [HANDOFF.v3-agent-pairs-game1.md](./HANDOFF.v3-agent-pairs-game1.md)，更早的在 [HANDOFF.v2-timeline.md](./HANDOFF.v2-timeline.md) 与 [HANDOFF.v1-semantic-pilot.md](./HANDOFF.v1-semantic-pilot.md)。**那几份里的数字只描述各自那一版**，不要拿来描述本次这两局。

**一句话结论：** `BV12beJ69E8W` 已完成，产出真实的 `input.zh.txt` + `label.json` 和 4 个截止点配对；`BV1kr876AEE1` **卡在下载**（1080p 视频流 86 MB / 264 MB，B 站 CDN 反复断流），只完成了元数据、音频与 ASR 缓存，没有画面就无法抽取，**没有任何合成或占位产物**。135 项离线测试通过，`tsc` 与 `check:imports` 通过。未提交、未推送、未改产品代码、0 次付费调用。

---

## 1. 两个视频的状态

| | 视频 1 | 视频 2 |
|---|---|---|
| 链接 | `https://www.bilibili.com/video/BV12beJ69E8W/` | `https://www.bilibili.com/video/BV1kr876AEE1/` |
| 分 P | **单 P**（yt-dlp 列举无分集；无需选择） | **单 P**（`?p=1` 只是 URL 参数，不是多 P） |
| 时长 | 1489.10 s（24:49） | 1877.44 s（31:17） |
| 音频 | 已下载，sha256 `c795557310ad…` | 已下载，sha256 `e8753de17d84…` |
| 视频 | 已下载完整，sha256 `fe54eb89f162…` | **86.0 / 264 MB，未完成** |
| ASR | 878 段（已缓存） | 1105 段（已缓存） |
| 交付物 | **完成** | **未开始**（缺画面） |

链接里的用户/设备/追踪参数没有保留：配置里只存 `bvid` 与规范化 URL。

**同局重剪检查**：三个上传时长互不相同（2043.6 / 1489.1 / 1877.4 s），音频 sha256 互不相同，标题描述的是不同对局。`scripts/check_overlap.py` 用字幕 5-gram Jaccard 加板面车队组合做内容级判定，已实现；视频 2 抽取完成后才能对它跑完整判定，因此目前 `grp-yuanzhuo-2` / `grp-yuanzhuo-3` 先分成两个 split 组，**这一条尚未用内容证据确认**。

## 2. 视频 1 交付物（可以直接打开）

根目录 `research/data/video-benchmark/runs/game2-v1/agent_pairs_v3/`

| 内容 | 精确路径 |
|---|---|
| **完整对局正文** | `runs/game2-v1/agent_pairs_v3/full/input.zh.txt` |
| **答案（单独打开）** | `runs/game2-v1/agent_pairs_v3/full/label.json` |
| 结构化 block | `runs/game2-v1/agent_pairs_v3/full/blocks.json` |
| 旁路审计映射 + 待复核清单 | `runs/game2-v1/agent_pairs_v3/full/audit.json` |
| 固定任务指令（与正文分开） | `runs/game2-v1/agent_pairs_v3/instruction.zh.txt` |
| 评测方清单 | `runs/game2-v1/agent_pairs_v3/manifest.json` |
| 体积对比 | `runs/game2-v1/agent_pairs_v3/size_report.json` |
| 私有身份名单 | `annotations/src-fe54eb89f162/private/roster_v2.json` |
| 剪辑/可用区间判定 | `annotations/src-fe54eb89f162/coverage.json` |

**4 个截止点**（早/中/晚各有覆盖）：

| 截止点 | 目录 | block | 原话段 | 字符 | UTF-8 字节 |
|---|---|---|---|---|---|
| m1 attempt 1 vote outcome | `cutoffs/p3-…/` `9f0…` 见 manifest | 1 | 11 | 1 764 | 4 633 |
| m1 attempt 2 vote outcome | 见 manifest | 2 | 22 | 4 330 | 11 370 |
| m1 mission outcome | `cutoffs/p3-ae923f8124f38d86/` | 3 | 22 | 4 393 | 11 524 |
| m2 attempt 1 vote outcome | `cutoffs/p3-cee33e806c62d294/` | 4 | 32 | 6 242 | 16 316 |
| **（完整对局）** | `full/` | **4** | **32** | **6 247** | **16 327** |

体积对比：完整正文 16 327 字节；同一 run 的存档 `game_record.json` 351 871 字节（约 21×），可读稿 18 317 字节。**token 数未测**——没有可离线使用的目标模型 tokenizer，`tokens`/`tokenizer` 一律 null，字符数不当作 token 数。

## 3. 视频 1：这局长什么样

**时长 1489.1 s，实际可用对局区间 238–1269.5 s（约 17 分钟）。**

- **0–238 s 是片头预告**：首帧写着「正片跳转至3分58秒」，客户端面板还是「等待开局 · 已入座 10/10」，内容是后面片段的乱序重放。抽取区间直接从 238 s 开始。
- **1269.5 s 之后是刺杀讨论与赛后**：客户端在 1269.82 s 公告「刺客选择刺杀梅林」，1271.35 s 起标签变成「狼人盘刀」，字幕直接说「我的刀口进9」；约 1440 s 起标签是「赛后」。由 `live_game_interval` 挡在记录之外。

**规则（逐条从本片确认，没有照搬上一局）**：10 人；每轮人数 3 / 4 / 4（第 4、5 轮从未进行，人数没出现过，**没有**补成标准的 5、5）；每轮最多 3 次组队，第 3 次是客户端的「自动通过 / 必做任务 / 无需投票」；**本局有湖中女神**（面板记录「湖中仙女：5号 查验了 3号」）。

**4 个 block，全部客观事实齐全**：

| block | 原话段 | 说话座位（顺序） | 车主 | 车队 | 上/下票 | 组队结果 | 任务 |
|---|---|---|---|---|---|---|---|
| 第1轮·第1次 | 11 | 6,7,8,9,10,1,2,3,4,5 | 6 | 3、6、9 | 1/9 | 车被否 (1:9) | — |
| 第1轮·第2次 | 11 | 7,8,9,10,1,2,3,4,5,6 | 7 | 6、7、9 | 4/6 | 车被否 (4:6) | — |
| 第1轮·第3次（强制轮） | 0 | — | 8 | 6、8、9 | 无需投票 | — | 成功，失败牌 0 |
| 第2轮·第1次 | 10 | 10,1,2,3,4,5,6,7,8,9 | 9 | 6、7、8、9 | 7/3 | 车过了 (7:3) | 成功，失败牌 0 |

两个普通轮都保留了十个人的发言；强制轮在客户端里是立即自动通过的，画面上没有该轮讨论，因此按规则省略发言部分而**不是**写「未记录」（`speech_recorded = empty`，不是 `none`——没有剪辑缺口可以解释缺失）。

**是否覆盖终局：覆盖了结果，但没覆盖过程。** 第 3 轮从未开打（面板只有「第3轮·需4人」，无任何提名），游戏在刺杀阶段结束。**两轮成功为什么就进入刺杀，本片没有给出依据**——记录对此不作任何断言，正文里也没有第 3 轮的 block。终局事实（忠臣阵营获胜、刺客 4 号、目标 10 号、刺杀失败）只写进 `label.json` 的可选字段，来源是客户端结算横幅。

**正文样式**（真实片段，不含身份答案）：

```text
第1轮任务 · 第1次组队

6号：7号先发言吧
7号：第一个发言没有什么东西 就想上个车好吧 顺置位应该可以上个车吧 后面听一下 总有派跳的吧过了
    ……（8、9、10、1、2、3、4、5 号依次发言）……
6号：这不是给6号出难题吗 6号就一张亚瑟忠臣 …… 开个3、6、9退水车好吧

车主：6号
车队：3、6、9
上票：5
下票：1、2、3、4、6、7、8、9、10
组队结果：车被否（1:9）

第1轮任务 · 第3次组队（强制轮）

车主：8号
车队：6、8、9
投票：无需投票，强制执行
任务结果：成功
失败牌：0
```

## 4. 视频 1：三处剪辑层面的答案泄漏（本次最重要的发现）

这是一部**教学向**剪辑（标题写「教你玩派西维尔如何速通」），公开叠层里直接写了身份。全部按私有层处理：

1. **发言人标签框带身份**。9 号说话时标签是「9号 陈述句 派西维尔」，6 号是「6号 Nancy 拇指牌」，其他人只有「7号 鲨鱼」。标签文字**居中**排版，任何固定子矩形都切不出座位号。新增 `redact: keep_first_ink_run`：只保留第一段墨迹（`<n>号`），其余像素清零，**在 OCR、差分、缓存键和保存的裁剪之前**。顺序是硬要求——`presence` 必须在未脱敏的裁剪上判断，否则白底比例塌掉。实测公开裁剪只剩「9号」「6号」。
2. **底部席位条在刺杀段与赛后揭示全部身份**。整条标为 `private`（横跨全宽 1920，seats 9–10 在 x>1420，最初的矩形漏掉了它们，已修）。
3. **全屏编导卡**（「派西维尔」「拇指牌为2号和6号」）在 `excluded` 的镜头区内。

**另外修掉一个真实泄漏**：无底条字幕区最初左边界在 x=420，而标签框右缘在 x≈464，于是 9 号的字幕被前缀上「尔」（「派西维尔」的末字）。左边界移到 470 后，公开字幕里**零条**以身份残字开头，且字幕总数不变（623 条，没有误删正文）。

## 5. 视频 1：字幕召回与两级接受证据

**不报字幕召回率**：没有独立第三方转写。能说的是：

- 主黄条区 539 条 + **无底条/淡黄条区 84 条（13.5%）**。这一类是**真发言**，样式是淡黄底条 + 黑字白描边，饱和度低于严格黄条门控。只测主字幕区会静默丢掉这 13.5%——这正是上一局踩过的坑，这次主动查了。
- 可用区间内无超过 6 s 的字幕空档，因此不声明剪辑缺口。**这是关于字幕的陈述，不是关于语音的**：剪掉的、没打字幕的话仍然不在记录里。

**接受分两级，各自写在修正的 `note` 里**：

| 级别 | 条数 | 证据 |
|---|---|---|
| 独立通道佐证 | 390 | OCR 与本地 ASR（音频，另一模态）在配置 CER 下一致，且无数字/否定告警。**不代表有人看过。** |
| CC 自审 | 197 | 渲染成 10 张校对表（`runs/game2-v1/review/sheets_tierB/`），对照公开裁剪逐行读过 |
| 其中：文本改正 | 14 | 逐条列在 `authoring/derive_game2_tierB.py` |
| 其中：边缘标点归一 | 9 + 34 | 本片烧录字幕不带句读，行首尾的 `，。！—` 一律是 OCR 伪影 |
| 其中：客户端「系统」提示 | 20 | 标为 `editorial`（见下） |
| 拒绝（重复显示） | 23 | 同句在 4 s 内重绘 |
| 待审 | 1 | 无字幕 ASR 片段 |

最终 `views`：600 accepted / 23 rejected / 1 needs_review；12 条客户端事件全部锚定接受。

**客户端「系统」提示不是发言**：标签读到 `系统` 时字幕是客户端公告（`本轮任务需要4位玩家`、`队长9号选择…`、`必做任务`、`无需投票`、`组队通过`）。它们是客观事实但不是玩家发言，同样的事实已经作为客户端日志事件进入记录，渲染成「说话人未知：…」会凭空造出说话人。因此标为 `editorial`。

## 6. 视频 1：身份答案与核验

`annotations/src-fe54eb89f162/private/roster_v2.json`，**10/10 座位 verified，0 处分歧**。四条独立通道互相印证：

1. 片尾「赛后」段底部席位条的正式揭示，**在 1470.5 s 与 1480.0 s 两帧分别读取**；
2. 「狼人盘刀」段（约 1345 s）只有四个坏人座位挂身份牌；
3. 正片开头的编导卡「拇指牌为2号和6号」——派西维尔的拇指对是 {梅林, 莫甘娜}，与揭示一致；
4. 客户端结算横幅点名刺客座位。

已验证阵营构成与配置的 `role_composition` 完全一致（4 坏 6 好）。OCR 在 1470.5 s 把两个身份词的首字读错，两帧一致化后消除，构成校验也通过——分歧记录在每个座位的 `consistency` 里。

`label.json` 的可选字段这次**有依据地填了**：`winning_side: good`、`assassin_seat: 4`、`assassination_target_seat: 10`、`assassination_hit: false`，来源写在 `final_outcome.basis`（客户端结算横幅）。这些**不在** input 里，也不在正文末尾。

## 7. 改了什么

```
SPEC.md                      加 §10（逐来源确认布局、redact、client_log、剪辑泄漏、系统提示、两级接受证据）
README.md                    新增第二来源的工作流与两个探针脚本
HANDOFF.md                   本文（旧版 HANDOFF.v3-agent-pairs-game1.md）
vbench/client_log.py         新增：线上客户端日志解析器，输出与 board.py 相同的 missions 结构
vbench/layout.py             新增 redact（keep_first_ink_run）+ apply_redactions；public_crops(redact=)
vbench/changes.py            presence 在未脱敏裁剪上算，之后一律用脱敏版
vbench/captions.py           parse_label 容忍脱敏残字（'電3号時' → 3 号），仍拒绝越界座位
vbench/pipeline.py           按 layout 的 parser 选择 board / client_log
vbench/block_text.py         标题改中性；只陈述实际出现过的轮次人数；湖中女神在场时如实写出
vbench/private_labels.py     build_label_v3 读取 roster 的 final_outcome（有公开揭示才填）
vbench/review_sheets.py      校对表支持只渲染需要决策的片段
vbench/schemas/              layout 加 redact / parser；private_roster 加 final_outcome
scripts/probe_layout.py      新增：从像素量布局（已在已知来源上回归验证）
scripts/check_overlap.py     新增：字幕 5-gram + 车队组合判断是否同局重剪
configs/layout.yuanzhuo-online-1080p-v1.json   新增：线上客户端布局
configs/game2-v1.BV12beJ69E8W.json             新增
configs/game3-v1.BV1kr876AEE1.json             新增（区间与规则仍是 UNVERIFIED 占位，视频未下全）
tests/test_online_client_layout.py             新增 17 项
```

产品代码（`src/`）一行没动。第一个来源（`full-v2b`）的运行产物、修正、缓存、API 试跑结果全部原样保留。

## 8. 测试

`python -m pytest` → **135 passed**（此前 118 项全部保留 + 新增 17 项）。`npx tsc --noEmit` 退出 0。`npm run check:imports` ✓。

新测试覆盖的实际新增行为：脱敏保留座位号而丢掉昵称与身份、居中排版下随文字宽度移动、单 token 标签保持完整、空标签不瞎猜、**presence 在脱敏前测量**、脱敏进缓存键、脱敏残字仍能解析座位且不接受越界座位；客户端日志读提名/车队/票数/填充色块投票、`自动通过` 为必做轮且无票型、`投票中` 不产生结果、任务计数不吞后面的成员色块、失败牌计数、**含答案的面板行被丢弃且不泄漏到任何结构里**、色块三色判别。

三种把握程度必须分开看：

| | 谁做的 | 本次状态 |
|---|---|---|
| 机器一致性 | 离线测试 | 135 项通过 |
| 独立通道佐证 | 本地 ASR（另一模态） | 390 条字幕 |
| CC 自审 | 同一个写管线的 agent，对着公开裁剪 | 197 条字幕、12 条事件、缺口与身份名单 |
| 用户或独立审阅 | 人 | **没有做**。没有人听过音频，也没有独立转写 |

## 9. 受阻项与未决项

1. **视频 2（`BV1kr876AEE1`）下载受阻。** 1080p avc1 流（264 MB）在 B 站 CDN 上反复断流：首次尝试两个视频都中途失败；视频 1 换成 1M 分块 + 无限重试后成功（141.7 MB 完整），视频 2 同样参数只到 86 MB 就停住不动，进程无输出、文件不再增长，重启续传后仍未推进。**已完成**：元数据与分 P 确认、音频下载、1105 段 ASR 已缓存、配置骨架已建。**未完成**：抽取、审阅、身份、pair——没有画面就无法开始，也**没有**用合成数据或占位产物冒充。可行的下一步是改用同为 1080p 的 HEVC 流（格式 30077，148 MB，约少 44% 字节）或换网络环境重试；换码流需要重新验证 OCR 质量，不能直接假设等价。
2. **视频 2 的布局与规则完全未知。** 不要假设它和视频 1 一样：这两个来源同一个 UP 主，布局却差了 58 px、面板从实体板变成客户端、还多了湖中女神。`scripts/probe_layout.py` 是为此准备的第一步。
3. **同局重剪判定尚未用内容证据完成**（见 §1）。
4. **视频 1 的两轮成功为何进入刺杀**，本片没有给出依据；记录不作断言，但这说明该客户端的规则可能与标准 10 人局不同，下一个线上来源要重新确认。
5. **视频 1 的强制轮没有讨论**，是客户端立即自动通过所致，不是剪辑缺口。正文按规则省略发言部分；如果评测方希望显式写一句，改 `speech_recorded == "empty"` 的渲染即可。
6. **1 条无字幕 ASR 片段**仍是 `needs_review`，只进 draft。
7. **字幕召回率未测**，理由见 §5；要测需要一份独立转写。

## 10. 复现

```powershell
$py = "..\data\video-benchmark\.venv\Scripts\python.exe"; $env:PYTHONIOENCODING = "utf-8"
$cfg = "configs\game2-v1.BV12beJ69E8W.json"
& $py scripts\probe_layout.py ..\data\video-benchmark\sources\raw\BV12beJ69E8W.video.mp4   # 先量布局
& $py -m vbench extract --config $cfg
& $py ..\data\video-benchmark\annotations\src-fe54eb89f162\authoring\derive_game2_corrections.py > d1.jsonl
& $py -m vbench corrections-import --config $cfg --run-scoped --file d1.jsonl
& $py -m vbench build --config $cfg
& $py -m vbench timeline --config $cfg
& $py -m vbench agent-pairs --config $cfg --dataset accepted
& $py -m pytest
```

抽取一次约 18 分钟（扫描 111 s + OCR 512 s，2043 帧转换；ASR 走缓存）。本次人工量约 3.5 h，主要在布局验证、三处泄漏的定位与修复、10 张校对表的逐行审阅，以及客户端日志解析器的校准。
