# 交接给 Codex：提前截止点 + 输入消融实验（第三局 m3）

> 2026-09-21 后续工程交接见文末 §8。以下 §1–§7 保留实验当时的记录；其中“未提交、未推送”和 197 测试是历史状态，不是当前仓库状态。

任务书：`docs/claude-code-video-agent-pair-revision.md` 的呈现契约（每次组队一个 block）继续有效。语义与文件契约见 [SPEC.md](./SPEC.md)，命令见 [README.md](./README.md)。

历史交接全部保留：[HANDOFF.v8-game3-trial.md](./HANDOFF.v8-game3-trial.md)（上一版，第三局完整局试跑）、[HANDOFF.v7-game3-pairs.md](./HANDOFF.v7-game3-pairs.md)、[HANDOFF.v6-game2-r1-trial.md](./HANDOFF.v6-game2-r1-trial.md)、[HANDOFF.v5-three-sources.md](./HANDOFF.v5-three-sources.md)、[HANDOFF.v4-two-videos-partial.md](./HANDOFF.v4-two-videos-partial.md)、[HANDOFF.v3-agent-pairs-game1.md](./HANDOFF.v3-agent-pairs-game1.md)、[HANDOFF.v2-timeline.md](./HANDOFF.v2-timeline.md)、[HANDOFF.v1-semantic-pilot.md](./HANDOFF.v1-semantic-pilot.md)。**每份里的数字只描述它那一版。**

**一句话结论：** 在第三局「第 3 轮任务结果揭晓后」这个截止点上跑了两个条件，各一次调用，合计 **$0.4519**。**完整信息（A）抓到 4 个坏人里的 1 个、误伤 1 个好人，阵营 0.60；删掉全部玩家发言（B）后，十个座位的阵营判定一个都没变，也是 0.60——两者都只是打平「全判好人」基线。** 197 项离线测试通过，`tsc`、`check:imports` 通过。未提交、未推送、未改产品代码。累计付费调用 **5** 次。

---

## 1. 实验目录与精确路径

`research/data/video-benchmark/api_trials/2026-09-21-gpt6-astra-game3-m3-ablation/`

总报告 `REPORT.zh.md`，机器可读对照 `comparison.json`，冻结设计 `experiment.json`，免费基线 `baselines.json`。

| | A：完整信息 | B：仅客观事件 |
|---|---|---|
| 目录 | `A-full/` | `B-objective-only/` |
| sample_id | `p3-0125783472255f09` | `abl-13383aee0d4a8adb`（派生） |
| input sha256 | `6ee170578e23b91d87cc4311fdce7d5957a67b07a3c8a0f7934236bb5df2900d` | `8db12d5db8187beac67189faee19780c91c6b6fb1f76414b43d7b1841e924ada` |
| 规模 | 7667 字符 / 53 行原话 | 653 字符 / **0 行原话** |

来源经 manifest 核对为 `m3 mission outcome`（`cutoff_sequence` 724，`public_at` 1481.8 s）。**A 就是导出产物本身，一字节未改；来源 label 也未被修改**，B 的 label 是派生副本（`seats` 逐字相同，`derived_from` 指回来源）。

## 2. 两组的唯一差别，是验证过的

调用前 41 项预检全部通过：两组的 **40 行客观字段逐行完全相同**，表头（规则、身份构成、座位、湖中女神、覆盖说明）逐字相同，两组都写明「第3轮任务失败 / 失败牌：1」，都不含第 4 轮任何内容、不含刺杀信息；**B 没有任何玩家发言，包括「说话人未知」**，也没有「本段未见玩家发言」「发言未记录」这类说法——省略是实验处理，不能写成记录里没有。

预检抓到一个真问题：`blocks.json` 按字典序规范化写盘，直接重渲染会把「身份构成」一行重排成字母序，两组就差了两件事而不是一件。已按来源文档顺序还原（`vbench/ablation.py: composition_order`），并有测试钉死。

提示词与输出 schema **逐字节／逐结构**复用第三局完整试跑（instruction sha `6330bfca…`，`text.format` canonical JSON 相等），**没有为「无发言」另写提示词**。两组请求在第一次调用前就全部写好并冻结，脚本对每个条件只允许一次调用。

## 3. 费用与结果

| | A | B | 合计 |
|---|---|---|---|
| request id | `req_1303a7f5c9144b979d9eeca6ac16a150` | `req_029e89b253044efebde6688a526caa35` | |
| status / 耗时 | `completed` / 112.03 s | `completed` / 74.05 s | |
| token（入/出/推理） | 6717 / 4068 / 2588 | 1005 / 3425 / 2070 | |
| **费用** | **$0.2706** | **$0.1813** | **$0.4519** |

每次 ≤ $2，合计 ≤ $4。价格当天重新核对，与前三次一致。

| 指标 | A | B | 基线：全判好人 | 基线：末次票型 |
|---|---|---|---|---|
| 阵营准确率 | **0.60** | **0.60** | **0.60** | **0.50** |
| Brier | 0.2335 | 0.2405 | 不适用 | 不适用 |
| 身份准确率 | 0.20 | **0.00** | — | — |
| unknown | 4 | **10** | — | — |

基线不给概率就不算 Brier。「末次票型」取第 3 轮第 1 次组队（车主 7 号，7:3），**没有读第 4 轮**，10 个座位的票全部有记录、无 unclear/unrecorded。

### 最重要的三点观察

1. **阵营判定在两组之间一个都没变。** 十个座位的好坏判定完全一致；变的只是具体身份（A 给出 6 个具名身份，B 对全部十个座位答 unknown）和概率（平均 |Δ| = 0.096，最大 0.28 在 7 号）。
2. **两组都没有超过「全判好人」，只是打平。** A 多认出 6 号莫甘娜，但同时误伤 8 号忠臣，净值抵消。真坏人 1、2、5 在这个截止点都被判成好人（0.35 / 0.29 / 0.44），它们在完整局里才翻正（0.62 / 0.57 / 0.67）。
3. **概率明显向 0.5 收缩。** 完整局四个坏人全部 ≥ 0.57、六个好人全部 ≤ 0.42，落在 0.40–0.60 的座位是 **0** 个；本截止点 A 有 4 个、B 有 5 个。0.58 / 0.55 不是「认定是狼」，0.44 / 0.45 也不是「认定是好人」。

## 4. 引用核对

| | A | B |
|---|---|---|
| 客观断言 | **31 / 31** | **63 / 63** |
| 逐字引用（含先后顺序判定） | **18 / 19** | **0 / 0**（无可引） |
| 判不了（读意图），不计通过 | 10 | 0 |

**B 没有编造任何玩家发言**：依据里带引号的片段 0 条，「说 / 称 / 表示 / 发言」等词出现 0 次。（自动扫描发现 B 的一条 uncertainty 里有与 A 某句发言重合的 6-gram「可能只是好人」，是常见说法的巧合，不是引用。）

**A 唯一未通过的一条**与完整局那次是同一个错误：模型称 5 号「没有执行 7 号要求的 3789」，行为描述对，但「3789」在该截止点正文里首次出现是在 5 号提名之后。用 `quote_before` 抓出。

核对时每条「某座位说过什么」的断言都检索了该座位的**全部**发言。一例：模型引 2 号「不觉得4号玩家底牌一定是匪徒」逐字搜不到，查完五段发言后在第四段找到「首先我没觉得4号 玩家底牌一定是匪徒」（字幕换行带来的空格），实质属实。

## 5. 未验证 / 不能推断

1. **不能把 A、B 的差异当作「发言」的因果效应。** 每条件只有一次采样，无重复、无多种子；平均 |Δ| 0.096 与采样噪声同量级。
2. **不能因为 B 与 A 阵营相同就说发言无用**，也不能因为 A 身份略好就说证明了语言推理能力。数据支持的说法只有：这一次、这个截止点上，删掉发言没有改变任何一个阵营判定。
3. **本局可能存在未识别的剪辑删减。** 247–1797 s 内无超过 6 秒的字幕间隔，跳剪会同时带走音频、ASR 也看不出来。A 看到的发言可能不是完整讨论；这对 A 不利且无法量化。
4. **全文音频验真未完成。** 588 条字幕靠 ASR 佐证，265 条只有「裁剪上写的就是这些字」一条通道。不报字幕召回率。
5. 本次**没有**新增其它截止点、没有重复采样、没有换模型或提示词。五次付费调用各自只是一次试跑。

## 6. 测试与检查（实际运行结果）

```
python -m pytest        → 197 passed  （此前 179 + 新增 18）
npx tsc --noEmit        → 退出 0
npm run check:imports   → ✓ 160 个文件
```

新增 `tests/test_ablation.py`（18 项），分两类：

| B 必须去掉的 | B 不得改动的 |
|---|---|
| 没有任何玩家发言（含说话人未知） | 客观行逐行相同且顺序不变 |
| 绝不写「无人发言 / 未记录」 | 表头除说明行外逐字相同 |
| 去掉发言说明行，但仍说明自己装了什么 | 身份构成顺序被还原（重排会被抓出） |
| | 派生 label 保留 seats/scoring，只重绑哈希，不动来源 |
| | 消融构造函数的签名与函数体里没有 label / roster / private |

另有基线的行为：强制轮无票所以被跳过、没有票的座位报未覆盖而不是猜、全场无票型时报 unavailable、硬分类基线不给 Brier。

## 7. 复现

```powershell
$py = "..\data\video-benchmark\.venv\Scripts\python.exe"; $env:PYTHONIOENCODING = "utf-8"
& $py scripts\run_ablation.py --freeze        # 生成 A/B + 41 项预检，不花钱
& $py scripts\run_ablation.py --confirm A     # 唯一一次 A 调用
& $py scripts\run_ablation.py --confirm B     # 唯一一次 B 调用
& $py scripts\run_ablation.py --score         # 离线评分，唯一读 label 内容的一步
& $py scripts\check_trial_evidence.py `
      ..\data\video-benchmark\api_trials\2026-09-21-gpt6-astra-game3-m3-ablation\A-full `
      ..\data\video-benchmark\runs\game3-v1\agent_pairs_v3\cutoffs\p3-0125783472255f09\blocks.json `
      ..\data\video-benchmark\api_trials\2026-09-21-gpt6-astra-game3-m3-ablation\A-full\claims.json
& $py -m pytest
```

## 8. 批次流水线与服务器接力（2026-09-21）

初步实验停止在上面的 A/B 结果，没有新 API 调用。研究基线已提交并推到 `origin/dev`：`a354bcb`（包含此前未入库的研究代码、规范、测试与历史交接）。产品代码和 `main` 没动；工作区其他人的 `eslint.config.mjs`、AGENTS 和未跟踪文档没有混入提交。

### 已实现

- `vbench/batch.py` 与 batch CLI：显式清单、CPU/int8 默认、冻结配置/布局/代码/schema/依赖文件/运行环境、run 预留、单 worker 锁、阶段落盘、显式失败重试。
- `vbench/media_gate.py`：完整解码并绑定 SHA-256；下载 watchdog + `.download` 续传；完整校验后才晋升正式媒体名。常规 ASR 缺模型只报错，不隐式联网。
- 两道人审关口：布局审核、标注审核。凭据绑定媒体/配置/证据字节。未审核、空数据、缺锚点、修正冲突、身份未核实、缺截止点均不能发布。
- `vbench/publish.py`：先在临时目录生成完整 pair，再整体晋升。旧目录只允许字节相同的幂等结果，不覆盖旧版；已有版本变化需新 revision/run。
- 修复公开时间边界：片头、跨越赛后边界的字幕卡不会因起点落在对局里而漏入 input；客观事件也检查上下界。保留全部旧产物，不重新导出以免切断已付费实验的哈希溯源。
- 同局初筛缺文件/空证据时不再判“不同局”。阈值仍仅初筛，最终 group/split 需要审核。

操作说明：[BATCH.md](./BATCH.md)。示例清单：`configs/batch.pilot3.json`。新增 29 个离线测试，总计 **226 passed**；覆盖媒体校验、下载晋升顺序、拒绝隐式 ASR 下载、冻结/互斥/重试、完整审核→full + 两个截止点发布、材料变更后重新审核、防覆盖与缺截止点时整套不发布。`tsc --noEmit` 和 `check:imports` 通过。发布全链路使用明确标为 synthetic 的离线夹具，不是真实新数据集。

### 验证边界与未完成项

真实媒体验收批次：`research/data/video-benchmark/batches/pilot3-cpu-v1/state.json`。三局全部完成完整视频/音频解码，分别为 61,310 / 44,673 / 56,323 视频帧，视频时长 2043.667 / 1489.100 / 1877.436 秒；与音频时长差均小于 0.11 秒。三任务均为 `layout / needs_review`，重跑 state 完全不变。**未自动批准布局，未重新 OCR/ASR，未发布新的真实 pair**。这次只实测了真实媒体阶段与暂停/恢复门槛，不冒充真实数据发布全链路验收。

三个完整解码报告在 `research/data/video-benchmark/sources/verified/`，state 中 `jobs[].media` 保存同一份结果；口型同步明确为 `not_verified`。运行前后检查了三局所有 `agent_pairs_v3*` 目录及整个 `annotations/` 共 **200 个文件**，路径数量与逐文件 SHA-256 全部一致。没有覆盖旧 input/label、修正链或私有名单。本次新增付费调用为 0，未触发下载。

这不是自动标注整位 UP 主的流水线。未知布局、事件真实公开锚点、字幕逐条审核、身份/刺杀核实和剪辑完整性判断仍需人审；不自动抓取 UP 主列表，没有后台付费推理。没有新增召回率结论，也没有完整听音频验真。

Linux/服务器安装和吞吐未实测；本机验证是 Windows/Python 3.11。Git 不含 `research/data/video-benchmark/`，服务器需另行私有传输媒体、模型、缓存、标注和历史 pair；不要搬 Windows venv 或 key。新机器新建批次，不修改冻结 state 绕过环境检查。旧版命令尚未全部接入批次锁，不得并发写同一数据根/run。

源级 coverage/roster 可以复用作证据，但新 run 不自动继承旧 accept；必须审核后才进入 release。剪辑完整性状态目前留在 release 的 `quality.json` 和审计问题中，不会自动改写历史 block 的 coverage 声明。
