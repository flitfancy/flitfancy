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

配置（环境变量优先，否则读取 `backend/ai_local.json`，该文件已被 gitignore 排除）：

```json
{
  "base_url": "https://api.deepseek.com",
  "api_key": "sk-…",
  "model": "deepseek-chat",
  "system": ""
}
```

`system` 留空则不附加任何角色设定；以后做人设与背景知识时，填在这里即可。可用服务举例：

- DeepSeek：`https://api.deepseek.com`，模型 `deepseek-chat`
- 通义千问：`https://dashscope.aliyuncs.com/compatible-mode/v1`，模型 `qwen-plus`
- Kimi（Moonshot）：`https://api.moonshot.cn/v1`，模型 `moonshot-v1-8k`

对应环境变量：`FLITFANCY_AI_BASE_URL` / `FLITFANCY_AI_KEY` / `FLITFANCY_AI_MODEL` / `FLITFANCY_AI_SYSTEM`。

请求示例：`POST /api/chat`，body `{"messages":[{"role":"user","content":"你好"}]}`。

## 公网对话（Cloudflare Worker，可选）

让 flitfancy.com 上的访客也能直接对话，而不只限本地控制台。代码已放在
`cloudflare/worker.js`，部署步骤：

1. 注册 Cloudflare（免费）→ Workers & Pages → Create → Worker，起个名字并部署；
2. 用 Edit code 打开编辑器，把 `cloudflare/worker.js` 的内容整个粘进去，再 Deploy；
3. Settings → Variables and Secrets → Add secret，变量名 `AI_API_KEY`，值填你的密钥；
4. 部署后得到一个形如 `https://xxx.workers.dev/chat` 的地址；
5. 把这个地址填到 `docs/assets/console.js` 顶部的 `PUBLIC_AI_URL`，
   以后本地服务连不上时，页面会自动改用这个公网地址。

可选变量：`AI_BASE_URL`（默认 DeepSeek）、`AI_MODEL`（默认 deepseek-chat）、
`AI_SYSTEM`（人设/背景，留空则不附加）。

提示：`workers.dev` 域名在国内访问可能不稳定；想更稳的话，之后可以把域名 DNS
迁到 Cloudflare，再给 Worker 绑定 `api.flitfancy.com` 这类自定义子域。

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
