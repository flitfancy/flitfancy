# FIREFLY-SENSE 数据

这里保存感知板六路环境数据和手表 BLE 心率的原始 CSV。同一会话内以 CH0–CH6
区分通道；会话之间分文件保存。运行数据及后端数据库不提交到 Git；本 README 是版本管理中的说明文件。

此目录是原始数据的永久保存位置：监听器不会按天数删除 CSV；启动时会把上一次
已经结束的会话移入 `archive/sessions/`。
SQLite 仅保留 14 天，是为了控制网页查询库增长；它的清理不会影响这里的 CSV。
永久保存只表示已经收到的数据不会因保留期限被删除；板子断电、监听器未运行或
网络中断的时段仍会形成明确的数据空档。

## 目录

- `archive/daily/`：此前按电脑日期合并的数据，带 `pc_time`。
- `archive/raw-no-time/`：从板载 LittleFS、早期工具或时间修复前备份的原始数据，
  没有可靠绝对时间。
- `archive/sessions/`：此前每次 Wi-Fi 监听会话的原样副本。
- `archive/legacy/`：旧实时缓存的只读快照，可能与 sessions/daily 重复。
- `sessions/`：本次监听期间的会话 CSV，Git 忽略。表头改变时修正后的监听器会新建文件，旧文件保留；同表头重连继续原文件。下次启动监听器时，已结束文件移入 `archive/sessions/`。
- `live/`：仪表盘实时缓存；会不断变化，因此被 Git 忽略。
- `manifest.csv`：`archive/` 内文件的大小、行数和 SHA-256。
- `repair-reports/`：历史数据修复报告，记录哪些行得到可靠时间锚点、哪些仍然未知。

## 时间与字段

带电脑时间的行以 `pc_time` 开头，格式为本机 Asia/Shanghai 时间。随后是：

`uptime_ms, cycle, channel, sensor, ok, temp_c, rh_pct, als_raw, uv_raw,
f1_415..f8_680, clear_raw, nir_raw, voc_index, nox_index, sraw_voc,
sraw_nox, co2_ppm, pressure_pa`

新版固件末尾再增加：

`as7341_atime, as7341_astep, as7341_gainx`

1.2 独立调度固件末尾再增加：

`sample_age_ms, sample_seq, error_streak, firmware_version, schema_version, scheduler`

`sample_age_ms` 表示该快照距离这路最后一次成功实采的时间，而不是网页上报时间；
`sample_seq` 每次成功实采递增；`error_streak` 是连续实采错误数。
`firmware_version/schema_version/scheduler` 使每一行归档都可以追溯它来自哪个已烧录版本。

历史文件曾使用 24/25/28 个板端字段；schema 4 为 36 个，schema 5 为 40 个。
PC CSV 再加一列 `pc_time`，schema 5 共 41 列；读取器按实际行宽兼容。
`ok=0` 时数值通常为 `NA`。不同通道无关的字段在旧固件里可能写为 `0`，
不能把这些零当作有效测量值。

## 隐私与备份边界

CSV 包含精确采集时间、环境读数和个人心率，按本机运行数据保存，不提交到 Git。
交接 Markdown 只说明位置、字段和验证结果，不存放全部采样数据。

数据库日备份另外集中在 `B:\FlitFancy\data\daily\`：每次生成一份完整 `.db` 文件，
现有任务配置保留最近 14 份。它备份 `backend/data/flitfancy.db`，不包含本目录内
独立保存的全部长期 CSV。`live/` 是可覆盖缓存；原始长期记录以 sessions 及 archive 为准。

完整工作区备份位于 `B:\FlitFancy\workspace\snapshots\`，包含原始 CSV、在线一致性数据库快照、
网站与固件的源码/Git 历史、交接文档，以及独立保存的本地配置。每天 04:00 运行，保留最近 14 份
校验通过的完整快照；访问权限限当前用户、管理员和 SYSTEM。恢复方式见 `../../BACKUP.md`。

在站点仓库根目录运行
`powershell -ExecutionPolicy Bypass -File scripts/update_sensor_manifest.ps1` 可重建清单。
正在写入的 session 不会进入清单；监听器下次启动将它归档后，再重建即可。

2026-08-28 至 2026-09-12 使用过的一版监听器曾把固定字符串 `pc_time` 写入数据行。
`scripts/repair_sensor_timestamps.py` 可利用 SQLite 接收时间和板端 `uptime_ms` 恢复有
可靠锚点的片段；无法可靠恢复的行保持 `pc_time`，不会伪造精确时间。加 `--apply`
才会写入，并会先把原文件逐字节备份到
`archive/raw-no-time/pc-time-literal/`。

## 当前数据链路

1. 感知板通过 TCA9548A 按通道读取 6 类传感器，从 Wi-Fi TCP `7777` 发出以 `CSV,`
   开头的行。
2. `listen_wifi.ps1` 加上电脑本地时间，同时写入会话文件和 `live/firefly_live.csv`，
   并将每行 POST 到 FlitFancy 本地后端。
3. FlitFancy 在 SQLite 保留最近 14 天的查询副本；后端异步同步 CH0–CH6 最新快照及环境通道聚合历史到 Cloudflare Worker。
   自网站 v1.28.3 起，公开存在页也展示 CH6 最新心率；心率历史仍仅从登录后的本机接口读取，不上传云端历史。

## 手表心率（FW 1.3.5 / schema 5）

板端字段尾部追加 `heart_rate_bpm,hr_connected,hr_contact,hr_state`，旧字段位置不变。
CH0–CH5 仍对应原有六路环境传感器；逻辑 CH6 为 BLE 心率，每 2 秒输出一条状态快照。
`hr_contact=NA` 表示手表不提供佩戴接触信息。断线、接触不良或有效心率超过 15 秒未更新时，
`ok=0` 且 `heart_rate_bpm=NA`；缺测不是 0 bpm。

心率原始数据包含个人生理读数，保存在本机 session/live CSV 和 14 天 SQLite 查询副本。
自网站 v1.28.3 起，`/api/sensors/latest` 与 Worker `/sensors/latest` 包含 CH6 最新状态，
公开存在页显示心率卡片。`/api/sensors/heart-rate/history` 仍需管理员登录；匿名历史及云端历史同步排除 CH6。
退出登录保留公开心率卡片并清理历史视图；断线或有效样本过期时清空数值，不把旧读数当作实时心率。
此目录内全部运行数据继续遵循 AGENTS.md：不提交到 Git。

固件采用独立调度；当前实板版本和验收状态以固件工程 `CURRENT_HANDOFF.md` 为准。
旧 24/25 字段归档仍保持只读兼容。
