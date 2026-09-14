# 云萤 · FlitFancy

小流萤的家，也是连接文字、生活与本机设备的个人控制台。

这里收集日记、短文与见闻，也承载环境感知、语音音频和桌面应用的控制入口。公开网站供浏览，本机控制台负责管理与设备交互。

[访问网站](https://flitfancy.com) · [更新日志](CHANGELOG.md) · [运行与部署](docs/OPERATIONS.md)

## 网站里有什么

| 页面 | 内容 |
| --- | --- |
| 首页 | 文字与萤火虫交互，作为网站的入口 |
| 旅途 | 按月份整理的双线日记时间线，以及记录现在与未来的锚点 |
| 见闻 · 星弦 | 用星球收集事、理、物、人、地；用弦连接相关见闻，支持三档关系强度 |
| 关于 | 名字与理念，以及可左右翻阅的短文卡牌；保存留在卡牌库，选择“设为展示”才更新关于页 |
| 控制台 | 环境感知、音频与私有对话、本机应用启动、内容管理及服务状态 |
| 资源 | 项目资料、固件与相关下载 |

见闻星球采用水星至冥王星及月球十种天体外观，分类通过淡色弱区分。贴图在构建时生成，页面加载静态 WebP；来源与授权见 [素材说明](docs/assets/planets/CREDITS.txt)。

## 控制台能做什么

- **现实感知**：查看 FIREFLY-SENSE 六路环境数据、通道细节和历史图表。
- **侧耳倾听**：连接 FIREFLY VOICE，查看双麦电平与历史，调整增益、录音和识别；支持拖放音乐、歌词、播放控制及固件升级。
- **私有对话**：经本机音频服务连接 AstrBot，查看对话历史与识别、思考、回复状态。
- **本机启动**：添加应用、快捷方式或脚本路径，以对应系统图标展示，点击后由桌面助手在电脑上启动。
- **服务管理**：提供本机服务启动入口，可配置 Windows 开机任务、隧道与本机 HTTPS 守护。

管理沿用隐藏式登录入口。公开网站与管理员控制台的能力不同；硬件、音频服务、AstrBot 和隧道需各自安装配置。下载此仓库不会自动安装这些组件。

## 先在本机运行

以下命令从仓库根目录执行。项目 CI 使用 Python 3.14 和 Node.js 24；Windows 服务脚本及桌面助手需要 Windows。

```powershell
# 首次使用：创建自己的管理员账号，按提示输入密码
py -3.14 backend/server.py --set-password admin

# 启动网站后端
py -3.14 backend/server.py
```

随后打开 [本机控制台](http://127.0.0.1:2671/console.html)。网站后端使用 Python 标准库和 SQLite；仅启动后端即可查看页面，设备数据与音频功能需要对应服务在线。

若希望从网页打开本机应用，在已登录的 Windows 桌面运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install_launcher_agent.ps1
```

随后登录控制台，在“本机启动”中粘贴路径、拖入路径文本或使用“本机选择”。支持 `.exe`、`.lnk`、`.bat`、`.cmd`、`.ps1`、`.py`，可配置参数和运行目录。浏览器拖入文件时可能只提供文件名，需要补全路径。

桌面助手随 Windows 用户登录启动。后端验证网站登录并写入本机队列，助手领取请求后启动应用；电脑尚未登录桌面时，启动区显示“桌面未连接”。详见 [本机启动区](docs/LOCAL-LAUNCHER.md)。

## 部署到自己的环境

| 部分 | 运行位置 | 职责 |
| --- | --- | --- |
| `docs/` | GitHub Pages | 公开 HTML、CSS、JavaScript 和站点素材 |
| `cloudflare/` | Cloudflare Worker、KV、D1 | 公开内容读取、同步接收、访问统计与可选访客对话 |
| `backend/` | 自己的电脑 | 管理登录、内容写入、传感器数据、本机音频代理与启动队列 |
| 桌面助手 | Windows 登录会话 | 在当前用户桌面打开已保存的应用或脚本 |

复用时应配置自己的域名、Worker 绑定和密钥，并检查启动器引用的外部服务路径。仓库里的 `flitfancy.com` 与云端资源标识属于当前项目配置。

静态网站、Worker 和本机服务分别更新：**推送 Git 不等于部署 Worker，也不会让正在运行的本机服务自动加载新代码。**

| 想配置的功能 | 说明 |
| --- | --- |
| 开机启动、服务守护、音频接入、备份与云端部署 | [运行与部署](docs/OPERATIONS.md) |
| 应用卡片、桌面助手与系统图标 | [本机启动区](docs/LOCAL-LAUNCHER.md) |
| 同域名本机 HTTPS 访问 | [本机网关](docs/LOCAL-GATEWAY.md) |
| AstrBot 私有对话 | [私有对话接入](docs/PRIVATE-DIALOGUE.md) |
| 感知数据存储与归档 | [传感器数据说明](data/sensors/README.md) |

## 数据与权限

管理账号和密钥保存在本机配置或 Cloudflare 密钥变量中。`backend/ai_local.json`、`backend/data/` 和传感器运行数据被 Git 忽略，复制代码不会带走原作者的这些数据。

日记、短文、星球等内容按各自发布流程同步到云端。短文草稿与本机启动卡片不进入公共 Worker；私有对话经过本机服务，实际模型调用由对应服务配置决定。

传感器明细在 SQLite 中默认保留最近 14 天，完整原始 CSV 单独归档；这个保留策略不清理日记等内容。详见 [数据保存与备份](docs/OPERATIONS.md#感知数据保存边界)。

## 开发与检查

前端按页面和控制台模块拆分，后端通过显式依赖连接认证、存储、同步、音频及启动服务。新增功能应沿用这些边界，并保留原有接口和数据迁移的兼容性。

```text
docs/           公开页面、前端模块、资源与使用文档
backend/        Python 本机后端、桌面助手与后端测试
cloudflare/     Worker 模块、云端绑定与前端检查入口
scripts/        Windows 安装/启动/守护、版本管理与数据维护
tests/          前端、Worker、Windows 脚本及数据回归测试
data/sensors/   本机感知原始数据，除说明文档外不入库
```

在 Windows 下执行完整检查：

```powershell
cd cloudflare
cmd /c "pnpm install --frozen-lockfile"
cmd /c "pnpm run check:all"
```

检查包含前端与 Worker 测试、页面骨架、版本一致性、样式检查、Worker dry-run 构建及隔离后端冒烟测试。Windows 专用功能还有 `tests/` 中的网关、守护和传感器脚本测试。

修改 HTML 引用的资源时，通过 `scripts/set-version.mjs` 统一资源版本并更新日志。纯说明文档调整不需要升级页面资源版本。协作与发布约定见 [AGENTS.md](AGENTS.md)。

## 许可证

除非另有说明，本仓库的程序源代码、脚本与配套技术文档采用
[MIT License](LICENSE)。

以下内容不属于 MIT 授权范围，版权及相关权利由 FlitFancy 保留：

- 原创文章、日记、见闻、随笔及其他个人表达；
- 网站数据、照片、插画、音视频与其他原创媒体；
- FlitFancy 名称、Logo 及其他品牌标识。

仓库中的第三方依赖与素材继续遵循其各自的许可证。换句话说，你可以依据 MIT
复用网站程序与界面实现，但不能因此直接复制上述个人内容或冒充 FlitFancy。

Unless otherwise noted, the source code, scripts, and accompanying technical
documentation in this repository are licensed under the MIT License. Original
editorial content, personal data, media, and FlitFancy brand assets are excluded
from that license and remain all rights reserved by FlitFancy.
