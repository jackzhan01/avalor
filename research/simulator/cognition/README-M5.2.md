# M5.2 —— 派权争夺（public Percival-claim competition）

M5 的复审包在 [README.md](./README.md)，M5.1 在 [README-M5.1.md](./README-M5.1.md)。
这份只写**这一轮改了什么、为什么、以及哪些东西被冻住了**。

跑一遍完整复审包（离线，零网络，不读 key）：

```bash
npx vite-node -c research/simulator/vitest.config.ts \
  research/simulator/scripts/m5-2-review.ts
```

---

## 一、起因：M5.1 假设了一个还没发生的东西

`social.ts` 问的是「谁在带节奏、我跟不跟」。这个问题**预设权威已经落定**。

强局的早期常常不是这样：两三个人同时自称派西维尔，各有一套故事，互相攻击，
跟随者在他们之间来回移动。在那个局面里问一个座位「谁是焦点」，
等于让它回答一个牌桌自己还没回答的问题。

而且真派西维尔**不自动是唯一的焦点**。莫甘娜、梅林、忠臣、刺客、莫德雷德、
奥伯伦，每一个都可能跳派西维尔，动机和手上的信息各不相同。

所以 M5.2 建的不是「选出领袖」，是「争夺过程」。

---

## 二、公开侧：`claim-contest.ts`

裁判拥有，**只从公开事件推导**。每个函数的输入都是 `PublicEvent[]`，
没有任何参数能让发牌进来 —— 所以这里的任何一个状态都不可能意味着「这个声称是假的」，
只可能意味着「这个声称被那条公开记录质疑了」。

五种公开状态：`none` / `implied` / `active` / `contested` / `retracted`。

记录的事件：

| 事件 | id | 说明 |
|---|---|---|
| 声称 | `k{seq}:claim` | 带 `repeat`（改口）和 `counter`（对跳）标记 |
| 退水 | `k{seq}:retract` | 记着退的是哪一次声称 |
| 声称期间要车 | `k{seq}:team` | |
| 声称者之间的表态 | `k{seq}:rival:{seat}` | 从 `stances` 推，不读发言文字 |
| 旁观者的表态 | `k{seq}:side:{seat}` | |

`k…` 在 M5.1 的 registry 里解析成**硬事实** —— 但它只证明「这件事发生过」。
「8 号说他是派西维尔」是事实；「8 号是派西维尔」不是，那仍然是 `c…`。

### 退水从不删除

`退水` 把状态从 `active` 改成 `retracted`，然后**把挂在那次声称上的东西全留着**：
什么时候说的、讲过什么候选对、推过什么车、声称期间踩过谁。

这是刻意的：一个看不到被退掉了什么的牌桌，无法判断这次退水是什么。
「有计划的掩护」和「撑不住了」这两种，只有对着原来的东西才分得开。

### 暗示只从结构读

`implied` 只有一种触发方式：一次发言里对**恰好两个**座位给出方向相反的公开表态，
而且没有声称任何身份 —— 「这两个人里一个是梅林一个是莫甘娜」的形状。

**不读发言文字。** 用关键词把一句自信的话变成公开事实，是这一层最危险的失败模式。

---

## 三、私有侧：`contest.ts`

每个座位的账本多一块**有界的**派权模型，五个部分：

| 部分 | 回答什么 |
|---|---|
| `ownClaimStrategy` | 我在不在场上、讲什么故事、什么会让我进场或退水 |
| `claimantAssessments` | **所有**声称者的对比评估，每条带 `premiseIds` |
| `rivalPlan` | 只在我自己也在场上时：怎么削弱他、他会怎么答、什么能分开我们 |
| `alignment` | 我支持谁、支持他的哪一句话、落到哪一票、什么会让我换边 |
| `publicClaimMove` | 这一步我在牌桌上真正要做的动作 |

### 打声称 ≠ 指认坏人

`currentAssessment` 的取值是 `leading` / `plausible` / `contested` / `weak` / `broken`，
**每一个都在评价那个声称**。一个编了掩护故事又被戳穿的忠臣是 `broken` 而且是好人。

整个 schema 里没有 `evil` / `good` / `morgana` / `merlin` 这些取值 ——
`percival` 只出现两次，都是**动作**（`claim-percival` / `counterclaim-percival`）。
有测试直接数这个。

### 系统覆写的三样

- `publicClaimStatus` —— 裁判填的。一个座位不能自己决定竞争者退水了。
- `restsOnUnverified` —— registry 算的。
- `evidenceResolves` —— registry 算的。

三个都不在 wire schema 里。理由和 `premiseVerified` 一样：
一个模型填了、系统又覆写的字段，迟早会有人信它。

### 六条「有争议」的跳派考量

关于**跳派西维尔**这件事，一共有**六条**标了「有争议」，对应六种身份：

| # | id | 身份 |
|---|---|---|
| 1 | `ecc.morgana-many-lines` | 莫甘娜先跳 / 对跳 / 防守 / 退水 / 捧别人 |
| 2 | `ecc.merlin-claim-tradeoff` | 梅林跳派当掩护 |
| 3 | `ecc.loyal-claim-tradeoff` | 忠臣跳派当掩护或代理焦点 |
| 4 | `ecc.assassin-claim-tradeoff` | 刺客跳派挑动反应 |
| 5 | `ecc.mordred-claim-tradeoff` | 莫德雷德用干净记录跳派 |
| 6 | `ecc.oberon-claim-tradeoff` | 奥伯伦跳派制造混乱 |

**六条全部是可选的**，每条都同时写了收益和代价，没有一条是必须执行的动作。
其中两条（忠臣、奥伯伦）额外标了 `obligation` —— 那约束的是**必须看到什么**，
不是必须做什么，渲染成「必须看到」…（有争议）。这两个恰好是**手上信息最少**的身份：
忠臣没有候选对，奥伯伦不知道队友，所以那个信息缺口的代价是他们不能漏看的东西。

数目由测试钉死（`scenarios-contest.test.ts`），不靠在散文里数 —— 这份工作的一版报告
就是在散文里写了「五条」然后列了六条。

---

## 四、结构一致性检查（`contestProblems`）

**每一条比对的都是结构化字段，没有一条读发言文字。**
用关键词判断一段自然语言论证好不好，会把用词不同的好打法一起拒掉。

| 检查 | 拒绝什么 |
|---|---|
| `attack` / `endorse` / `challenge` | 目标必须是真的声称过的人，不能是自己 |
| `defend-own-claim` / `retract-claim` | 需要自己有（或有过）成立的声称 |
| `counterclaim-percival` | 需要桌上已经有别人在声称 |
| `claimedOrImpliedPair` | 必须正好两个**不同**座位 |
| `requestedTeam` | 人数符合这一轮的车，不能重复 |
| `premiseIds` / `evidenceIds` | 走 M5.1 的可见性 registry |
| **动作原子性** | 说要跳就得在动作的 `claim` 里跳；说要退水就得填 `retractClaim` |
| **可见性** | `attack` / `endorse` 要在动作的 `stances` 里有对应表态 |
| **竞争者全覆盖** | 站在派西维尔上的人少评一个就打回 |
| **不能照抄** | `hidden→hidden` 且理由和上一轮一字不差就打回 |

最后两条是 Part E 和 Part F 的结构化版本：
「竞争者不能当作平行意见」和「一句复制的拖延理由不算理由」现在是机器能拒的东西。

---

## 五、退水成了一等公开动作

`SpeechAction.retractClaim?: boolean`。裁判两条规则：
不能退一个你没做过的声称，不能一边退水一边声称新身份（那是改口，`recordClaim` 已经处理）。

**和 `claim: null` 不是一回事** —— `claim` 填 null 只是这次发言不谈身份，
之前的声称仍然成立；填 `true` 才是当众撤回。提示里明写了这条。

**只在为 true 时才写进事件**，所以 0.2.0 / 0.3.0 / 0.3.1 的每一次发言重放
仍然逐字节一致 —— 四局既有产物全部重新验证通过。
speech 的 schema 也按版本门控：只有 0.4.0 会看到这个字段。

---

## 六、被冻住的东西

| | 状态 |
|---|---|
| `default.json` / `m5-pilot.json` / `m5-1-pilot.json` | 一个字节没动 |
| `baseline` / `community-meta` / `expert-cognitive` / `expert-social` 指纹 | 全部未变（有测试断言）|
| `COGNITION_LIMITS`（0.3.0）、`COGNITION_LIMITS_V2`（0.3.1） | 冻结 |
| `DECISION_PROTOCOL_LAYER` / `PUBLIC_BRIDGE_LAYER` | 冻结，新的六步在 `CLAIM_CONTEST_LAYER` |
| `COGNITION_INSTRUCTION` / `_V2` | 冻结，`_V3` 是 append 而不是重写 |
| 裁判既有规则 | 一条都没放松（只新增了两条退水规则）|

`expert-claim-contest` spread 了 `expert-social`，后者又 spread 了 `expert-cognitive`。
测试断言继承的是**同一批对象**（`toBe`，不是 `toEqual`），所以三档不可能悄悄分叉。

`prompt-0.4.0` 与 `expert-claim-contest` 是**一一绑定**的，拆开重组会被配置校验拒绝。

---

## 七、还没验证的东西

- **M5.1 也还没跑过真实对局。** 0.3.1 和 0.4.0 的真实成本、真实重问率、
  真实认知块大小，全部没有实测数据。复审包里的成本行是假设，写在表里就是为了被质疑。
- **0.4.0 的结构检查比 0.3.1 严得多。** 第一次真实对局的重问次数可能上升，
  尤其是「竞争者全覆盖」和「不能照抄」这两条。2 次修复之后仍然不合法就终止 ——
  那是需要人来看的信号。
- **脚本替身不会争论。** 它跳、它退水、它攻击，但论证全是占位。
  真实模型会不会真的把竞争者当竞争者处理，只有付费对局能回答。
- **压缩路径仍然没有被真实触发过。** `olderArguments` 三个版本里都是 0。
