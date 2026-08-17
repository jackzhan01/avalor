# 部署到 Vercel

三步，全部在网页上完成，不需要装 Vercel CLI，也不需要把任何凭证交给别人。

## 1. 导入仓库

1. 打开 [vercel.com/new](https://vercel.com/new)，用 GitHub 账号登录
2. 在列表里找到 **`jackzhan01/avalor`**，点 **Import**
   - 如果列表里看不到（私有仓库常见），点 **Adjust GitHub App Permissions**，把 `avalor` 勾上再回来

## 2. 直接点 Deploy

所有设置保持默认即可，Vercel 会自动识别出这是 Next.js 项目：

| 设置项 | 值 | 说明 |
|---|---|---|
| Framework Preset | Next.js | 自动识别 |
| Build Command | `next build` | 默认 |
| Output Directory | `.next` | 默认 |
| Install Command | `npm install` | 默认 |
| Environment Variables | 只有要用 AI 功能才填 | 见下 |

Node 版本如果可选，选 **20.x**（项目里的 `.nvmrc` 已经写了 20.9.0）。

### 想开 AI 功能的话

在 Vercel 的 **Settings → Environment Variables** 里加：

| 变量名 | 值 | 必填 |
|---|---|---|
| `OPENAI_API_KEY` | 你的 key | 是 |
| `AI_MODEL` | 比如 `gpt-5.4-mini` | 否，默认 `gpt-5.4-mini` |
| `AI_BASE_URL` | OpenAI 兼容服务的地址，填到 `/v1` 为止 | 否 |

三个环境（Production / Preview / Development）都勾上，加完要**重新部署一次**才生效。

不填也能正常部署，只是圆桌下面那两个按钮点了会提示「服务端还没配置」，App 的其余部分完全不受影响。

**key 不要提交进仓库。** 本地开发放 `.env.local`（已在 `.gitignore` 里），线上只放在 Vercel 的环境变量里。它只被 `/api/ai` 这个服务端路由读取，不会进浏览器的 bundle。

### 想开账号与 AI 白名单的话

AI 用的是**我们自己付费**的 key，而 `/api/ai` 挂在公网上。没有闸门的话，任何人拿到地址就能无限刷账单——公网上有专门扫这种开放 LLM 代理的爬虫。所以只要填了 `OPENAI_API_KEY`，就必须同时把下面这组也填上：

| 变量名 | 说明 |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase → Project Settings → API |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | 同上，公开钥匙，会进浏览器 |
| `SUPABASE_SERVICE_ROLE_KEY` | 同上，**万能钥匙，只能放服务端** |
| `AI_ENABLED` | `true`。出事时改成 `false` 重新部署即可全站停用 AI |
| `AI_PRICE_IN_PER_M` / `AI_PRICE_OUT_PER_M` | 模型单价，美元 / 每百万 token。**不填 AI 直接停用**——算不出花了多少钱的预算不叫预算 |
| `AI_MONTHLY_BUDGET_USD` | 全站月度硬上限，按 UTC 自然月 |
| `AI_DAILY_REQUESTS` | 单人每日调用上限 |

数据库表结构见 [supabase/schema.sql](supabase/schema.sql)，在 Supabase 的 SQL Editor 里跑一次即可，可重复执行。

> **⚠️ 部署完成后必须回 Supabase 补一步，否则线上登录一定失败：**
>
> Authentication → **URL Configuration**
> - **Site URL** 改成你的正式地址（如 `https://avalor.vercel.app`）
> - **Redirect URLs** 增加 `https://avalor.vercel.app/**`
>
> 这一步最容易漏，而且症状具有迷惑性：本地一切正常，线上验证码能收到、输进去却登不上。

**开通内测用户**：让对方先自己注册一次（登录页走一遍），然后在 Supabase → Table Editor → `profiles` 找到那一行，把 `ai_enabled` 勾成 `true`。注册不等于能用 AI，默认是关的。

**看这个月花了多少**：SQL Editor 里跑

```sql
select round(sum(cost_usd), 2) as usd, count(*) as calls
from public.ai_usage
where created_at >= date_trunc('month', now());
```

首次构建约 1–2 分钟，完成后会给一个 `https://avalor-xxxx.vercel.app` 的地址。

## 3. 手机上打开并装到桌面

用手机浏览器打开那个 HTTPS 地址，然后：

- **iPhone（Safari）**：分享按钮 → 「添加到主屏幕」
- **Android（Chrome）**：右上角菜单 → 「安装应用」/「添加到主屏幕」

**这一步不是可选的。** iOS Safari 会清理超过 7 天没访问过的网站数据，而这个 App 的记录全部存在浏览器本地。装成 App 之后就不受这个清理影响。

---

## 之后怎么更新

推到 `main` 分支，Vercel 自动重新部署：

```bash
git push
```

## 本地开发

```bash
npm install
npm run dev     # http://localhost:3000
npm test        # 跑 selector 单元测试
npm run build   # 验证生产构建
```

### 想在手机上调试本地版本

```bash
npm run dev -- -H 0.0.0.0
```

然后手机访问 `http://<电脑的局域网IP>:3000`。

注意：这种方式**不是安全上下文**，`crypto.randomUUID` 不可用。代码里 `src/lib/utils/id.ts` 已经写了 `getRandomValues` 回退，所以能正常跑 —— 但这也是为什么那个回退不能删。

---

## 关于数据

- 所有对局记录存在浏览器的 **IndexedDB** 里
- **不用 AI 就不需要账号。** 登录只在点 AI 按钮时才要求，服务端也只存三样东西：邮箱、白名单标记、AI 用量流水——没有任何一局牌的内容
- **不开 AI 功能的话，游戏数据一个字节都不会离开设备**
- 开了的话：只有用户主动点「分析局势」/「帮我发言」时，才会把**那一局**的记录（含他的身份和推测）发给模型服务商。首次使用会明确询问，发出去的内容随时可以在结果页原样查看
- 换设备 / 清浏览器数据 = 记录消失。打完一局建议在「对局设置 → 导出 JSON」存一份
- 日后如果接 Supabase 做账号和云端同步，届时数据会离开设备，需要在注册流程里明确告知用户
