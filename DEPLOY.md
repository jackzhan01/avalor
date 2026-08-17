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
| Environment Variables | **不需要** | 纯本地存储，没有任何密钥 |

Node 版本如果可选，选 **20.x**（项目里的 `.nvmrc` 已经写了 20.9.0）。

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

- 所有对局记录存在浏览器的 **IndexedDB** 里，**不会离开这台设备**
- 没有后端、没有账号、没有任何网络请求发送游戏数据
- 换设备 / 清浏览器数据 = 记录消失。打完一局建议在「对局设置 → 导出 JSON」存一份
- 日后如果接 Supabase 做账号和云端同步，届时数据会离开设备，需要在注册流程里明确告知用户
