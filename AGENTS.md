# AGENTS.md — AI 协作者上岗手册

> 本文件面向在此仓库工作的 AI 助手（Claude Code / Codex / Cursor 等）。
> 目标：让任何 AI 不需要试错就知道规矩在哪、东西往哪放、怎么安全上线。
> 深度背景（私有，不在本仓库）：`../handoff/site_handoff.md`（主交接）与
> `../handoff/版本详录.md`（每版本的坑与收获）。

## 项目一句话

flitfancy.com：云萤的个人网站（GitHub Pages，发布目录为 `docs/`）
+ Cloudflare Worker 公网 API（api.flitfancy.com）
+ 本机 Python 控制台后端（端口 2671，仅本机与隧道可达）。

## 目录地图

```text
site/
├── docs/            ← 公开网站（Pages 发布根；改这里 = 改网站）
│   ├── index/journal/console/about/resources/observations/remote.html
│   ├── assets/      全部 css/js（style.css 是主样式表）
│   └── resources/   可公开下载的附件（固件/资料包，带版本号与 SHA-256）
├── backend/         Python 本地服务：server.py 入口 + flitfancy_*.py 领域模块
├── cloudflare/      Worker：worker.js 入口 + worker-*.js 模块
│   └── package.json ← ★ 版本号单一来源（语义化版本）
├── scripts/         set-version.mjs（版本联动）/ release.ps1（发版自动化）
├── tests/           Node 单测（含骨架一致性与版本一致性守卫）
└── data/sensors     运行数据 —— 永不提交
```

## 铁律（违反任何一条都请停下来询问用户）

1. **未经用户明确同意，不得 git commit / push。**
2. 密钥只存在于 `backend/ai_local.json` 与 Cloudflare 加密变量；
   任何密钥/令牌/密码绝不进入代码、日志、提交信息或对话输出。
3. `backend/data/`、`data/sensors/` 与一切运行数据不入库（已被 .gitignore，
   不要绕过）。
4. 改动了被 HTML 引用的任何文件后，必须递增资源版本（见下方发布流程
   第一步），否则访客拿到的还是旧缓存。
5. 固件类产物严禁携带真实 WiFi 凭证（历史上有一版因此下架）；
   新固件必须走"首次上电配网"，凭证不进编译。

## 标准发布流程（一条命令）

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\release.ps1 `
  -Version 1.3.14 -Message "feat: your change summary"
```

脚本自动完成：工作区干净检查 → 版本号统一（package.json + 全部 `?v=`）→
全量检查（前端/Worker/样式/后端冒烟）→ 暂存格式审计 → 密钥正则扫描 →
提交 → 打标签 → 原子推送 → 轮询线上版本号（最长约 14 分钟）→
若 Pages 跳过构建，自动推空提交扳机并再等一轮。
加 `-DryRun` 可演练到提交前一步（不会提交/推送）。

要求：commit message 用英文祈使句（feat:/fix:/docs:/style:/tooling:）。

## 各内容区投放指南

### 资源页（resources.html）卡片

在对应栏位（FireFly·天心 / SkyWork·天工 / FlitFancy·云萤）的
`<details class="resource-group">` 内追加卡片：

```html
<article class="mini-card">
  <h3>条目标题</h3>
  <p>一段话简介。</p>
  <p class="mini-meta">元信息（版本/日期/SHA-256 等）。</p>
  <!-- 附件放 docs/resources/，此处给相对链接 -->
</article>
```

规则：附件文件放 `docs/resources/`（随 Pages 公开），文件名带版本号，
卡内标注 SHA-256；固件类产物先过配网改造（铁律 5）。

### 见闻星球 / 日记 / 锚点 / 短文 / 随笔

这些是**运行时内容**：通过管理界面或管理 API 写入（本地后端 +
管理员会话），不要以改代码的方式添加。公开读取接口在 Worker 上。

### 新页面 / 导航调整

必须同步：五页导航骨架一致（`tests/html-skeleton.test.mjs` 守卫）、
资源引用带当前 `?v=`、移动端断点遵循既有约定（桌面优先 + max-width）。

## 验证命令速查（在 `cloudflare/` 目录下）

| 目的 | 命令 |
|---|---|
| 全量检查 | `cmd /c "pnpm run check:all"` |
| 仅前端/Worker/样式 | `cmd /c "pnpm run check:js"` |
| 仅后端 | `cmd /c "pnpm run check:backend"` |

## 常见坑速查

| 症状 | 处置 |
|---|---|
| push 后线上版本没变 | 连续推送会跳过 Pages 构建：推一个空提交扳机（release.ps1 已内置）|
| pnpm 报执行策略错误 | 用 `cmd /c "pnpm ..."` 包装，不要直接调 pnpm.ps1 |
| 读含中文的本地 JSON 乱码/解析失败 | PowerShell 读文件必须带 `-Encoding UTF8` |
| 测试报 MODULE_NOT_FOUND | 你可能站在 `cloudflare/` 目录——Node 测试要从仓库根跑 |
| wrangler dry-run 打印 exiting 后挂住 | 构建已成功，结束残留进程即可 |
| git push 报 TLS 握手失败 | 网络瞬断，重试一次即可 |

## 已有防线（不要绕过）

- stylelint：`font-size` 仅允许 `var(--fs-*)`；`background-clip: text`
  仅允许 `.grad-clip`（唯一豁免行在 style.css）；重复选择器/空块/
  同块重复声明即报错
- `tests/html-skeleton.test.mjs`：主页面导航/页脚骨架一致性
- `tests/version-consistency.test.mjs`：全库 `?v=` 与包版本一致
- 后端冒烟：隔离临时库 + 独立端口，可重复运行，不碰真实数据
