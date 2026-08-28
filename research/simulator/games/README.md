# research/simulator/games —— 精选的真实对局公开回放

这里放**挑出来留档的**真实对局回放。跑出来的东西默认落在 `../out/`，
那个目录整个被 gitignore（体积会长、还混着私有轨迹）。
只有值得回头看的局才复制到这里、重命名、进仓库。

---

## 只有公开层进仓库

每局跑完会产出两份文件：

| 文件 | 内容 | 进不进仓库 |
|---|---|---|
| `<gameId>.public-replay.jsonl` | 桌面上任何人都看得到的东西：发言、车单、票型、任务结果、局终亮牌 | **进**，就是这里的文件 |
| `<gameId>.private-trace.jsonl` | 发牌、seed、每个座位的私有认知块、模型逐次请求 | **不进**，只在本地 |

私有轨迹是"偷看答案"的那一份 —— 它包含每个座位在**每一步**知道什么、在想什么。
任何拿这份数据做的分析都不再是盲的。所以它留在 `../out/private/`，不分发。

公开回放的最后一条 `game_end` 事件带 `reveal`（全场身份）。**这不是泄露** ——
局已经结束了，线下也是这时候亮牌。想做盲分析就丢掉最后一条事件。

文件名里没有 seed，`gameId` 也和 seed 无关（不透明 id）。重跑要复现得自己记 seed。

---

## 目前留档的三局

三局用的是**同一副牌**（同 seed），任务失败序列也完全一样，
差别只在提示栈、schema 和策略档。文件名 = 日期 + 提示版本 + 策略档。

| 文件 | 提示版本 | 策略档 | 事件 | 提案 | 车过/被否 | 发言 | **身份声称** | 退水 | 结局 |
|---|---|---|---|---|---|---|---|---|---|
| `2026-08-24-prompt-0.2.0-community-meta` | 0.2.0 | `community-meta` | 92 | 6 | 3 / 3 | 66 | 4 | 0 | 坏人 3:0 |
| `2026-08-26-prompt-0.3.0-expert-cognitive` | 0.3.0 | `expert-cognitive` | 106 | 7 | 3 / 4 | 77 | **0** | 0 | 坏人 3:0 |
| `2026-08-27-prompt-0.4.0-expert-claim-contest` | 0.4.0 | `expert-claim-contest` | 64 | 4 | 3 / 1 | 44 | **6** | 0 | 坏人 3:0 |

三局都是 `gpt-5.6-terra`、`reasoning effort=high`、`heterogeneous-rotated` persona、十个模型座位。
三局都**没进刺杀** —— 坏人连挂三把，好人一分没拿到。

原始 gameId（对得上 `../out/` 里的私有轨迹）：

```
2026-08-24-prompt-0.2.0-community-meta        g-92362cf4-7043-40db-8ba5-bfa7d7928709
2026-08-26-prompt-0.3.0-expert-cognitive      g-a0b76ac9-7d1d-4946-a0ca-4c350d8b2c2e
2026-08-27-prompt-0.4.0-expert-claim-contest  g-6ebccca0-5978-4b1f-a0cf-1c99af014c08
```

---

## 这三局**不是**受控实验

看着像一条演进线，但**每一格都同时动了好几个变量**：提示栈、策略档、
输出 schema、动作格式、输出上限（0.3.0 是 20,000，另两局 12,000）在三局之间全都换过。
`n = 1`，同一副牌，同一个模型。

所以下面这些只能当**描述性观察**读，不能当因果：

- 身份声称 4 → **0** → **6**。0.3.0 那局十个座位一次身份都没跳，
  真派西维尔在私有记录里把同一条触发条件写了十七遍，从头到尾没跳。
  0.4.0 加了公开派权争夺之后，两个人（其中一个是莫甘娜，抢在真派前面 40 个 sequence）
  争同一个身份，对跳 4 次。
- 三局全是坏人 3:0，**这说明不了任何事**。三局同一副牌，样本量是 1。

要得出结论得跑多 seed。目前没跑过。

---

## 怎么读

每行一个 JSON。第一行 `public-metadata`（配置、座位、模型、提示版本），
中间全是 `event`（按 `sequence` 排，`sequence` 是唯一的顺序真相），
最后一行 `outcome`。

```bash
# 只看发言
python -c "
import json
for l in open('2026-08-27-prompt-0.4.0-expert-claim-contest.public-replay.jsonl',encoding='utf-8'):
    e=json.loads(l)
    if e['t']=='event' and e['data']['type']=='speech':
        d=e['data']; print(d['sequence'], d['speaker'], d.get('claim') or '-', d['publicMessage'][:100])
"
```

事件 schema 见 [`../core/events.ts`](../core/events.ts)，
公开层怎么从完整状态里裁出来的见 [`../README.md`](../README.md) 第五节。
