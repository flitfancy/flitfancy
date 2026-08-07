# 云萤 · flitfancy 网站仓库

小流萤的家 + 控制台。前后端分离：

- `docs/`：公开网站（首页 / 项目 / 日志 / 控制台 / 关于），GitHub Pages 从**这个目录**发布（命名为 docs 是因为 GitHub Pages 的目录下拉框只认 `/` 和 `/docs`）
- `backend/`：本地控制台服务（server.py + SQLite），只在你的电脑上跑，不发布

## 本地运行

```powershell
cd S:\FlitFancy\site\backend
python server.py
```

然后打开 http://localhost:8137/

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
