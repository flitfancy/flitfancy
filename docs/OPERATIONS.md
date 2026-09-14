# 运行与部署说明

本文收录服务安装、自恢复、音频接入、数据保存和云端部署细节。项目介绍与首次运行见 [仓库首页](../README.md)。

下方命令默认在仓库根目录执行；域名、外部服务位置、Python 路径和备份磁盘需按自己的电脑配置。

## Windows 服务启动与恢复

浏览器不能直接拉起本机进程，因此用 Windows 自定义协议做桥（协议名随机，见下）：

1. 首次安装（一台电脑只需一次）：

       powershell -ExecutionPolicy Bypass -File scripts\install_flitfancy_protocol.ps1

2. 之后在已安装协议的电脑上打开控制台页，点状态行右侧的四个按钮（首次浏览器会弹
   确认框，选允许），分别拉起对应服务：
   - "后端"：server.py（端口 2671）
   - "感知板"：watch_sensor_listener.ps1（端口 7777）
   - "音频"：FFV-transfer（端口 7865；本机解码、双麦与 SenseVoice，按需常驻）
   - "隧道"：cloudflared（console.flitfancy.com）及隐藏的自恢复守护
3. 启动器幂等：已运行的服务自动跳过；日志在 logs\starter.log。

隧道启动入口现在调用 `scripts/start_tunnel.ps1`，由 `watch_tunnel.ps1` 持续守护。
桌面启动器仍可沿用原入口，不依赖控制台页面、2671 或管理员登录来恢复隧道：

- 每 30 秒检查一次；进程退出后在下一轮拉起。
- 使用隧道自身的本机 `/ready` 接口检查到 Cloudflare 的连接，不把网站后端故障当作隧道故障。
- 新进程留出 60 秒连接时间；之后连续三次检查失败才重启。反复失败的重启等待递增，最多五分钟；连续三次健康后恢复普通等待。
- 接管已运行的同路径、同配置隧道，不主动重启；互斥锁防止重复守护，重启前核对进程路径、配置和创建时间。
- 日志在 `logs/tunnel-watchdog.out.log`、`logs/tunnel-watchdog.err.log`，隧道日志仍为 `logs/cloudflared.*.log`。

维护时如需手动停隧道，先创建 `logs/tunnel-watchdog.paused` 空文件，再停隧道进程；
删除该文件或再次运行启动器的 `tunnel` 动作即可恢复守护。
守护随现有启动器启用；也可通过下述开机任务启动。关机、休眠和整机断网无法靠重启隧道恢复访问。

### Windows 开机启动

本机任务计划程序中的 `FlitFancy Autostart` 在开机 30 秒后运行 `scripts/start_at_boot.ps1`，
启动后端、感知监听、本机 HTTPS 入口和隧道守护，音频仍按需启动。
任务采用现有 Windows 用户的 S4U 后台登录、普通权限，不保存 Windows 密码，也不需要桌面登录。
失败时每隔一分钟重试，最多三次；已有服务正常运行时沿用现有实例。
任务直接指定 Python 路径，避免开机环境依赖 WindowsApps 的命令别名。

安装或更新（需管理员授权；`PythonExe` 替换为本机的实际解释器）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install_autostart.ps1 -Account "$env:USERDOMAIN\$env:USERNAME" -PythonExe "C:\path\to\python.exe"
```

在任务计划程序中可以禁用 `FlitFancy Autostart`；或以管理员权限运行
`scripts/install_autostart.ps1 -Remove` 解除开机启动。解除任务不会停止已经运行的服务。
结果写入 `logs/autostart-result.json`，启动输出在 `logs/autostart.log`。
更换用户、Python 安装路径或移动仓库后，应重新安装任务；加密的用户文件与需要 Windows 网络身份的共享路径不适用此登录模式。

Windows 守护回归测试（不操作真实隧道）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tests/tunnel-watchdog.test.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File tests/tunnel-watchdog-integration.test.ps1
```

协议名在安装时随机生成并写入注册表，本地后端经 /api/status 的
protocol_name 字段注入控制台，按钮自动使用当前协议名（重装协议或换电脑后
无需改动网页）。

仓库结构（scripts 部分）：
- scripts/start_flitfancy.ps1：协议处理器（正则白名单校验）
- scripts/start_flitfancy.bat：服务启动器（只接受白名单动作）
- scripts/install_flitfancy_protocol.ps1：协议注册/卸载
- scripts/watch_sensor_listener.ps1：感知板监听守护
- scripts/start_tunnel.ps1 / watch_tunnel.ps1：隧道启动与独立自恢复守护
- scripts/update_sensor_manifest.ps1：归档清单重建

相关文件（换电脑时随仓库一起带走即可）：

- scripts/start_flitfancy.bat：启动器本体（只接受白名单动作字面量）
- scripts/start_flitfancy.ps1：协议处理器（正则白名单校验后转调 bat）
- scripts/install_flitfancy_protocol.ps1：协议注册（-Uninstall 移除）
- 感知板监听器 listen_wifi.ps1 在 SkyWorks 项目里，启动器会按候选路径
  自动寻找；本仓库也在 scripts/vendor/listen_wifi.ps1 提供监听器副本
- 隧道凭证 .cloudflared/ 目录仍需按搬家交接文档复制到新电脑

协议处理器只接受预设的服务动作，并校验 URL。随机协议名减少被随意调用的机会，
但不替代权限验证；浏览器也可能记住用户曾经允许打开协议的选择。
自定义协议只操作当前浏览器所在电脑。远程恢复隧道依赖服务器电脑上的守护进程。

## FIREFLY VOICE 音频接入

控制台“侧耳倾听”在“现实感知”下方提供双麦选择、增益、录音、本地 SenseVoice
识别、音量、拖放播放、同名 LRC 歌词、暂停/继续和板子重启。页面只请求同源的
`/api/audio/*`，由 `backend/flitfancy_audio.py` 转发给默认运行在
`http://127.0.0.1:7865` 的 FFV-transfer 服务；音频文件、录音和识别结果不会发送给
公网 Worker。

代理目标只允许本机回环 HTTP 地址。需要改端口时可设置
`FLITFANCY_AUDIO_URL`，例如 `http://127.0.0.1:7867`。音频上传按流转发，
支持 NCM、FLAC、MP3、WAV、AAC、M4A、OGG 与 Opus，单文件上限 500 MB。
FFV-transfer 自身也只监听回环地址，并拒绝非本机 Host 与浏览器跨站请求；
网站后端到音频服务的调用不经过浏览器，仍可正常工作。

当前原型由本机私有固件配置提供 2.4 GHz 网络参数，网页不读取或提交 Wi-Fi 密码。
FFV-transfer 常驻持有板子会话：通过 `firefly-voice.local:7866` 完成配对认证、心跳、
控制和扬声器下行，板子把带序号与 CRC 的双麦数据发到电脑 UDP 7867。USB 只用于烧录
和诊断。网页的 2671 端口承担统一控制与状态，本地 AI 的连续 PCM 直接使用 7865 流式
接口，避免在网站后端重复复制。板端端口只在受信任局域网使用，不向公网转发。

当前还提供双麦电平历史、播放进度与固件升级入口。相关硬件、FFV-transfer 与
AstrBot 需要独立安装和配置；本仓库提供网站面板及代理，不能仅靠启动 server.py 获得完整音频能力。

本机控制台的私有对话经 FFV-transfer 接入 AstrBot；公网访客对话由 Worker 单独处理。
参见 [私有对话接入说明](PRIVATE-DIALOGUE.md)。

## 感知数据保存边界

- SQLite 查询副本：`backend/data/flitfancy.db`，只循环保留最近 14 天的传感器明细；日记、备注等其他表不会被此策略清理。
- 完整原始数据：`data/sensors/`，不设保留期限，后端的 SQLite 清理代码不会访问这里。
- `sessions/` 是当前监听会话，`live/` 是实时缓存；监听器下次启动时会把已结束会话移动到 `archive/sessions/`，不会删除。
- 14 天可用环境变量 `FLITFANCY_SENSOR_RETENTION_DAYS` 调整；默认清理检查每小时一次。

### SQLite 自动备份

`scripts/backup_sqlite.py` 使用 SQLite Backup API，在本地服务运行时也能生成一致副本，
完成后执行 `PRAGMA quick_check`，并在成功后保留最近 14 份。项目原有默认备份路径为：
`B:\FlitFancy\data\daily\`。使用前请检查路径，并通过 `py -3.14 scripts/backup_sqlite.py --help` 查看配置选项。

```powershell
# 立即手动备份
py -3.14 scripts\backup_sqlite.py

# 安装或更新每天 03:30 的当前用户计划任务
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install_sqlite_backup_task.ps1
```

日志写入 `B:\FlitFancy\data\backup.log`。备份只包含 SQLite 数据库，不包含
`backend/ai_local.json` 中的本地密钥配置。

## Cloudflare Worker 与公开数据

Worker 负责公开内容读取、访问统计及可选的访客 AI 对话。本机后端负责写入与同步。
短文卡牌的“设为展示”快照、星球分类与弦强度，需要配套版本的 Worker。

Worker 已拆成多个模块，部署时应使用 Wrangler 打包整个项目。首次部署需：

1. 在 `cloudflare/wrangler.jsonc` 中配置自己的账户、域名、KV `CONFIG`、D1 `DB` 及 Rate Limiting 绑定。
2. 在 Cloudflare 中配置 `ADMIN_TOKEN` 和 `AI_API_KEY` 密钥；本机 `backend/ai_local.json` 的 `worker_admin_token` 与云端管理令牌对应。
3. 检查前端公共 API 地址、后端同步地址与来源白名单，使其指向自己的域名。
4. 在已登录并获授权的 Cloudflare 账户下执行：

```powershell
cd cloudflare
cmd /c "pnpm install --frozen-lockfile"
cmd /c "pnpm run check:all"
cmd /c "pnpm run deploy"
```

`check:all` 中的 Worker 构建是 dry-run；`deploy` 才会更新云端。Git 推送与 GitHub Pages 构建不会代替 Worker 部署。D1 表和增量迁移由对应模块按需处理。

公开读取包括 `/memories`、`/anchors`、`/essays`、`/essays/featured`、`/observations`、`/sensors/latest` 和 `/config`。管理写入使用 `/admin/*` 接口及管理令牌。
关于页展示快照经 `/admin/toggle` 同步；星球和弦分别经 `/admin/observations`、`/admin/observation-links` 同步。

访客对话走 `/chat`，服务地址与模型可通过 `AI_BASE_URL`、`AI_MODEL`、`AI_SYSTEM` 配置。网站保留兼容接口 `/api/chat`；本机控制台实际使用的私有对话路径见 [私有对话说明](PRIVATE-DIALOGUE.md)。

## 本机与云端权限

| 配置 | 用途 |
| --- | --- |
| 本机管理员账号 | 登录控制台；密码以哈希保存，会话绑定来源 IP |
| Worker 管理令牌 | 后端同步公开内容、访问受保护的云端管理接口 |
| AI 服务密钥 | 由相应后端调用模型服务，不放入前端代码 |

不同用途的凭据应分别配置。经隧道访问本机 API 需要登录；部分回环接口沿用本机信任边界，而启动区所有接口在回环访问时同样要求管理员登录。

`backend/ai_local.json`、`backend/data/` 与传感器原始数据均被 Git 忽略。网页程序公开不代表私有运行数据会公开；日记、星球、短文等展示内容按各自的发布流程同步。

## 更新与排障

静态页面加载新代码，和正在运行的 Python 服务加载新代码，是两个独立步骤。更新后端文件后需要重启后端；桌面助手有改动时也需重新启动对应进程。

如需仅重启网站后端，可在管理员 PowerShell 中运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/restart_backend.ps1
```

脚本先核验端口和进程身份，再交由已有守护恢复后端。它不重启音频服务。后端重启会清除内存中的登录会话，网页需要重新登录。

GitHub Pages 使用 `main` 分支的 `/docs`。修改 HTML 引用的资源后运行 `node scripts/set-version.mjs <版本号>`，并更新 `CHANGELOG.md`。完整发布流程见 [协作约定](../AGENTS.md)。
