# 云萤 · flitfancy 网站仓库

小流萤的家 + 控制台。前后端分离：

- `docs/`：公开网站（首页 / 足迹 / 日记 / 控制台 / 关于），GitHub Pages 从**这个目录**发布（命名为 docs 是因为 GitHub Pages 的目录下拉框只认 `/` 和 `/docs`）
- `backend/`：本地控制台服务（server.py + SQLite），只在你的电脑上跑，不发布

## 一键启动 FFS（控制台 后端/感知板/隧道 三个按钮）

浏览器不能直接拉起本机进程，因此用 Windows 自定义协议做桥（协议名随机，见下）：

1. 首次安装（一台电脑只需一次）：

       powershell -ExecutionPolicy Bypass -File scripts\install_flitfancy_protocol.ps1

2. 之后在任何浏览器打开控制台页，点状态行右侧的三个按钮（首次浏览器会弹
   确认框，选允许），分别拉起对应服务：
   - "后端"：server.py（端口 2671）
   - "感知板"：watch_sensor_listener.ps1（端口 7777）
   - "隧道"：cloudflared（console.flitfancy.com）
3. 启动器幂等：已运行的服务自动跳过；日志在 logs\starter.log。

协议名在安装时随机生成并写入注册表，本地后端经 /api/status 的
protocol_name 字段注入控制台，按钮自动使用当前协议名（重装协议或换电脑后
无需改动网页）。

仓库结构（scripts 部分）：
- scripts/start_flitfancy.ps1：协议处理器（正则白名单校验）
- scripts/start_flitfancy.bat：服务启动器（只接受白名单动作）
- scripts/install_flitfancy_protocol.ps1：协议注册/卸载
- scripts/watch_sensor_listener.ps1：感知板监听守护
- scripts/update_sensor_manifest.ps1：归档清单重建

相关文件（换电脑时随仓库一起带走即可）：

- scripts/start_flitfancy.bat：启动器本体（只接受白名单动作字面量）
- scripts/start_flitfancy.ps1：协议处理器（正则白名单校验后转调 bat）
- scripts/install_flitfancy_protocol.ps1：协议注册（-Uninstall 移除）
- 感知板监听器 listen_wifi.ps1 在 SkyWorks 项目里，启动器会按候选路径
  自动寻找；也可把副本放入 scripts/vendor/ 让本仓库完全自包含
- 隧道凭证 .cloudflared/ 目录仍需按搬家交接文档复制到新电脑

安全设计：协议名随机，任意网页猜不到协议名、无法静默触发；协议命令直接指向
PowerShell 白名单处理器，URL 只经正则校验，恶意输入一律忽略；浏览器首次会弹确认框。

## 本地运行

```powershell
cd S:\FlitFancy\site\backend
python server.py
```

然后打开 http://localhost:2671/

## 感知数据保存边界

- SQLite 查询副本：`S:\FlitFancy\site\backend\data\flitfancy.db`，只循环保留最近 14 天的传感器明细；日记、备注等其他表不会被此策略清理。
- 完整原始数据：`S:\FlitFancy\site\data\sensors\`，不设保留期限，后端的 SQLite 清理代码不会访问这里。
- `sessions/` 是当前监听会话，`live/` 是实时缓存；监听器下次启动时会把已结束会话移动到 `archive/sessions/`，不会删除。
- 14 天可用环境变量 `FLITFANCY_SENSOR_RETENTION_DAYS` 调整；默认清理检查每小时一次。

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
- 双线日记：在日记页登录后选择“我 / 她”和“手动 / 云萤”来源，先写入本地 SQLite，再同步到公网

## 公网对话（Cloudflare Worker，可选）

让 flitfancy.com 上的访客也能直接对话。代码在 `cloudflare/worker.js`，
已部署并绑定 `api.flitfancy.com`（前端 `console.js` 的 `PUBLIC_API` 指向它）。
部署/更新步骤：

1. 注册 Cloudflare（免费）→ Workers & Pages → Create → Worker，起个名字并部署；
2. 用 Edit code 打开编辑器，把 `cloudflare/worker.js` 的内容整个粘进去，再 Deploy；
3. Settings → Variables and Secrets → 添加机密：
   `AI_API_KEY`（AI 服务密钥）、`ADMIN_TOKEN`（至少 32 个字符的随机固定令牌，
   与 ai_local.json 的 worker_admin_token 相同）；
4. 建一个 KV 命名空间并在 Settings → Bindings 里绑定，变量名 `CONFIG`
   （用于公网“AI 请求权限”开关存储）；
5. 建一个 D1 数据库并在 Settings → Bindings 里绑定，变量名 `DB`
   （访问记录和双线日记共用；表会在第一次请求时自动创建）；
6. 按 `cloudflare/wrangler.jsonc` 创建聊天、访问上报和管理鉴权失败三个
   Rate Limiting 绑定；
7. 部署后在 Settings → Domains 绑定 `api.flitfancy.com`。

可选变量：`AI_BASE_URL`（默认 DeepSeek）、`AI_MODEL`（默认 deepseek-chat）、
`AI_SYSTEM`（人设/背景，留空则不附加）。

Worker 额外端点：
- `POST /chat`：公网 AI 对话；未匹配的 POST 不会再隐式进入聊天
- `GET /config`：返回公网 chat_enabled 与随笔（前端据此禁用聊天框/显示页尾随笔）
- `POST /admin/toggle`：同步公开开关/随笔（需 Bearer ADMIN_TOKEN）
- `GET /track`：访问上报（图片像素方式）
- `GET /visits`：访问记录统计（需 Bearer ADMIN_TOKEN）
- `GET /memories`：公开读取日记（有意公开的展示数据）
- `POST /admin/memories`：本机后端向 D1 同步日记，可更新（需 Bearer ADMIN_TOKEN）
- `GET /anchors`：公开读取锚点（有意公开的展示数据）
- `POST /admin/anchors`：本机后端向 D1 同步锚点（需 Bearer ADMIN_TOKEN）
- `GET /essays`：公开读取关于页已发布短文
- `POST /admin/essays`：发布或撤下短文的公网副本（需 Bearer ADMIN_TOKEN；草稿正文不上传）
- `GET /observations`：公开读取见闻星球与两端均公开的弦
- `POST /admin/observations`：发布或撤下星球公网副本（草稿、归档正文不上传）
- `POST /admin/observation-links`：发布或撤下星球之间的弦（需 Bearer ADMIN_TOKEN）
- `GET /sensors/latest`：公开读取每块感知板六通道的最新快照
- `POST /admin/sensors`：本机后端批量更新最新快照（需 Bearer ADMIN_TOKEN）
- `GET /sensors/history`：24 小时分桶历史（需 Bearer ADMIN_TOKEN）
- `POST /admin/sensors-history`：本机后端同步分桶历史（需 Bearer ADMIN_TOKEN）
- 全部 admin 端点带失败计数锁定：同一 IP 连续 5 次错误令牌锁定 10 分钟
- 浏览器访问管理端点只允许 flitfancy.com、console.flitfancy.com 与本机回环来源；
  后端同步不带 Origin，仍以 Bearer ADMIN_TOKEN 鉴权

## FIREFLY-SENSE 实时感知

感知板通过局域网 TCP 将 CSV 推给 `scripts/listen_wifi.ps1`；监听器同时落盘，
并把每行 POST 到本机 `/api/ingest`。本机 SQLite 保留最近 14 天的查询副本，后端用异步线程
把每个通道的最新快照同步到 Worker D1，因此公网延迟或断网不会阻塞板端采集。
`scripts/start_flitfancy.bat`（经 `flitfancy-<随机>://` 协议或手动调用）会按顺序
检查并启动后端、TCP 监听器和 Cloudflare 隧道；监听器由
`scripts/watch_sensor_listener.ps1` 守护，异常退出后会退避重启，
板子断电、WiFi 重连或 TCP 重置只会重建当前连接，不会终止整个接收服务。
原始传感器 CSV 统一放在 `data/sensors/`；整个目录（live/sessions/archive）均被
Git 忽略、不入库（含作息隐私，仅 `README.md` 例外）。
已结束的会话会在监听器下次启动时自动移入 `archive/sessions/`。
运行 `scripts/update_sensor_manifest.ps1` 可重建包含 SHA-256 的归档清单。

## GitHub Pages 发布设置

- Settings → Pages → Source: **Deploy from a branch**
- Branch: **main**，目录选 **/docs**
- 自定义域名与 HTTPS 已配置，无需改动

## 后端 API

- `POST /api/ingest`：接收感知板 STREAM/WiFi 数据（CSV 行或 JSON）
- `GET /api/status`：服务状态
- `GET /api/sensors/latest`、`/api/sensors/history`：传感器数据
- `GET/POST /api/notes`：她的记忆
- `GET/POST /api/memories`：双线日记；字段为 `perspective`、`time`、`content`
- `GET/POST /api/anchors`：锚点；额外字段为 `horizon`（现在/未来）与 `project`
- `GET /api/essays`：只读公开短文；`GET /api/admin/essays`：管理记录库全部状态
- `POST /api/essays`：新建或编辑短文，支持草稿、公开、排序和归档
- `GET /api/observations`：读取公开星球与弦；`GET /api/admin/observations`：管理全部星球
- `POST /api/observations`：新建或编辑星球，支持草稿、公开和归档
- `GET /api/admin/observation-links`、`POST /api/observation-links`：读取、新建或编辑弦
- `POST /api/command`：命令队列（转发到板子下一步接入）
- `POST /api/chat`：AI 对话（转发到兼容 OpenAI 格式的服务，密钥只在本地）
- `POST /api/admin/login|logout`：管理登录/登出（用户名 + 密码，失败锁定）
- `GET/POST /api/admin/config`：管理配置（模型、开关、快捷链接；需登录令牌）

数据落在 `backend/data/flitfancy.db`（已被 .gitignore 排除，不会推送到公开仓库）。
该库里的传感器明细保留 14 天；永久原始 CSV 位于 `data/sensors/`。

## 结构

```text
site/
├── docs/                 ← GitHub Pages 发布根
│   ├── index.html        首页（大字 + 萤火虫）
│   ├── journal.html      旅途（日记时间线 + 锚点双视图 + 写作编辑器）
│   ├── observations.html 见闻·星弦（循环星图、星环、弦、详情与列表模式）
│   ├── console.html      控制台（传感器总览 + 管理面板 + AI 对话）
│   ├── about.html        名字与理念
│   ├── resources.html    资源（FIREFLYS·天心 / SKYWORKS·天工 + 固件）
│   ├── remote.html       远程总闸（只开关公网 AI 聊天，用公网管理令牌）
│   ├── project.html      旧"足迹"页，自动跳转 journal.html#anchors
│   ├── debug-firefly.html 萤火虫调参调试页
│   ├── 404.html          404
│   ├── robots.txt
│   ├── assets/           样式与脚本：style.css / hero.css / remote.css / firefly.js /
│   │                     sitefx.js / glyph.js / track.js / sensor-state.js / admin-core.js /
│   │                     memory.js / anchors.js / console.js / console-visits.js /
│   │                     console-overview.js / console-sensors.js / console-chat.js /
│   │                     console-admin.js / console-services.js / journal-admin.js /
│   │                     about.js / remote.js
│   │                     essays.js / about-admin.js / observations.js/.css /
│   │                     observations-admin.js
│   ├── CNAME             自定义域名（必须留在发布根）
│   └── .nojekyll
├── backend/              ← 本地服务（不发布）
│   ├── server.py         控制台服务入口、运行配置与领域编排
│   ├── flitfancy_core.py 通用时间、配置、模型地址与文本归一
│   ├── flitfancy_auth.py 管理员密码、失败锁定与会话令牌
│   ├── flitfancy_sensors.py 传感器 CSV/JSON 解析与公开序列化
│   ├── flitfancy_storage.py SQLite 迁移、历史聚合与保留策略
│   ├── flitfancy_sync.py Worker 请求与最新快照同步队列
│   ├── flitfancy_http.py HTTP 路由、安全边界与显式领域依赖
│   ├── module_test.py    上述拆分模块的快速单元测试
│   ├── smoke_test.py     自包含冒烟测试（隔离临时库 + 独立端口，已接入 pnpm check）
│   └── data/             本地数据（gitignore）
├── cloudflare/           ← Cloudflare Worker（api.flitfancy.com）
│   ├── worker.js         Worker 路由入口
│   ├── worker-core.js    HTTP、CORS、鉴权与限流公共边界
│   ├── worker-storage.js D1 建表与迁移记忆化
│   ├── worker-visits.js  访问上报与统计
│   ├── worker-content.js 日记、锚点与短文
│   ├── worker-observations.js 公开见闻星球与弦
│   ├── worker-sensors.js 传感器快照与历史
│   ├── worker-config.js  公网配置与随笔缓存
│   ├── worker-chat.js    AI 对话转发
│   ├── wrangler.jsonc    Worker 配置（KV/D1 绑定）
│   └── package.json      pnpm run check:all = 语法/stylelint + 单测 + 冒烟 + dry-run
├── tests/                前端单测（vm 直接加载真实脚本，不是复制逻辑）
├── scripts/              Windows 脚本：start_flitfancy.bat/.ps1（服务启动，协议白名单入口）、
│                         install_flitfancy_protocol.ps1（注册随机协议）、
│                         watch_sensor_listener.ps1 / update_sensor_manifest.ps1（监听器）；
│                         set-version.mjs 统一更新正式版本与 HTML 缓存版本
├── data/sensors/         感知板原始 CSV 归档（gitignore，不入库；README 除外）
├── .gitignore
└── README.md
```

## 架构规范（v1.x）

- **CSS @layer 分层**：`tokens → base → components → utilities`（后声明者优先）。
  工具类（grad-clip/grad-flame/grad-cool、[hidden]、tri-grid、reduced-motion）在
  utilities 层必胜——组件里写什么都压不过工具类，同特异性书写顺序的级联事故
  在结构上不可能再发生。
- **断点约定**：桌面优先 + `max-width` 单方向，四档 640 / 760 / 900 / 1200；
  每个组件的媒体块紧贴其基础规则之后。唯一例外：.memory-editor 的 761px
  是组件级视口开关（桌面固定面板 vs 移动流式），保留 min-width 并已注明。
- **骨架一致性防线**：`tests/html-skeleton.test.mjs` 断言五个主页面导航/页脚
  完全一致（激活类允许页间差异）；`tests/version-consistency.test.mjs` 断言
  全库 `?v=` 与 `cloudflare/package.json` 的语义化版本一致。改导航或版本漏改
  任何一页都会在 check 里立即失败。发布版本统一使用：
  `pnpm run version:set -- 1.2.3`（示例，在 `cloudflare` 目录执行）。
- **stylelint 防线**：no-duplicate-selectors / block-no-empty /
  no-duplicate-properties 三条规则挂进 check，同名选择器提交即报错。
- **纯函数单一出处**：传感器衍生计算在 `sensor-state.js`（带单测），
  日期格式化四件套在 `admin-core.js`（formatDateTime/formatDate/nowForInput/
  formatUnixTime），页面只做委托。
- **控制台职责拆分**：`console.js` 只负责环境判断、刷新定时器与模块装配；
  传感器卡片、24 小时图表、AI 对话、管理面板、服务按钮和访问统计分别集中在
  `console-sensors.js`、`console-overview.js`、`console-chat.js`、
  `console-admin.js`、`console-services.js` 与 `console-visits.js`。
- **后端职责拆分**：`server.py` 只保留运行配置、领域编排与服务启动；认证、
  传感器归一、SQLite、Worker 同步和 HTTP 边界分别集中在 `flitfancy_auth.py`、
  `flitfancy_sensors.py`、`flitfancy_storage.py`、`flitfancy_sync.py` 与
  `flitfancy_http.py`。HTTP Handler 只能通过 `HttpDependencies` 使用显式注入能力。
- **日记结构单轨**：前端、后端与 Worker 统一使用 `time/precision/content`
  等现行字段；写入请求出现已停用的 `date/title` 会明确返回 400，避免静默丢字段。
  跨运行时的随笔归一规则共用 `tests/contracts` 测试数据，防止 Python 与 Worker
  各自演化。

## 权限模型（三把钥匙，各管一域）

| 钥匙 | 存放 | 保护什么 | 公网暴露面 |
|---|---|---|---|
| 本地管理员账号（用户名 + 密码） | 本机 ai_local.json（PBKDF2-60 万次哈希） | 隧道后端的全部管理 API：写日记/锚点/随笔、传感器、配置、访问记录 | 中——登录接口对外，但 5 次失败锁 10 分钟/IP |
| 公网管理令牌 | 本机 ai_local.json + Worker 密钥库（两处同值） | api.flitfancy.com 的 /admin/*：公网聊天开关、云端同步写入 | 低——只有 remote.html 一个人工入口 + 后端自动出示 |
| AI 服务商 api_key | 本机 ai_local.json | 只由后端在调用模型时出示，浏览器永远接触不到 | 无 |

规则：

- **读归公网，写归本机**：日记/锚点/随笔/见闻/传感器快照的公开读取全部走 Worker（无锁）；
  一切写入走隧道后端，由本地管理员账号把关。
- **隧道零信任**：凡从隧道（console.flitfancy.com）进来的 API 请求一律按远程处理，
  不带有效管理员令牌就 401（唯一例外是登录接口本身）。静态页面匿名可加载，
  但页面只是空壳，数据全靠被 401 挡住的 API。
- **三把钥匙必须不同值**：任何一把泄漏不连累其余两把。尤其公网管理令牌与
  本地管理员密码不能同值——登录接口天天被人试。
- 本机即信任源：进了本机 ≈ 拿到前两把钥匙，所以 backend 目录 ACL 只允许
  当前用户 + SYSTEM + Administrators。

云萤在本机写入日记的示例：

```http
POST http://127.0.0.1:2671/api/memories
Content-Type: application/json

{"perspective":"her","time":"2026-08-13T21:35:07","content":"这一刻想留下的内容。"}
```

`time` 可只写日期、到分钟或精确到秒；未写时区时按北京时间处理。本机调用会沿用
现有的本地信任边界；从公网调用则必须先登录并携带管理员 Bearer 令牌。旧版
`date/title` 请求不再接受；`source` 仍是现行数据模型字段，缺省为 `manual`。
