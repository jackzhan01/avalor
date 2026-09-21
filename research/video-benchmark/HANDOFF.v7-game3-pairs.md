# 交接给 Codex：第三局完成，三局都有了 input–label 对

任务书：`docs/claude-code-video-agent-pair-revision.md` 的呈现契约（每次组队一个 block）继续有效。语义与文件契约见 [SPEC.md](./SPEC.md)，命令见 [README.md](./README.md)。

历史交接全部保留：[HANDOFF.v6-game2-r1-trial.md](./HANDOFF.v6-game2-r1-trial.md)（上一版，第二局 r1 修订 + 第二次付费试跑）、[HANDOFF.v5-three-sources.md](./HANDOFF.v5-three-sources.md)、[HANDOFF.v4-two-videos-partial.md](./HANDOFF.v4-two-videos-partial.md)、[HANDOFF.v3-agent-pairs-game1.md](./HANDOFF.v3-agent-pairs-game1.md)、[HANDOFF.v2-timeline.md](./HANDOFF.v2-timeline.md)、[HANDOFF.v1-semantic-pilot.md](./HANDOFF.v1-semantic-pilot.md)。**每份里的数字只描述它那一版。**

**一句话结论：** 第三局 `BV1kr876AEE1` 的板面解析打通了，全片抽取完成，**4 轮任务、7 次组队、23 条板面事件、894 条字幕全部接受**，input–label 对与 5 个截止点已生成，0 校验错。三局内容级互不重叠。173 项离线测试通过，`tsc`、`check:imports` 通过。未提交、未推送、未改产品代码、**0 次付费调用**。

---

## 1. 真正的阻塞点不是之前判断的那个

上一版把第三局的阻塞记成「滚动板丢表头 + 水印遮挡 + 票型色块未标定」。前两条对，第三条对，但**都不是主因**。

**主因是板面矩形被截短了。** 旧 rect 是 `[1500, 8, 415, 225]`，只有 225 px 高。这块板**不滚动，而是向下追加**：开局只有一行，到片尾长到 y≈594。225 px 的窗口从头到尾只能看见最上面三行，所以无论怎么修解析器，都只能看到「第 1 轮 + 半行」——一局 4 轮任务的对局被截成了卡在第 1 轮。

把 rect 改成 `[1496, 2, 418, 592]` 之后，整局都在里面：

```
2号队长 → 7·8·9   第1/3次   3:7 → 否决组队
3号队长 → [水印]           [水印] 通过
任务成功 | 3号 7号 9号 | 成功 成功 成功
◆ 第2轮任务 · 需要4名队员 · 任务成功 ◆
4号队长 → 4·6·7·9  第1/3次   2:8 → 否决组队
5号队长 → 3·5·7·9  第2/3次   4:6 → 否决组队
6号队长 → 6·7·8·9  必做轮组队         必做轮
任务成功 | 6号 7号 8号 9号 | 成功 成功 成功 成功
◆ 第3轮任务 · 需要4名队员 · 任务失败 ◆
7号队长 → 6·7·8·9  第1/3次   7:3 → 通过组队
任务失败 | 6号 7号 8号 9号 | 失败 成功 成功 成功
◆ 第4轮任务 · 需要5名队员 · 任务成功 ◆
8号队长 → 3·7·8·9·10 第1/3次 6:4 → 通过组队
任务成功 | 3号 7号 8号 9号 10号 | 成功 ×5 | 保护轮
```

**扩大公开区域必须先证明不泄漏**：名单面板就贴在板面下方。用扩大后的 rect 在全片 11 个时刻 OCR，扫身份词和 10 个昵称，**0 命中**；名单本身位置固定在 y≈610 以下，从未进入板面矩形。

## 2. 另外三件实测出来的事

**票型编码在格子背景，不在数字墨色。** 第一局的板把票色画在座位数字上，这块板画在格子底色上，而且数字本身太暗、OCR 10 个格子只认得出 3 个。实测：

| | 色相 H | 饱和度 S | 亮度 V |
|---|---|---|---|
| 反对 | 9–13 | 130–148 | 55–58 |
| 同意 | 27–34 | 64–80 | 47–49 |
| 未投票（必做轮） | 3–7 或 ~177 | 59–68 | — |

标定后**六个比分逐一复现**（3:7、7:3、2:8、4:6、7:3、6:4），必做轮 10 格全部判为「无票」。格距也不一样：`seat1_x=43.97 / cell_dx=36.76 / strip_dy=23.8`，第一局是 `35.3 / 35.6 / 21.5`。这些现在写在 layout 的 `cells` 里、进 `region_config_sha`（改标定就不会复用旧缓存），默认值仍是第一局那套，**另外两局读数一字不变**（有测试钉死）。

**水印遮挡的那一行，用板面自己说的第二遍补回来。** bilibili 水印固定压在第 1 轮那条通过的提案行上，整片都读不出车队。任务结果行自己列出了执行队员「3号 7号 9号」，这就是那次组队的车队——板面说了两次。只在「该轮只有一次组队真的执行了」且「车队文字完全读不出」且「人数与该轮要求一致」时才回填，并打 `team_from_mission_row` 标记；三个条件差一个就留空。**客户端公告字幕「队长3号选择3号7号9号」独立印证了这个回填。** 那一行的比分数字同样被压住，`tally` 就留空——**没有从票型反推**，正文里那行只写「组队结果：车过了」。

**锚定改用客户端自己的公告。** 这局的客户端会用无发言人标签的字幕播报进程（「本轮任务需要五位玩家」「队长8号选择3号7号8号9号10号」「同意票数过半组队成功」「任务成功」「有一票破坏」）。板面首次出现的时刻是像素 diff 的产物，公告才是桌上所有人知道这件事的时刻，所以 23 条事件全部锚到对应公告的 **display_start**。这些公告被标为 `editorial`，不作为玩家发言进记录。

## 3. 第三局交付物（可直接打开）

根目录 `research/data/video-benchmark/runs/game3-v1/agent_pairs_v3/`

| 样本 | sample_id | block | 原话行 | 字符 |
|---|---|---|---|---|
| **完整正文** | `p3full-4f66354c16660919` | 7 | 63 | 9552 |
| m1 attempt 1 vote outcome | `p3-bcbf2d2ad1e7bd3b` | 1 | 10 | 1291 |
| m1 mission outcome | `p3-7f8bdd11c32514a0` | 2 | 20 | 2719 |
| m2 attempt 2 vote outcome | `p3-96377915f1174d4c` | 4 | 40 | 5742 |
| m2 mission outcome | `p3-ca5a451ebd503ce5` | 5 | 50 | 7346 |
| m3 mission outcome | `p3-0125783472255f09` | 6 | 53 | 7667 |

完整正文 `input_sha256` = `40c8dde6e82f7c9cb092975d8c7dbac09ad2ec04c1afa5cb7ae79b7c2cfe69b6`。每份带 `input.zh.txt`、`label.json`、`blocks.json`、`audit.json`；根目录有 `instruction.zh.txt`、`manifest.json`、`size_report.json`。私有名单 `annotations/src-be162536afaf/private/roster_v2.json`，可用区间 `annotations/src-be162536afaf/coverage.json`。

六份全部：schema 0 错、`input_sha256` 与文件字节/label/audit 三处一致、客观行不含身份词、覆盖说明各自独立（第 1 轮那份只说「到第 1 轮第 1 次组队为止」）、未核实的 `fails_required` 不入正文。

**可用区间 247.0–1797.23 s。** 客户端在 **1797.23 s** 把字幕从「任务成功」换成「任务成功，2号刺客决定发动刺杀」——直接点名刺客；1801.8 s 起发言人标签变成「刺杀梅林讨论」，字幕开始直说答案（「就刀（7号）Lucy吧」）。区间末端就卡在这两张卡之间（干净那张在 1795.87–1797.23 s，在记录内）。抽取跑到 1810 s，让切换点本身留在证据里。六份 input 扫「刺杀/盘刀/赛后/就刀/阵营获胜」等词：**0 命中**。

**私有身份 10/10 verified，两条通道互相印证**：名单面板（13 个快照）与未脱敏的发言人标签。身份构成正好是标准 10 人局（梅林/派西维尔/忠臣×4/莫甘娜/莫德雷德/刺客/奥伯伦）。

## 4. 字幕复核：894 条的实际分档

| 档 | 条数 | 依据 |
|---|---|---|
| A：独立音频通道（ASR）一致 | **588** | 两条独立通道吻合，**没有人逐条看过** |
| B：ASR 不佐证，看校对表逐行读过公开裁剪 | **265** | 12 张校对表全部读完；**只是「裁剪上写的就是这些字」，不是两通道一致** |
| 客户端公告（标为 editorial） | 41 | 不作为玩家发言进记录，只当锚点 |

**逐条对照裁剪后共做了 53 条文本修正**，分三类，每一类都是全量扫描而不是抽样：

1. **黄条左缘幻觉标点（41 条）**：OCR 在本片的渐变黄条左端读出「，」或「—」。41 张裁剪全部调出来看过，**没有一张真的有这个字符**。
2. **两位数座位号的空格被吞（7 条）**：编者写「2 4 10 3个人」，OCR 读成「24103个人」——语义完全不同。凡是文本里出现「含 10 的三位以上连写数字」的都逐条调裁剪核对；「我说了100遍了」是真的 100，没动。注意「379」「456」「6789」这类是阿瓦隆口语连写，属于忠实转写，不是错误。
3. **字形混淆（4 条）**：`自已→自己`（2 处，正确写法在全片出现 19 次）、`明自→明白`、`evenbetter→even better`。

此外顺带修了两个工具 bug：
- `build_roster_v2` 用昵称模糊匹配做一致性校验，"Jerry"（莫甘娜）与 "Jeremy"（忠臣）的 CER 恰好落在阈值内，把 9 号判成与自己的名单条目矛盾。**跨快照一致性抓不到这种系统性错配**——每个快照都会重复同一个错。改成：模糊匹配若同时命中另一座位的昵称就当作没有证据。
- `build_roster_v2` 里写死了一句「视频在第3轮第3次组队（必做轮）处结束」——那是**第一局**的事实，会被原样写进任何来源的名单文件。改成由调用方用 `--reveal-note` 传入。

## 5. 三局都是不同对局（内容级）

`scripts/check_overlap.py full-v2b game2-v1 game3-v1`：

| | 字幕 5-gram Jaccard | 共享车队组合 | 判定 |
|---|---|---|---|
| 第一局 vs 第二局 | 0.0038 | 0 | 不同对局 |
| 第一局 vs 第三局 | 0.0069 | 0 | 不同对局 |
| 第二局 vs 第三局 | 0.0095 | 1（第2轮的 6·7·8·9） | 不同对局 |

第二、三局共享一个车队组合只是常见队形的巧合，Jaccard 0.0095 不支持重剪。时长和文件 hash 不同不足以排除重剪，这一条是内容级判定。

## 6. 三件事各自完成到哪一步（第三局）

| 环节 | 谁做的 | 状态 |
|---|---|---|
| **媒体验真** | 脚本，全量 | **已完成**。`scripts/verify_media.py` 逐帧走完 56323/56323，verdict ok |
| **结构校验** | 离线脚本 + schema | **已完成**。6 份样本 0 校验错；四类 schema 全过；23 条板面事件逐条与板面截图核对一致 |
| **字幕复核** | CC 自审（同一个写管线的 agent，对着公开裁剪） | **全量看过，但只有一条通道**。588 条靠 ASR 佐证、265 条看裁剪读过。**这不是准确率** |
| **全文音频验真** | 人 | **没有做**。没有人完整听过音频，也没有独立转写。因此**不报字幕召回率** |
| **独立验收** | 人 | **没有做** |

## 7. 未决问题

1. **本片检测不到剪辑缺口，而这不等于没有。** 247–1797 s 内没有任何超过 6 秒的字幕间隔，而跳剪会同时带走音频，ASR 也看不出来。1550 秒装下 4 轮任务、7 次组队偏短，发言很可能在某处被压缩过。因为没有记录 gap，block 不会带「发言：部分未记录」标记——**记录可能把剪掉的发言呈现为连续**。已写进 `coverage.json` 和每份 `audit.json` 的 `open_questions`。
2. **265 条 tier-B 字幕只有一条通道。** 它们通过是因为「裁剪上写的就是这些字」，不是两条独立通道吻合。
3. **`fails_required` 只观察到第 3 轮**（4 张任务牌中 1 张失败即判负）；第 1、2、4 轮都是 0 张失败牌，说明不了阈值。配置里的 `[1,1,1,2]` 是标准规则，已列入 `unverified`，**不进模型输入**，只留在 audit 的 `rules_assumed` 和内部校验里。
4. **4 处昵称留在玩家原话里**（「拉拉你这把是不是好人」「我就直接跟Lucy刚到底了」等，涉及 3 号和 7 号）。管线**报告但从不删改**——别人说出口的名字是发言的一部分，改写它就是篡改记录。但拿到名单的人可以据此把昵称对回座位，去标识化的判断留给评测方。
5. **第 1 轮第 2 次组队没有比分数字**（被水印压住），正文只写「组队结果：车过了」。车队来自任务结果行，有 `team_from_mission_row` 标记和客户端公告双重印证。
6. **第二局的「两轮成功就进刺杀」仍未解释**（见 [HANDOFF.v6-game2-r1-trial.md](./HANDOFF.v6-game2-r1-trial.md) §5.1）。
7. **第一局（full-v2b）的产物比当前代码旧**，且没有重新生成——2026-09-19 的付费试跑用的正是当前这份，重生成会切断溯源。是否重生成留给仓库主人决定。
8. **第三局没有跑付费推理**。本轮 0 次付费调用。
9. **字幕召回率三局都未测**——没有独立转写。

## 8. 测试与检查（实际运行结果）

```
python -m pytest        → 173 passed  （此前 160 + 新增 13）
npx tsc --noEmit        → 退出 0
npm run check:imports   → ✓ 160 个文件
```

新增的 13 项都在 `tests/test_board.py`：

| 要钉死的 | 测试 |
|---|---|
| 背景色票型读数（同意/反对） | `test_cell_background_method_reads_votes_this_board_encodes_in_the_panel_tint` |
| 必做轮读成「无票」而不是「不清楚」 | `test_a_forced_round_reads_as_no_vote_rather_than_as_unclear` |
| 另外两局的数字墨色读法一字不变 | `test_the_digit_ink_method_is_untouched_by_the_new_one` |
| 数字条读不到时回退到**本板**格距 | `test_a_missing_digit_strip_falls_back_to_this_boards_pitch_not_another_boards` |
| 任务行记录实际执行队员 | `test_the_mission_row_records_who_actually_ran_the_mission` |
| 水印遮挡的车队从任务行回填 | `test_a_team_the_overlay_covered_is_taken_from_its_own_mission_row` |
| 人数对不上就拒绝回填 | `test_the_overlay_fill_refuses_when_the_seat_count_contradicts_the_round` |
| 两次组队都可能执行时拒绝回填 | `test_the_overlay_fill_refuses_when_two_proposals_could_have_run` |
| 组队序号从板面行序补 | `test_an_unreadable_proposal_number_comes_from_board_row_order` |
| 行序与已写序号矛盾时留空 | `test_proposal_numbers_stay_null_when_the_stated_ones_contradict_row_order` |
| 改标定会改缓存键 | `test_recalibrating_the_cells_changes_the_region_cache_key` |
| 一字之差的昵称不互相佐证身份 | `test_two_nicknames_one_edit_apart_do_not_confirm_each_others_roles` |
| 片尾揭示文案不写死 | `test_the_end_of_video_reveal_note_is_not_baked_in_from_another_source` |

## 9. 复现

```powershell
$py = "..\data\video-benchmark\.venv\Scripts\python.exe"; $env:PYTHONIOENCODING = "utf-8"
# 逐来源量布局，不要照搬；板面是追加式的，rect 必须覆盖片尾高度
& $py scripts\probe_layout.py ..\data\video-benchmark\sources\raw\BV1kr876AEE1.video.hevc.mp4
& $py -m vbench inspect-layout --config configs\game3-v1.BV1kr876AEE1.json --times 420,1069,1500,1875
& $py -m vbench extract --config configs\game3-v1.BV1kr876AEE1.json
# 审阅：A 档 + 公告 + 锚定，然后 B 档校对表，再逐条文本修正
& $py ..\data\video-benchmark\annotations\src-be162536afaf\authoring\derive_game3_corrections.py > draft.jsonl
& $py -m vbench corrections-import --config configs\game3-v1.BV1kr876AEE1.json --run-scoped --file draft.jsonl
& $py -m vbench build --config configs\game3-v1.BV1kr876AEE1.json
& $py -m vbench timeline --config configs\game3-v1.BV1kr876AEE1.json
# 私有名单（不打印身份）
& $py ..\data\video-benchmark\annotations\src-be162536afaf\authoring\derive_game3_roles.py --write
& $py -m vbench private-roster-v2 --config configs\game3-v1.BV1kr876AEE1.json --times 300,700,1100,1500,1875 `
      --reveal-note "..."
& $py -m vbench agent-pairs --config configs\game3-v1.BV1kr876AEE1.json --open-question "..."
& $py scripts\check_overlap.py full-v2b game2-v1 game3-v1
& $py -m pytest
```
