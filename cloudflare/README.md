# flitfancy Worker 部署

这里是 `api.flitfancy.com` 对应的 Cloudflare Worker 发布根目录。

## 本地验证

```powershell
cd S:\FlitFancy\site\cloudflare
pnpm install --frozen-lockfile
pnpm run check
```

`pnpm run check`：CI 安全（Linux/Windows 通吃）——语法检查 + 单测 + Wrangler dry-run，
不含 Python，不会部署。
`pnpm run check:all`：本地完整验证 = `check` + 后端冒烟测试（需本机 `py -3.14`）。
冒烟测试只在本机跑，绝不能接进 `check`——Workers Builds 的构建机是 Linux，
没有 `py` 启动器，接进去会让每次构建失败、自动部署静默中断。

## Workers Builds

在 Cloudflare 的 `flitfancy` Worker 中连接 GitHub 仓库 `flitfancy/flitfancy`：

- Production branch：`main`
- Root directory：`cloudflare`
- Install command：`pnpm install --frozen-lockfile`
- Build command：`pnpm run check`
- Deploy command：`pnpm run deploy`
- Non-production deploy command：`pnpm run preview`
- Include paths：`cloudflare/*`、`tests/worker-fail-closed.test.mjs`

`worker.js` 只负责入口与路由；安全/HTTP、D1 迁移、访问统计、内容、传感器、
配置缓存和 AI 转发分别位于同目录的 `worker-*.js` 模块中。不要绕过
`worker-core.js` 直接在领域模块里另写鉴权或 CORS 规则。

注意：`package.json` 声明了 `packageManager: pnpm@11.19.0`，请确认 Cloudflare
后台的 Install/Build/Deploy 命令与上面一致（全部用 pnpm），避免 npm 与 pnpm 混用。

运行时密钥 `ADMIN_TOKEN`、`AI_API_KEY` 只保存在 Cloudflare Secrets。
仓库仅声明必需的密钥名称，不保存任何密钥值。
`ADMIN_TOKEN` 必须是至少 32 个字符的随机固定令牌，并与本机
`backend/ai_local.json` 的 `worker_admin_token` 保持一致。

`wrangler.jsonc` 还声明三个 Cloudflare Rate Limiting 绑定：
`ADMIN_FAILED_AUTH_LIMITER`、`CHAT_RATE_LIMITER`、`TRACK_RATE_LIMITER`。
Worker 优先使用原生限流；绑定临时不可用或本地单测未提供绑定时才退回 KV 计数。
