# 云萤 · flitfancy — 小流萤造物日志

小流萤的家 + 控制台：

- 展示页：首页 / 项目 / 日志 / 关于（静态）
- 控制台：实时感知数据、命令、记忆（需要启动本地服务）

## 本地预览

直接双击 `index.html` 可以看到展示页；控制台和 API 需要启动服务：

```powershell
python server.py
```

然后访问 http://localhost:8137/ （控制台在 /console.html）

## 服务职责

`server.py`（仅标准库，无需安装依赖）：

- 提供整个站点的静态文件
- `POST /api/ingest`：接收感知板 STREAM/WiFi 数据（CSV 行或 JSON）
- `GET /api/sensors/latest`、`/api/sensors/history`：查询实时/历史数据
- `GET/POST /api/notes`：她的记忆（小流萤的大脑也可以读写）
- `POST /api/command`：命令队列（串口/网络转发下一步接入）
- 数据落在 `data/flitfancy.db`（SQLite）

## 接数据

感知板的 WiFi 上行目前发到电脑的 7777 端口，`listen_wifi.ps1` 会落 CSV。
下一步把 TCP 收到的每一行转发到 `POST /api/ingest`，控制台就有实时数据了。

## 小流萤接入

她的大脑（AstrBot）可以通过 HTTP 查询 API：

```text
GET  http://localhost:8137/api/status
GET  http://localhost:8137/api/sensors/latest
GET  http://localhost:8137/api/notes
POST http://localhost:8137/api/notes   {"author":"liuying","content":"..."}
```

做成 AstrBot 工具后，她就能回答“现在房间 CO₂ 多少”，也能把想记住的事写进记忆库。

## 部署

整个目录就是静态站点，可以原样推送到 GitHub Pages 或 Cloudflare Pages。

## 域名

- `flitfancy.com` 已购买（2026-08，85 元/年），等待实名认证
- `flitfancy.cn` 请在注册商处再确认
- 中文名：云萤；可选的配套中文域名 `yunying.cn` 之前查询为可注册
- 注册后按平台指引把域名解析到托管站点即可，无需改代码

## 结构

```text
index.html      首页
project.html    项目现状
journal.html    造物日志（新增条目直接在这里加）
console.html    控制台（实时数据 / 命令 / 记忆）
about.html      名字与理念
server.py       本地服务（静态站 + API）
data/flitfancy.db 数据文件（自动创建）
assets/style.css       样式
assets/firefly.js      萤火虫背景
assets/console.js      控制台交互
```

新增日志：在 `journal.html` 的 `.timeline` 里加一段 `article.entry`，带 `id` 和 `time` 即可。
