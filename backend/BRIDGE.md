# 全界之桥：传输接口 v1

桥负责「调用方 → 电脑后台 → NAS」的连接测试、文件写入和任务状态。网站数据备份是后续调用方，本版本不读取网站数据库或感知历史。控制台支持拖入或选择单个文件、整个文件夹，并保留相对路径。文件夹内的小文件合并为有限大小的批次，后台最多并行保存 4 个文件；大文件沿用独立任务，均在校验成功后推进队列。可查看总进度、暂停和重试。拖入目录时可保留空目录，文件夹内的空文件正常保存；单独拖入的 0 B 项目仍会提示重新选择。文件夹选择器只提供浏览器返回的文件列表，通常不包含空目录，需保留空目录时请直接拖入。

## 安装与认证

在仓库根目录运行 `py -3.14 -m pip install -r backend/requirements-bridge.txt`，重启现有 `backend/server.py`。Windows 下可在管理员 PowerShell 中运行 `scripts/reload_backend.ps1`，脚本核对 PID、监听端口和进程路径后，只重启网站后端。SMB 依赖按需加载，不配置桥不影响其他后端功能。

本机地址 `http://127.0.0.1:2671`；远程沿用已有控制台 HTTPS 隧道。所有 `/api/bridge/*` 接口，包括本机调用，都必须携带现有管理员会话：`Authorization: Bearer <session>`。会话通过已有 `POST /api/admin/login` 获取，绑定来源 IP；不要把密码或令牌放进 URL、命令行参数或日志。

## 配置

`POST /api/bridge/config`：JSON 字段 `host`（局域网 IPv4）、`share`（真实 SMB 共享名）、`user`、`password`、`root`（共享内相对目录，默认 `bridge/inbox`）。密码只保存在被 Git 忽略的 `backend/ai_local.json` 的 `nas_bridge` 对象中。地址、共享名和账号不变时，空密码沿用已保存值。配置保存不代表连接成功，应调用连接测试。

`GET /api/bridge/config`：返回非敏感配置、`configured`、`password_saved`、`folder_upload`（是否支持文件夹）、`chunk_bytes`（4 MiB）与 `max_file_bytes`（20 GiB）；永不返回密码。执行任务期间禁止修改配置。更换配置不会移动任何现有文件。

## 接口

| 方法 | 路径 | 参数与结果 |
| --- | --- | --- |
| POST | `/api/bridge/test` | JSON `{}`；202，返回连接任务，后台测试登录、创建根目录、写入/读回/删除随机临时文件 |
| POST | `/api/bridge/directories` | JSON `{"paths":["example","example/empty"]}`；202，后台按层级创建目录，已有目录可复用，同名普通文件报错；最多 10000 项、路径 UTF-8 字节总计不超过 900000 |
| POST | `/api/bridge/transfers` | JSON `{"path":"example/test.txt","size":123,"sha256":"完整的64位十六进制摘要"}`；200，返回接收任务 |
| POST | `/api/bridge/batches` | JSON `{"folder_root":"example","files":[{"path":"example/a.txt","size":123,"sha256":"完整摘要"}]}`；200，返回小文件批次。最多 32 个文件，每个不超过 256 KiB，总计不超过 4 MiB；内容按清单顺序拼接，经原有 chunk/commit/status/cancel 接口传输 |
| POST | `/api/bridge/transfers/chunk?id=<id>&offset=<offset>` | 原始二进制请求体、唯一 `Content-Length`，建议 `Content-Type: application/octet-stream`；200，返回已确认接收偏移 |
| POST | `/api/bridge/transfers/commit` | JSON `{"id":"..."}`；202，后台校验完整文件、传 NAS、读回校验，再发布最终文件 |
| GET | `/api/bridge/transfers?id=<id>` | 200，单个任务状态（连接任务也用此接口） |
| GET | `/api/bridge/status` | 200，`configured` 与最近任务列表 |
| POST | `/api/bridge/transfers/cancel` | JSON `{"id":"..."}`；清理本机暂存，取消尚未提交或失败的任务；NAS 操作开始后返回 409 |

只允许相对路径；拒绝 `..`、绝对路径、盘符、Windows 保留名和 SMB 重解析目录。接口没有读取任意电脑路径、文件浏览、下载或删除 NAS 原文件的能力。父目录按需创建，同名目标拒绝覆盖。创建文件传输任务时可加 `reuse_identical: true`（文件夹上传使用）：只有大小、SHA-256 都与 NAS 已有文件一致时复用，并返回 `reused: true`；不匹配仍报冲突。单文件默认不复用。文件夹调用方另传 `folder_root`，后端验证文件路径位于此目录下，并将根路径随任务保存，供页面刷新后恢复重命名过的目录。

## 调用顺序

1. 配置后发起连接测试，轮询到 `succeeded`。
2. 调用方计算文件大小和 SHA-256，创建传输任务，保存返回的 `id`。
3. 从 `offset=0` 开始顺序上传，每块最多 4 MiB；下一块使用响应中的 `received_bytes`。
4. 上传请求中断或响应丢失时，先查询状态，再从已确认的 `received_bytes` 继续；重复偏移返回 409。
5. 接收完整后调用 `commit`，后台继续操作。此时关闭浏览器不会中止传 NAS；完整接收之前，调用方仍须保持上传。
6. 轮询任务直到 `succeeded` 或 `failed`。`retryable=true` 表示本机仍保留完整文件，可再次 `commit`；否则重新创建上传任务。同名冲突或摘要不符需要先取消任务，再改正路径或文件重传。

重复提交正在执行或已成功的任务会返回当前状态，不会启动第二份传输。NAS 断线后不自动无限重试；由调用方决定何时重新提交。

## 状态与边界

任务字段：`id`、`kind`（`connection` / `transfer` / `batch` / `directories`）、`state`、`created_at` / `updated_at`（Unix 秒）、`size`、`received_bytes`（调用方 → 电脑）、`sent_bytes`（电脑 → NAS）、`retryable`、`error`；单文件传输任务另有 `path`、`sha256`，小文件批次的各文件摘要保存在 `files` 中。

状态顺序：`receiving → queued → sending → verifying → succeeded`；连接测试为 `testing → succeeded`；异常为 `failed`，也可能出现 `cancelled` / `expired`。只有 `succeeded` 才表示最终文件已发布，发送字节达到大小不等于成功。

- 同时只允许一个活动任务，避免争用 NAS 和暂存磁盘。失败且可重试的任务也占用此槽位，需重试或取消。
- 状态接口保留最近任务供核对；网页重新进入时只恢复未完成或可重试任务，不把已完成历史重新显示成当前进度。本次网页发起的任务仍显示完成结果。
- 小文件批次是一个活动任务，`kind=batch`，包括 `files` 清单（路径、大小、SHA-256、拼接偏移、成功/失败状态）、`file_count` 和 `completed_files`。已成功的文件不回滚；失败批次保留暂存，再次 commit 跳过已完成项。暂停时已提交的这一批会继续完成，取消只清理本机暂存。进度只累计已经在 NAS 校验成功的文件。
- 接收中或失败待重试的任务，1 小时没有更新会在下一次接口调用时过期并清理本机暂存。暂存需要约一个文件大小的电脑磁盘空间。
- 本机任务状态和暂存位于数据库旁的 `bridge/` 目录，默认 `backend/data/bridge/`，不入库。保留最多约 64 个最近任务。
- 重启服务后保留任务结果，把未完成任务标为失败并清理本机暂存；本版本不跨服务重启续传。重启也会使现有管理员会话失效，沿用原有登录机制。
- NAS 使用 `.bridge-part-<任务ID>` 临时文件，读回 SHA-256 一致后才重命名为最终路径。通常会清理临时文件；断电或 NAS 持续离线时可能残留，不能把它们当成已完成传输。
- 若 NAS 已完成重命名而连接或电脑随后中断，任务可能报告失败；不会为了重试覆盖已存在文件，应人工核对目标。
- 文件夹队列保留在当前网页内，上传期间应保持页面打开。暂停会阻止下一个分块/文件发送，已提交到后台的当前文件仍可能完成。刷新后需重新选择文件夹，已有未完成单文件会按路径、大小和摘要验证后接续；已完成文件重新发送到电脑后在 NAS 上校验复用。取消队列只取消未发送的部分，不删除已写入 NAS 的内容。
- 网站的数据库一致性快照、备份清单、定时策略、手机传输入口均由后续功能负责。

错误码：400 参数错误；401 未登录；403 跨站/权限/路径拒绝；404 任务不存在；409 状态、偏移、并发或同名冲突；507 空间不足；503 NAS 或本机暂存不可用。后台传输错误记录在任务 `error`，不将底层凭据或异常全文返回给调用方。

## 验证

### 连续传输性能

配置响应的 `task_wait: true` 表示支持 `GET /api/bridge/transfers?id=<id>&wait_ms=2000`。等待时间范围为 0–5000 毫秒：任务完成或失败时立即响应，到期则返回当前状态。等待期间释放服务锁，分块、任务进度和其他查询仍可正常执行。文件夹队列使用此接口避免逐文件轮询计时器空等；老后端仍使用原轮询方式。

连续任务复用 SMB 会话，批次内每个并行工作线程独占一条连接缓存，最多 4 条，避免掉线时并行重连产生未跟踪连接。发生错误、修改配置或下次任务距上次使用超过 60 秒时关闭并重建。已有深层目录只检查完整父路径一次，批次内共同目录只准备一次；实际文件操作仍逐层拒绝链接和重解析路径。复用连接不缓存路径安全结果。

配置响应提供 `batch_upload`、`batch_max_files`、`batch_max_bytes`、`batch_max_file_bytes`；前端按这些能力合并小文件，旧后端仍走原单文件流程。合并只影响传输方式，NAS 上仍是原文件与目录，不会保存成压缩包。大文件仍逐个传输并读回校验；大量小文件的吞吐不能等同于单个大文件的网络带宽。更新需要在上传暂停或结束后重启后端并刷新页面，运行中的旧页面不会自动切换实现。

可选性能复测：`py -3.14 scripts/benchmark_bridge.py --ui --batch --files 20`。此命令会读取本机 NAS 配置，在桥根目录内创建独立随机测试目录，只上传生成的测试数据，并清理这些精确列出的文件；不读取用户文件，也不修改运行中的服务状态。省略 `--batch` 可对比原逐文件流程。`--max-seconds` 可设置本机性能门槛，网络计时不纳入 CI。

`py -3.14 backend/bridge_test.py` 使用隔离临时目录验证真实 HTTP 路由、认证、跨站拦截、分块续传、校验、同名保护、失败重试、进程互斥和重启恢复，不接触真实 NAS。已加入 `pnpm run check:backend` 与 `check:all`。
