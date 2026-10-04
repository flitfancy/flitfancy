# 本地版本与备份

## 当前范围

网站公开资源版本为 **1.28.3**，公开发布提交为 `d79d4855df1eeb51307867300ddeffc7dd16e920`。
后续备份脚本与文档维护使用独立 Git 提交，不修改网页资源版本。
固件为 **1.3.5 / schema 5**；本次建立源码基线，没有重新烧录或修改采集逻辑。
交接文档与固件分别使用本地 Git，未建立新的 GitHub 仓库。现有两个 GitHub 仓库均为公开仓库。

当前各版本及入口见 `S:\FlitFancy\handoff\VERSION_INDEX.md`。

## 备份安排

| 内容 | 位置 | 周期与保留 |
| --- | --- | --- |
| 独立数据库日备份 | `B:\FlitFancy\data\daily\` | 每天 03:30，保留 14 份 |
| 完整工作区快照 | `B:\FlitFancy\workspace\snapshots\` | 每天 04:00，保留最近 14 份校验通过的快照 |
| 当前完整快照索引 | `B:\FlitFancy\workspace\latest.json` | 成功备份后更新 |

Windows 定时任务在当前用户登录时运行，错过时间后由 `StartWhenAvailable` 补跑。
B 盘与工作区 S 盘属于不同物理磁盘；这里只配置本机第二磁盘备份。

完整快照包括：网站源码与 Git 历史、固件源码与已验证 OTA 镜像、交接文档、所有原始传感器
CSV、SQLite 在线一致性副本、本地网站配置、Wi-Fi 配置、隧道配置/凭证、Caddy 配置与运行工具。
配置凭证放在快照的 `private/` 下，不进入任何 Git 提交；备份目录访问权限限当前用户、
管理员和 SYSTEM。快照使用文件权限保护，没有配置密码加密。

Android 源码与已签名 APK 随网站仓库备份；签名私钥单独保存在 `private/android/android-signing.p12`，
签名密码随私有 `ai_local.json` 备份。迁移后应调整 android_signing.keystore 路径并保留同一私钥。
手机上传的长期 JSONL 在 data/sensors/collectors 下，也随工作区快照保存。

不包含：`.pio`/Node 等依赖缓存、全盘系统镜像、语音模型与录音、ActivityWatch 的外部原始库、
全部旧现场诊断目录和 Cloudflare D1 的独立云端备份。网站 SQLite 内已有的使用统计会随数据库备份。
正式 OTA 镜像与源码可恢复；完整板内配置/闪存镜像仍属于各现场证据目录，不能当公开附件。

## 手动备份与校验

在网站仓库根目录执行：

```powershell
py -3.14 scripts/workspace_backup.py create --config S:\FlitFancy\handoff\workspace-backup.json
py -3.14 scripts/workspace_backup.py verify --snapshot B:\FlitFancy\workspace\snapshots\workspace-日期-时间-编号
```

文件用 SHA-256 校验，数据库额外执行 SQLite `quick_check`，Git 历史使用可独立恢复的完整
bundle 并校验。正在追加的 CSV 保存备份开始时的完整字节前缀；缺测和正在写入的末行原样保留，
不伪造读数或修改源文件。备份失败不更新 `latest.json`，也不清理已有成功快照。

## 恢复到新目录

```powershell
py -3.14 scripts/workspace_backup.py restore --snapshot B:\FlitFancy\workspace\snapshots\workspace-日期-时间-编号 --destination C:\FlitFancy-Recovered
```

恢复前完整校验快照，目标目录须为空。恢复后包含 `site/`、`firmware/`、`handoff/`、
`sensors/`、`private/`、`tools/` 与 `.versions/`；源码目录会恢复 Git 分支、提交和标签，
未提交的工作文件也保留。运行数据库位于 `site/backend/data/flitfancy.db`。

恢复工具只还原文件与历史。开始运行前需将 `sensors/` 放回 `site/data/sensors/`，将
`private/site/ai_local.json` 放回 `site/backend/ai_local.json`，将 `private/firmware/wifi_config.h`
放回 `firmware/src/wifi_config.h`；隧道凭证与 Caddy 状态恢复到新用户对应目录，并调整配置中
的旧绝对路径。新电脑需要 Python 和 Git；启动器、协议与开机任务按现有安装脚本重新注册，
感知板若仍向旧电脑 IP 上报，需调整上报目标。此功能尚未实现浏览器一键导出/安装。

## 版本维护

网站按已有发布流程维护。固件和交接文档在各自本地仓库提交；每日完整快照将保存它们的
Git 历史以及尚未提交的普通工作文件。不要把 Wi-Fi 配置、本地网站配置或运行数据加入 Git。
`.gitignore` 排除这些文件；Git 历史保存改动记录，完整快照负责保存实际运行数据与私有配置。
