# Avalor — 给 agent 的仓库约定

线下《阿瓦隆》对局的实时记录本。产品是什么、为什么这么设计，看 [README.md](./README.md)，**不要在这里重复**。

这份文件只放两类东西：**违反了会出 bug 的不变量**，和**不知道就会重复造轮子的东西**。它进每个 agent 的上下文，所以每多一行都在收税 —— 加内容前先问这条是不是真的每个 agent 都需要。

---

## 语言

- **界面文案、提交信息以外的对话，全部中文**，用桌游圈黑话：点车 / 上车 / 保 / 踩 / 上票 / 下票 / 好人 / 坏人 / 车过了 / 车被否 / 连挂。不要写"提案""投赞成票"。
- **代码注释用英文**，和现有代码保持一致。注释解释*为什么*，不解释*是什么*。

## 数据语义（改动前必读）

README 的「几条不肯妥协的数据语义」是地基，`src/lib/selectors/*.test.ts` 是它的执行版本。最容易被无意破坏的四条：

1. **`null` ≠ `3`。** 没表过态和明确说「看不清」是两回事。任何 `?? 3` 都是 bug。
2. **改口不覆盖历史。** 当前值 = `sequence` 最大的那条，旧的全留着。
3. **票型存座位级完整向量**，不存票数。`'unknown'`（记为不清楚）≠ 键不存在（根本没记）。
4. **`finalResult` 权威**，绝不从票型反推 —— 记了一半的票会反推出很自信的错误结论。

另外两条同样是硬约束：

- **排序只认 `sequence`，不认 `timestamp`。** 设备时钟会跳。
- **私有层必须能整层剥离。** `role_mark` 等私有事件不进时间线、可从导出中剔除。公开表达（他说了什么）和私有信息（我知道什么）混进同一个流，将来任何基于这份数据的分析都是在偷看答案。

## 架构不变量

- **事件溯源。** 不可变追加日志是唯一真相，界面状态全部由 `src/lib/selectors/` 的**纯函数**推导。selector 不碰 React、不碰 Dexie、不碰 `Date.now()`。
- **只有 `src/lib/db/` 能 `import dexie`。** 组件只从 `@/lib/selectors` 和 `@/lib/store` 取数据。
- **`sequence` 永不重排、永不复用。** 删除留空洞 —— 撤销删除靠的就是这一点。
- **`missionNumber` / `proposalNumber` 是缓存不是真相。** 任何编辑或删除之后必须跑 `assignContext()`。
- **水合门闸。** `"use client"` ≠ 不在服务端渲染。首次渲染必须是骨架屏且不能碰 Dexie，用 `useHydrated()`。
- **`crypto.randomUUID` 需要安全上下文**，手机走局域网 http 时没有 —— `lib/utils/id.ts` 的回退不能删。

## 花钱的接口

`/api/ai` 用**我们自己付费**的 key 调模型，而且挂在公网。它必须、且第一件事就是：

```ts
const access = await checkAccess();      // @/lib/auth/gate
if (!access.ok) return fail(access.error, access.status);
```

**任何情况下都不要把这两行删掉或挪到后面。** 没有它，任何人拿到 URL 就能无限刷账单——公网上有专门扫这种开放 LLM 代理的爬虫。四道闸依次是：全局熔断 `AI_ENABLED` → 已登录 → `profiles.ai_enabled` 白名单 → 每日次数与月度金额配额。

调用成功后必须 `recordUsage(access.userId, task, data.usage)`，否则配额永远算不出来。前端要展示按钮状态就打 `/api/ai/status`，别自己另写一套判断——两套逻辑迟早对不上。

## 别重复造的东西

动手写新组件前先看这里有没有现成的：

| 要做的事 | 用 | 位置 |
|---|---|---|
| 底部弹层 | `Sheet`（分层用 `onBack` + `layerKey`，不要开第二个） | `components/ui/sheet.tsx` |
| 页眉 + 返回 | `PageHeader` / `RoundButton` | `components/ui/page-header.tsx` |
| 牌桌页底部操作区 | `Dock` + `DockHeader` / `RatingRow` / `ConfirmRow` / `VoteRow` | `components/game/mode-bar.tsx` |
| 圆桌 | `RoundTable`（三个角标槽 + `mark`） | `components/table/round-table.tsx` |
| 分组列表 | `ListGroup` / `ListRow` / `ListAction` | `components/ui/list.tsx` |
| 确认 | `ConfirmDialog`（**只给破坏性操作**，记录类一律靠撤销） | `components/ui/dialog.tsx` |
| 提示 + 撤销 | store 的 `snackbar`，别自己弹 | `components/ui/snackbar.tsx` |

**底部避让契约：** 任何固定在底部的新面板都要用 `useBottomSurface(ref, "--dock-h" | "--sheet-h")` 上报实测高度，否则提示条会盖在它上面。量 `offsetHeight` 不量位置 —— 这些面板都是 transform 滑进来的。

## 样式

- Tailwind v4 + `globals.css` 里的 iOS 语义色 token。**不要写死颜色**，用 `var(--label-secondary)` 这类。
- 深色模式只靠 `prefers-color-scheme`，不做 class 切换、不读 localStorage。
- 触控目标 ≥ 44px（视觉可以更小，用 `::after` 撑热区，见 `RoundButton`）。
- 底部安全区用 `.pb-safe`。

## 命令

```bash
npm test          # 339 项单测，改 selector 或 inference 必跑
npx tsc --noEmit
npm run build
npm run dev -- -H 0.0.0.0
```

只有 npm（无 pnpm/yarn），Node 20.9，Next 锁 15.x。

## 分支：`main` 是生产环境

**`main` 已经上线，推上去 1–2 分钟后用户就用上了。所以不要直接推 `main`。**

在 `dev` 上开发：

```bash
git checkout dev
git pull origin dev     # 别人可能刚推过
# ... 改代码 ...
git push origin dev
```

合进 `main` 由**仓库主人决定**，agent 不要自己合。要发布时告诉他，或者他自己开 PR。

判断标准很简单：**这次改动，你敢让正在牌桌上记录的人立刻用上吗？** 敢就可以提合并，不敢就先留在 `dev`。

## 多 agent 协作

这个仓库同时有多个 agent 在工作。

- **提交只 `git add` 自己改过的路径，不要 `git add -A`。** 别人可能正好有个写到一半的文件在工作区。提交前 `git status` 扫一眼。
- **提交后跑一次 `npm run check:imports`。** 只 add 自己的路径有个陷阱：你的文件可能 import 了别人**还没提交**的文件，于是仓库里留下悬空引用。这种错本地永远发现不了（文件都在磁盘上，`tsc` 和 `build` 全过），只有 CI 的干净 checkout 会炸，而且报错指向被 import 的模块，不指向漏提交的人。已经因此挂过一次部署。
- **不要 `taskkill /F /IM node.exe`。** 会连带杀掉别人的 dev server 和测试进程。`.next` 被锁住就换个办法。
- **不要在这个文件里维护「谁在做什么」。** 那种信息几分钟就过期，而且会让本该防冲突的文件自己变成冲突点。要并行改同一批文件就开 branch 或 worktree。
- 高频冲突文件：`src/app/game/[gameId]/page.tsx`（牌桌页什么都往里挂）。动它之前先 `git pull`。
