# 交接给 Codex：五局试点第一局 + 本地运行保护（2026-09-21）

任务书：`docs/claude-code-video-agent-pair-revision.md` 的呈现契约继续有效。语义见 [SPEC.md](./SPEC.md)，批次操作见 [BATCH.md](./BATCH.md)。

历史交接全部保留：[HANDOFF.v9-m3-ablation.md](./HANDOFF.v9-m3-ablation.md)（上一版，消融实验 + 批次流水线）、[HANDOFF.v8-game3-trial.md](./HANDOFF.v8-game3-trial.md)、[HANDOFF.v7-game3-pairs.md](./HANDOFF.v7-game3-pairs.md)、[HANDOFF.v6-game2-r1-trial.md](./HANDOFF.v6-game2-r1-trial.md)、[HANDOFF.v5-three-sources.md](./HANDOFF.v5-three-sources.md)、[HANDOFF.v4-two-videos-partial.md](./HANDOFF.v4-two-videos-partial.md)、[HANDOFF.v3-agent-pairs-game1.md](./HANDOFF.v3-agent-pairs-game1.md)、[HANDOFF.v2-timeline.md](./HANDOFF.v2-timeline.md)、[HANDOFF.v1-semantic-pilot.md](./HANDOFF.v1-semantic-pilot.md)。**每份里的数字只描述它那一版。**

**一句话结论：** 五个候选里**定位到 3 个**（另 2 个 + 替补被站内风控挡住，需要补链接）；第一局 `BV1dc8F6qE5K` 已下载并**逐帧验真通过**，布局已独立勘察——**这是第四种布局，且片头会直接念出身份**。补齐了下载/内存/显存/积压/清理五类运行保护与子进程隔离，并修好了那条联网的预算测试。**没有生成任何 input–label，没有付费调用**，三局历史产物 50 个文件哈希逐一复核未变。262 项离线测试通过，`tsc`、`check:imports` 通过。未提交、未推送、未改产品代码。

---

## 1. 来源定位：3 / 5，另 2 个需要你补链接

清单落盘在 `research/data/video-benchmark/sources/candidates.2026-09-21.json`，含每一次搜索尝试与失败原因。

UP 主 UID **3707017160035210 = 圆桌谜局**，由已处理的 `BV1kr876AEE1` 页面返回同一 `uploader_id` 反查确认。截图只给月日，此处的 `upload_date` 全部来自站内页面本身，**没有自行补年份**。

### 已定位（四项核对一致：作者 UID、标题、时长、发布日期）

| 截图候选 | BVID | 时长 | 发布 | 标题 |
|---|---|---|---|---|
| 3（8月21日 37:12） | **BV1dc8F6qE5K** | 2231.13 s = 37:11 | 20260821 | 阿瓦隆奥伯伦冲锋，莫甘娜倒钩，狂搅局炸两车后梅林心态崩了 |
| 4（7月29日 42:47） | **BV1WB316PEig** | 2566.13 s = 42:46 | 20260729 | 阿瓦隆莫德雷德打法教学，双炸一点不慌 |
| 5（7月17日 30:59） | **BV1mzNd6QEN8** | 1858.90 s = 30:58 | 20260717 | 阿瓦隆梅林跳派最多且派西维尔胜率为0%之人 |

标准链接为 `https://www.bilibili.com/video/<BVID>`。三个都不在已处理的 `BV19D7565EZg` / `BV12beJ69E8W` / `BV1kr876AEE1` 之列。

### 未定位（需要补标准视频链接）

| 截图候选 | 标题 | 状态 |
|---|---|---|
| 1（9月10日 35:13） | 阿瓦隆当你的梅林第一轮被锁定，你会怎么打？ | 搜索四轮未排进结果；该标题的查询多次被 412 拦下 |
| 2（8月28日 31:31） | 阿瓦隆大莫巧使离间计，派梅互打天崩局 | 同上，第 1/3/4 轮均被风控拦下 |
| 替补（7月8日 35:35） | 阿瓦隆莫德雷德跳派欧莫打法…真派点错拇指牌 | 搜索有结果但不含本 UP 该视频 |

**试过的四条通道**：`space.bilibili.com/<uid>/video` 页面（SPA 外壳，无数据）、`x/space/arc/search`（错误页，需签名/登录）、`x/web-interface/search/type`（错误页）、yt-dlp `bilisearch`（4 轮、20 条查询，间隔从 12 秒加到 95 秒）。最后一轮 5 条里 4 条被 412 拦下。**按约定不猜 BV 号、不绕过风控，停在来源确认阶段。**

## 2. 第一局 `BV1dc8F6qE5K` 的实测数据

| 阶段 | 结果 |
|---|---|
| 下载 | 视频 30077 HEVC **180.82 MB / 700.2 s**；音频 30280 **30.07 MB / 110.1 s**；合计 **812 s**，无停滞、无重试耗尽 |
| 磁盘增量 | **+0.21 GiB**（下载前可用 109.1 GiB） |
| 逐帧解码验真 | **verdict ok**：66934 帧、2231.132 s、最大帧隙 0.0334 s（正好一帧）、音视频时长差 **0.089 s**；报告在 `sources/verified/` |
| 验真耗时 / 内存 | **128.8 s**，峰值 RSS 仅 **103 MiB**（解码是流式的，内存很便宜） |
| 布局勘察 | 见 §3，记录在 `runs/_layout_probe/BV1dc8F6qE5K.survey.json` |
| 待审核量 | **0**——尚未抽取，没有产生待审条目 |
| 付费调用 | **0** |

下载时有个操作失误已修正：给音频传了空 `--suffix`，脚本按默认命名存成了 `.video.mp4`。已用 PyAV 确认该文件只含 aac 音频流后改名为 `.audio.m4a`，两个文件的内容哈希都写进了验真报告。

### ASR 实测（本机，GPU）

不靠估计：用本片 300–480 s 的音频真跑了一次 `faster-whisper large-v3 / CUDA / float16`。

| | 实测 |
|---|---|
| 主机内存峰值 RSS | **3169 MiB** |
| 显存占用 | 约 **3571 MiB**（跑前可用 5642 → 跑中 2071） |
| 转写速度 | 180 s 音频用 85.3 s = **2.1 倍实时** |
| 模型载入 | 11.5 s |

按这个速度，本片 2231 s 的音频单 ASR 约需 **18 分钟**，再加 OCR。

**GPU 探测通过**：RTX 4060 Laptop，ctranslate2 CUDA 分配成功。**OCR 只能走 CPU**——`onnxruntime.get_available_providers()` 只有 `AzureExecutionProvider` 和 `CPUExecutionProvider`，没有 CUDA provider。这与「GPU 跑 Whisper、CPU 跑 OCR」的设想一致，是实测结论不是假设。

## 3. 布局勘察：这是第四种布局，且片头会念出身份

**同一批玩家、不同一局。** 观众名单里的十个人与第三局相同，但身份分配不同（10 号凡哥此局是忠臣，第三局是梅林；1 号 Chris 此局是梅林，上局是奥伯伦）。不是重剪。

| 项 | 实测 | 与第三局的差别 |
|---|---|---|
| 黄条字幕 | `[468, 900, 902, 76]`，37 帧采样中 36 帧有条 | 第三局是 `[484, 908, 870, 60]`，**不能照搬** |
| 无底条字幕 | **确实存在**：1 帧无条但有描边文字（占比 0.0338） | 必须配 `subtitle_plain` 兜底 |
| 发言人标签 | 约 `[124, 904, 340, 66]`，形如「10号 凡哥 忠臣」 | 同样**含身份**，必须 `keep_first_ink_run` 脱敏 |
| 记录板 | 约 `[1503, 0, 417, 506]`，语法与第三局相同，同样向下追加 | **水印遮挡更严重**：压在最上面两行的票型格与比分上 |
| 观众名单 | 约 `[1520, 600, 400, 470]`，全片可见，逐座位含身份 | 私有区域 |

**阶段边界（60 秒粗扫的近似值，未逐帧定界）：**

- **片头 0–约 220 s，而且 t≈70 s 的字幕直接是「忠臣忠臣刺客」**——本局片头会念出身份。前三局的片头没有这种形态，这一段必须整段排除。
- 正片约从 250 s 开始（t=250 已是正片发言）。
- 存在客户端式公告字幕：t≈1450「有一票破坏」、t≈2170「请6号7号9号10号玩家出征做任务」——和第三局一样可以拿来做事件锚点。
- t≈2230 发言人标签变成「赛后」。

**规则变体尚未核实**：人数、强制轮、湖中女神、失败牌阈值都还没有从板面逐项读出。

## 4. 补齐的本地运行保护

新增 `vbench/runguard.py`、`vbench/cleanup.py`、`vbench/extract_worker.py`，并接进 `vbench/batch.py`。

| 要求 | 实现 |
|---|---|
| 下载前查磁盘 | `require_disk`，**调用时实测**，还要求下载后仍留 5 GiB 余量 |
| 重处理前查内存/显存 | `require_memory` + 显存门槛，同样调用时实测；**不复用冻结批次时的快照** |
| 独立子进程 | `EXTRACT_RUNNER` 默认为 `_extract_in_subprocess`；模型随子进程退出释放，子进程自己回报峰值 RSS |
| 失败可恢复、不误伤 | 失败只影响本局；代码里没有 `taskkill` / `os.kill` / `terminate()`（有测试扫源码钉死） |
| 分阶段状态 | media / layout / extract / review / publish / done，逐阶段落盘 |
| 限制积压 | `require_backlog_capacity`：默认最多 2 个、6 GiB 未处理媒体；从各批次 state 统计，不是列目录 |
| 默认不删原视频 | `cleanup-preview` 只看不删；`cleanup-apply` 必须带授权串 `DELETE-SOURCE-MEDIA`，且逐条重新校验 |
| 删除前置条件 | 该局 done、有标注审核凭据、产物已发布且目录存在、有媒体验证报告、**没有其他任务依赖该文件** |
| 保护共享资产 | `annotations / models / cache / api_trials / batches / runs / sources/verified / evaluator / variants` 永不进候选；数据根之外一律拒绝 |
| 不靠清缓存腾内存 | `cleanup.py` 里没有 `drop_caches` / `EmptyWorkingSet` / `rmtree`（有测试钉死） |
| GPU 不可用时明说 | `resolve_device` 返回 `changed=True` 和原因；批次遇到降级**直接报错停下**，不静默换后端 |

**资源门槛有实测依据，不是拍脑袋**（`DEFAULT_LIMITS`）：内存 3.5 GiB（实测 ASR 峰值 3.10 GiB）、显存 4000 MiB（实测约 3571 MiB）。门槛在 `batch-init` 时冻结进 state，后续运行不能调低；合成夹具在清单里显式声明零门槛，所以测试不依赖本机剩多少内存。

真实数据根上的清理预览验证过：**6 个源媒体全部判为不可删**，每个都列出 3–4 条拦截理由；用错误授权串删除被 `PermissionError` 拒绝。

新命令：`vbench resources`、`vbench cleanup-preview`、`vbench cleanup-apply --path ... --authorize ...`。

## 5. 预检问题处理

**Pillow 声明**：工作区里 `requirements.txt` 与 `requirements.lock.txt` 把 pillow 从 12.3.0 改成 11.0.0 的未提交改动**是对的**——实测环境 `PIL.__version__ == 11.0.0`。已核实，未覆盖。

**那条联网的测试已真正修好，不是放过它。** 根因：`count_tokens` 调 `tiktoken.get_encoding`，本机没有 BPE 缓存时会去下载，被离线保护拦下。做法：

- `budget_check` 新增 `count` 参数，默认仍是真实 tokenizer；
- `count_tokens` 在取不到编码时抛出**说明原因**的 `RuntimeError`（提示设 `TIKTOKEN_CACHE_DIR` 预取），不再暴露成 socket 错误；新增 `tokenizer_available()`；
- 原来那条测试拆成 **6 条**，用已知 token 数的计数桩，断言从不等式变成**精确金额**（`1.2613`、`7.5019`），并新增：计数器必须看到全部三段文本、默认必须是真实 tokenizer、缓存缺失时报错要点名原因。

验证方式是把 `TIKTOKEN_CACHE_DIR` 指向空目录再跑同一批测试——**仍然全过**，确实不依赖本机缓存或网络。没有放开网络、没有 skip、没有削弱断言。

## 6. 测试与检查（实际运行结果）

```
python -m pytest        → 262 passed   （此前 225 passed + 1 failed）
npx tsc --noEmit        → 退出 0
npm run check:imports   → ✓ 160 个文件
```

新增 `tests/test_runguard.py`（31 项），覆盖点名的九类：子进程退出（真的起一个子进程跑失败配置，断言它仍写出结果、退出码 1、报告自己的峰值内存）、资源不足（磁盘/内存/积压三类，用受控读数）、下载中断（积压上限）、任务恢复（门槛冻结）、审核阻断（未完成/无凭据/未发布/无验证报告四种拦截）、历史产物不变（发布目录保留）、清理目标限制（数据根之外、七类受保护前缀）、共享媒体保护（其他任务依赖时拒绝）、未授权禁止删除。

**注意一处测试设计变化**：`tests/test_batch.py` 现在通过 `batch.EXTRACT_RUNNER` 这个接缝在进程内打桩，因为生产路径已改成子进程。`test_reprocessing_runs_in_a_child_process_by_default` 钉死默认值就是子进程实现。

## 7. 历史产物完整性

| 检查 | 结果 |
|---|---|
| 三局 4 个 `agent_pairs_v3*` 目录、25 份样本的 input/label | **50 个文件哈希逐一比对，0 个不符** |
| `annotations/` 三个来源 | 12 / 29 / 8 个文件，树哈希已记录在本轮日志 |
| `api_trials/` 四次实验 | 10 / 14 / 12 / 27 个文件，未改动 |
| 付费调用总数 | **5**（本轮新增 **0**） |

## 8. 受阻与未完成

1. **候选 1、2 与替补未定位**，需要你补标准视频链接。不猜 BV 号。
2. **第一局尚未抽取。** 布局需要逐项标定并过 `batch-approve --kind layout` 的人审关口；片头/正片/赛后边界只有 60 秒粗扫的近似值，需要逐帧定界；规则变体未核实。
3. **没有 input–label，没有待审队列**——本轮只做到「媒体可信 + 布局看过一遍」。
4. **候选 4、5 未下载**，按你的停止规则等第一局数据出来后再决定是否同配置继续。
5. **本机内存在 1.4–4.0 GiB 之间波动**（总 16.5 GiB，其余被其他程序占用）。抽取门槛 3.5 GiB 会在内存紧时把任务拦下——这是设计行为，不要为了跑通把门槛调低。
6. **全文音频验真**三局都未做，本局同样没有独立转写。
7. 口型同步在验真报告里明确标为 `not_verified`。

## 9. 恢复命令

```powershell
$py = "..\data\video-benchmark\.venv\Scripts\python.exe"; $env:PYTHONIOENCODING = "utf-8"
& $py -m vbench resources                       # 当下的磁盘/内存/显存/设备决策
& $py -m vbench cleanup-preview                 # 只看不删
# 继续第一局：先标定 layout，再建批次（batch-init 会冻结配置与代码指纹）
& $py scripts\probe_layout.py ..\data\video-benchmark\sources\raw\BV1dc8F6qE5K.video.hevc.mp4
& $py -m vbench inspect-layout --config configs\<新配置>.json --times 300,700,1500,2120
& $py -m vbench batch-init --file configs\batch.<新批次>.json
& $py -m vbench batch-run --batch <新批次> --download
& $py -m vbench batch-review-info --batch <新批次> --run-id <run>
& $py -m pytest
```
