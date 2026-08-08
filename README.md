# 云萤 · flitfancy 网站仓库

小流萤的家 + 控制台。前后端分离：

- `docs/`：公开网站（首页 / 项目 / 日志 / 控制台 / 关于），GitHub Pages 从**这个目录**发布（命名为 docs 是因为 GitHub Pages 的目录下拉框只认 `/` 和 `/docs`）
- `backend/`：本地控制台服务（server.py + SQLite），只在你的电脑上跑，不发布

## 本地运行

```powershell
cd D:\桌面1\flitfancy\site\backend
python server.py
```

然后打开 http://localhost:2671/

## AI 对话（控制台的“对话”面板）

对话由本地服务转发到兼容 OpenAI Chat Completions 格式的 AI 服务，**密钥只存在本地**，
不会出现在网页代码或公开仓库里。当前为**单纯转发**：消息原样发给 AI 服务，不注入人设或背景知识。
公网访客走 Cloudflare Worker（见下文），密钥存在 Cloudflare 加密变量。

配置（环境变量优先，否则读取 `backend/ai_local.json`，该文件已被 gitignore 排除）：

```json
{
  "base_url": "https://api.deepseek.com",
  "api_key": "sk-…",
  "model": "deepseek-chat",
  "system": ""
}
```

`system` 留空则不附加任何角色设定；以后做人设与背景知识时，填在这里即可。
管理面板的“模型选择”内置：DeepSeek Chat、小米 MiMo（mimo-v2.5），并支持自定义。
切换模型会自动切换对应接口。可用服务举例：

- DeepSeek：`https://api.deepseek.com`，模型 `deepseek-chat`
- 小米 MiMo：`https://api.xiaomimimo.com/v1`，模型 `mimo-v2.5`
- 通义千问：`https://dashscope.aliyuncs.com/compatible-mode/v1`，模型 `qwen-plus`
- Kimi（Moonshot）：`https://api.moonshot.cn/v1`，模型 `moonshot-v1-8k`
- 智谱 GLM：`https://open.bigmodel.cn/api/paas/v4`，模型 `glm-4-flash`

对应环境变量：`FLITFANCY_AI_BASE_URL` / `FLITFANCY_AI_KEY` / `FLITFANCY_AI_MODEL` / `FLITFANCY_AI_SYSTEM`。

请求示例：`POST /api/chat`，body `{"messages":[{"role":"user","content":"你好"}]}`。

管理账号：`backend/ai_local.json` 的 `admin_accounts` 中配置（用户名 + 密码哈希，不存明文）；
改密码用 `python server.py --set-password <用户名> [新密码]`，无此账号时自动创建。
登录需要本地服务（公网静态页无管理功能）。

管理层功能：
- 模型选择（写回 ai_local.json 的 model/base_url）
- “AI 请求权限”开关（chat_enabled）：关闭后本地 /api/chat 返回 403，
  并尝试同步到公网 Worker（见下文 KV 配置）
- 快捷入口：可新增/编辑/删除，点击用小弹窗打开（存 quick_links）

## 公网对话（Cloudflare Worker，可选）

让 flitfancy.com 上的访客也能直接对话。代码在 `cloudflare/worker.js`，
已部署并绑定 `api.flitfancy.com`（前端 `console.js` 的 `PUBLIC_API` 指向它）。
部署/更新步骤：

1. 注册 Cloudflare（免费）→ Workers & Pages → Create → Worker，起个名字并部署；
2. 用 Edit code 打开编辑器，把 `cloudflare/worker.js` 的内容整个粘进去，再 Deploy；
3. Settings → Variables and Secrets → 添加机密：
   `AI_API_KEY`（AI 服务密钥）、`ADMIN_TOKEN`（与 ai_local.json 的 worker_admin_token 相同）；
4. 建一个 KV 命名空间并在 Settings → Bindings 里绑定，变量名 `CONFIG`
   （用于公网“AI 请求权限”开关存储）；
5. 部署后在 Settings → Domains 绑定 `api.flitfancy.com`。

可选变量：`AI_BASE_URL`（默认 DeepSeek）、`AI_MODEL`（默认 deepseek-chat）、
`AI_SYSTEM`（人设/背景，留空则不附加）。

Worker 额外端点：
- `GET /config`：返回公网 chat_enabled（前端离线时据此禁用聊天框）
- `POST /admin/toggle`：本地管理层同步开关用（需 Bearer ADMIN_TOKEN）

## GitHub Pages 发布设置

- Settings → Pages → Source: **Deploy from a branch**
- Branch: **main**，目录选 **/docs**
- 自定义域名与 HTTPS 已配置，无需改动

## 后端 API

- `POST /api/ingest`：接收感知板 STREAM/WiFi 数据（CSV 行或 JSON）
- `GET /api/status`：服务状态
- `GET /api/sensors/latest`、`/api/sensors/history`：传感器数据
- `GET/POST /api/notes`：她的记忆
- `POST /api/command`：命令队列（转发到板子下一步接入）
- `POST /api/chat`：AI 对话（转发到兼容 OpenAI 格式的服务，密钥只在本地）
- `POST /api/admin/login|logout`：管理登录/登出（用户名 + 密码，失败锁定）
- `GET/POST /api/admin/config`：管理配置（模型、开关、快捷链接；需登录令牌）

数据落在 `backend/data/flitfancy.db`（已被 .gitignore 排除，不会推送到公开仓库）。

## 结构

```text
site/
├── docs/                 ← GitHub Pages 发布根
│   ├── index.html        首页
│   ├── project.html      项目现状
│   ├── journal.html      造物日志
│   ├── console.html      控制台
│   ├── about.html        名字与理念
│   ├── assets/           样式与脚本
│   ├── CNAME             自定义域名（必须留在发布根）
│   └── .nojekyll
├── backend/              ← 本地服务（不发布）
│   ├── server.py         控制台服务
│   ├── smoke_test.py     冒烟测试
│   └── data/             本地数据（gitignore）
├── .gitignore
└── README.md
```

新增日志：在 `frontend/journal.html` 的 `.timeline` 里加一段 `article.entry` 即可。
