# FIREFLY-SENSE 数据

这里保存 FIREFLY R1.1 感知板的纯传感器数据，可随 FlitFancy 仓库备份。
后端的 `backend/data/flitfancy.db` 仍然忽略，因为它还包含日记等非传感器内容。

此目录是完整原始数据的永久保存位置：监听器和 FlitFancy 后端都没有按天数删除这里文件的逻辑。
SQLite 仅保留 14 天，是为了控制网页查询库增长；它的清理不会影响这里的 CSV。

## 目录

- `archive/daily/`：此前按电脑日期合并的数据，带 `pc_time`。
- `archive/raw-no-time/`：从板载 LittleFS 或早期工具导出的原始数据，没有可靠绝对时间。
- `archive/sessions/`：此前每次 Wi-Fi 监听会话的原样副本。
- `archive/legacy/`：旧实时缓存的只读快照，可能与 sessions/daily 重复。
- `sessions/`：监听器正在写入的会话 CSV，Git 忽略。下次启动监听器时，上次已结束的文件会自动移入 `archive/sessions/`。
- `live/`：仪表盘实时缓存；会不断变化，因此被 Git 忽略。
- `manifest.csv`：`archive/` 内文件的大小、行数和 SHA-256。

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

旧文件有 24/25 个板端字段，新文件有 28 个板端字段；读取器按实际行宽兼容。
`ok=0` 时数值通常为 `NA`。不同通道无关的字段在旧固件里可能写为 `0`，
不能把这些零当作有效测量值。

## 隐私与备份边界

文件不含密码、令牌、对话或日记。它们会包含精确采集时间和室内环境变化；
公开仓库中的温湿度、CO2、光照变化可能间接透露有人活动的时间规律。
如果以后不希望公开这些规律，应把仓库设为私有，或只提交降采样后的日/月汇总。

在站点仓库根目录运行
`powershell -ExecutionPolicy Bypass -File scripts/update_sensor_manifest.ps1` 可重建清单。
正在写入的 session 不会进入清单；监听器下次启动将它归档后，再重建即可。

## 当前数据链路

1. 感知板通过 TCA9548A 按通道读取 6 类传感器，从 Wi-Fi TCP `7777` 发出以 `CSV,`
   开头的行。
2. `listen_wifi.ps1` 加上电脑本地时间，同时写入会话文件和 `live/firefly_live.csv`，
   并将每行 POST 到 FlitFancy 本地后端。
3. FlitFancy 在 SQLite 保留最近 14 天的查询副本；后端异步同步每个通道的最新快照到 Cloudflare Worker，
   公网控制台读取的是最新快照，不是全部历史。

当前板上运行 FW 1.2 独立调度固件；旧 24/25 字段归档仍保持只读兼容。
