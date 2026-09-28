# 电脑使用：ActivityWatch 接入与长期归档

存在页登录后显示“电脑使用”卡片。公开页面不会请求私有统计；汇总和导出都经过网站后端统一管理员鉴权。

## 数据流与统计口径

ActivityWatch 持续采集前台应用与 AFK 状态；网站后端从本机接口读取，按 `Asia/Shanghai`（UTC+8）分天计算并归档。页面每 10 秒刷新一次，后端采集不依赖网页保持打开。数据实际新鲜度取决于 ActivityWatch 两个 watcher 的采集和入库时间；页面同时显示来源是否在线及记录更新时间。

活跃时长是前台应用记录与 `not-afk` 时段的交集，重复事件不会重复累计。它不等于开机时长、工作时长或实际坐在电脑前的时间。没有键鼠操作的阅读、观看视频等可能被 AW 判为离开。前台记录覆盖时长另外保留，不能将其直接视为电脑使用时长。

无记录日期与“有记录但活跃时间为 0”分别表示；尚未回填的日期也独立标识。存在来源缺失的区间会保留质量标记，不根据空白日期猜测使用情况。

## 保存范围

- 网站数据库中的 `activity_days`、`activity_apps`、`activity_meta` 表保存按天、按应用汇总及采集状态。
- 汇总长期保留，不随传感器明细的 14 天清理策略删除。首次逐步回填最近 90 天，之后持续积累。
- 原始窗口标题、网页地址、聊天内容不写入这些归档表，也不通过统计 API 返回。原始明细仍由 ActivityWatch 自己保存。
- AW 暂时离线或历史接口读取失败时，保留已经归档的汇总，不用 0 覆盖旧记录。
- 表位于现有网站 SQLite 数据库（默认 `backend/data/flitfancy.db`），因此用现有 SQLite 备份脚本创建数据库快照时也会包含这些表。本次先保存在本机，尚未自动同步 NAS。

长期保留需要保管好网站数据库；这一份本机归档本身不等于另有一份灾备副本。后续 NAS 备份可复用整库快照，无需重新采集 AW。

## 接口与配置

| 接口 | 用途 |
| --- | --- |
| `GET /api/activity/summary?days=7&end=2026-09-26` | 今日概况、指定区间趋势、应用分布、来源新鲜度与归档状态 |
| `GET /api/activity/export?days=30&end=2026-09-26` | 导出指定区间的汇总 JSON，不导出原始事件 |

`days` 为 1–366 天，`end` 为北京时间的结束日期（含当天），省略时使用今天。已归档的更早区间可以通过日期选择器回看。两个接口在本机和远程都需要管理员会话，响应不缓存。

后端默认读取 `http://127.0.0.1:5600`。环境变量 `FLITFANCY_ACTIVITYWATCH_URL` 可指定其他本机回环 HTTP 端口，不接受公网地址、凭据、路径或重定向。`FLITFANCY_ACTIVITYWATCH_ENABLED=0` 停止自动采集；已保存的归档仍可读取。网站不修改 ActivityWatch 的采集规则或数据，也不开放它的 5600 端口。

代码更新后需重启网站后端以启动采集线程，再刷新存在页并登录。前端遇到旧后端不支持新接口时会提示重启。

## 验证

`backend/activity_test.py` 使用合成事件验证时间交集、重叠去重、跨日边界、持久化和离线保留。`backend/activity_http_test.py` 使用临时数据库与模拟 AW 验证真实 HTTP 的登录边界、导出和参数限制。测试不读取个人 AW 数据；后端冒烟测试显式关闭 AW 自动采集。

接口与统计参考：[ActivityWatch REST API](https://docs.activitywatch.net/en/latest/api/rest.html)、[Working with ActivityWatch Data](https://docs.activitywatch.net/en/latest/examples/working-with-data.html)。
