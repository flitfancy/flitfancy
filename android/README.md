# FlitFancy 安卓底座 0.2.0

用途：承载线上网站，通过 Wi-Fi 或 BLE 读取 FIREFLY-SENSE 感知板的环境/心率 CSV，缓存后上传到本机主机。
0.2.0 已实现 App 的 BLE 中心端；感知板固件 1.3.5 尚无手机数据服务，需后续固件按照 [BLE 协议](BLE_PROTOCOL.md) 配合。当前板子可以继续使用 Wi-Fi 模式。
网站发布后，冷启动与手动刷新重新获取网页；回到前台检测网站版本，有未保存内容时由用户选择刷新。
Kotlin、系统 WebView、外设连接前台服务、Room 队列。Android 8.0 起可安装，目标 Android 16；安装包使用本地私钥签名。

## 小米 15 Pro / HyperOS 3 使用

首次接入需主机后端加载网站 1.29.0 起的采集接口；当前主机已完成重载。
迁移到尚未加载接口的新主机时，在管理员 PowerShell 运行现有受控重载脚本，再生成手机配对码：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "S:\FlitFancy\site\scripts\reload_backend.ps1"
```

1. 下载并安装 `https://flitfancy.com/resources/flitfancy-android-0.2.0.apk`，可直接覆盖 0.1.0；不要卸载旧版以免删除待上传缓存。
2. App → 采集，选择连接方式。Wi-Fi：手机连接感知板所在局域网并保存板子地址，默认 `http://192.168.1.33`。蓝牙：板子具备新数据服务后，点击“扫描并选择感知板”，允许附近设备权限；手机可通过自己的 Wi-Fi 或流量上传。
3. 点击“打开网站管理页生成配对码”，在 `console.flitfancy.com` 再次点击导航中的“控制台”登录。
4. 管理页“手机采集”填写来源别名，生成配对码。回到 App 的采集页，输入 12 位配对码；10 分钟有效，仅用一次。
5. 点击“开始采集”，允许通知。通过“允许锁屏持续采集”处理系统电池优化；在本 App 系统设置检查 HyperOS 自启动、通知和后台省电。
6. 页面/通知栏显示连接状态、待上传数量和最近成功上报时间；暂停会保留缓存。

升级后原配对信息、Wi-Fi 地址及 Room 缓存保留，默认仍使用 Wi-Fi。先暂停，再切换方式或选择另一块板子。蓝牙首次连接会请求系统配对；只有确认型号与协议、完成绑定并收到完整快照后才会缓存数据。
扫描只在前台手动启动，最多 12 秒，离开 App 或取消会停止。后台使用已保存的绑定地址重连，不持续扫描附近设备。Android 12 及以上不申请定位；Android 8–11 扫描需要旧系统的定位权限和定位开关，App 不读取位置。
未找到板子不表示手机后端配对失败；检查板子数据固件、供电和距离。当前固件 1.3.5 没有本协议服务，App 会明确提示。

Wi-Fi 模式通过感知板现有 `/data` 和 `/device` 接口采集；`/data` 已包含 CH6 心率 CSV。
蓝牙模式使用协议 1 请求环形快照并校验分片、请求编号与完整行数，无需与板子处于同一 Wi-Fi。两种方式共用解析与上传链路。
上传目的地为当前主机的 `console.flitfancy.com`，
主机与隧道需要运行；主机离线时手机保留队列。主机再异步同步最新快照到现有 Worker，不要求手机持有云端管理员令牌。
最新心率与来源别名继续公开展示，心率历史仍使用本机鉴权接口。

## 队列与身份

- 配对后手机只取得该设备的上报权限；不能用上报凭证登录管理接口。凭证经 Android Keystore 加密，App 数据不参加系统自动备份。
- 每 5 秒读取一次板端环形缓存，通过 uptime 重建样本时间；同一启动批次的原始行产生稳定事件 ID。
- 主机先保存查询数据和原始 JSONL、执行 fsync，再提交收据并确认。手机收到完整事件列表后才清队列。
- 重试不会重复入库；桌面与手机看到同一物理帧时，在窄时间窗口内合并。主机及上云队列按采样时间选最新值，旧补传不会变成实时读数。
- 队列上限 100000 条；满时暂停新增采集并继续尝试上传，不静默覆盖原数据。支持导出待上传 JSONL。
- 更换配对时，有待上传数据需在管理页对原设备“重新配对”；使用新设备编号会被阻止以避免错归来源。
- 手机原始记录归档在主机 `data/sensors/collectors/YYYY-MM/<device-id>.jsonl`，随完整工作区备份。极端数据库提交失败后的原始日志重试可能留下同事件 ID 的重复行，可据编号识别；查询库和收据保持幂等。

持续采集会增加耗电。前台服务与带超时续期的 CPU 锁支持锁屏工作，但 HyperOS 的省电/用户强制停止仍可能中断。
真机需要验证锁屏、重启、Wi-Fi 切换、主机断网和补传，以及新固件与手机/手表同时蓝牙连接。当前已通过 BLE 分片/完整快照/UTF-8/边界测试、权限与升级设置测试、解析、Room 队列和既有上传接口测试；没有把软件测试等同于手机实测。

## 构建

```powershell
py -3 scripts/setup_android.py
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build_android.ps1 -Check
```

工具位于仓库外 `S:\FlitFancy\tools\android-build`，使用校验过的官方 JDK/Gradle/SDK。
本地 `android/local.properties`、依赖缓存和 build 输出忽略 Git。
签名私钥为 `backend/data/android-signing.p12`；路径和密码存在忽略的 `backend/ai_local.json` 的 `android_signing` 下。
这两份材料都需保留，后续 APK 才能覆盖安装。迁移主机后调整配置内的 keystore 路径；不要创建新私钥来替换已有安装的签名。

## 已实现与后续范围

已实现网站加载/版本提示、单文件选择、公开资源下载、原生返回导航、感知板 HTTP/BLE 接收端、后台服务、配对及缓存上报。
网页原生接口 `FlitFancyNative` 仅对受信任网站的顶层页面开放，协议 1 支持 status/start/stop，不返回上传凭证。
首版还没有手表直接 BLE 接入、来源筛选、手机常驻作为完整后端、网页一键迁移主机；这些仍属于后续阶段。
首次配对使用手动配对码，尚未加入扫码。网页 Blob 导出与文件夹选择受 WebView 支持限制，手机缓存使用 App 自带导出入口。

App 版本独立于网站版本；本次网站仍为 1.29.1、App 为 0.2.0。BLE 协议与 Android 发布记录见本目录 BLE_PROTOCOL.md / CHANGELOG.md。[Android 权限说明](https://developer.android.com/develop/connectivity/bluetooth/bt-permissions)、[后台蓝牙说明](https://developer.android.com/develop/connectivity/bluetooth/ble/background)。
