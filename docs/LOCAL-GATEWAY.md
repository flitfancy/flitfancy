# 同域名本机 HTTPS 入口

本机和公网共用 `https://console.flitfancy.com/console.html` 及同一个网站后端。

- 本机：hosts → `127.0.0.1:443` Caddy → `127.0.0.1:2671` 网站后端。
- 公网：Cloudflare Tunnel → `127.0.0.1:2671` 网站后端。
- Caddy 保留原 Host，网站仍按域名入口要求管理员登录；不会直接暴露音频或 AI 服务。
- Caddy 的 80、443、2019 端口都只监听回环地址。

## 文件和进程

- 配置：`site/config/Caddyfile`。
- 官方程序：`tools/caddy/caddy.exe`（2.11.4，安装包已核验官方 SHA-512）。
- 启动：`site/scripts/start_local_gateway.ps1`；已有 `start_flitfancy.bat backend/all` 会调用它。
- 守护：`site/scripts/watch_local_gateway.ps1`，检查 Caddy 管理接口，连续三次失败才重启。
- 日志：仓库外 `logs/caddy.err.log`、`gateway-watchdog.*.log`。
- 证书和 ACME 私钥：Caddy 默认的当前用户应用数据目录；不复制到公开网站目录。

## 证书验证与续期

使用 Let's Encrypt HTTP-01 验证，不需要新增 DNS API 令牌。
本机 cloudflared 配置只增加优先匹配规则：

```yaml
- hostname: console.flitfancy.com
  path: '^/\.well-known/acme-challenge/[A-Za-z0-9_-]+$'
  service: http://127.0.0.1:80
```

普通公网请求仍去网站后端。Caddy 只在有效挑战期间应答验证内容，其余 HTTP 请求返回 404。
续期依赖隧道可达，因此本机绕过公网后仍应保留隧道和证书有效期检查。

## 启用与回退

运行 `scripts/set_local_gateway.ps1 -Mode Enable`。脚本先验证本地 HTTPS 证书，
随后弹出 Windows 管理员确认，只为修改 hosts；系统代理例外在原用户上下文中设置。
重复启用不会重复 hosts 条目；遇到其他目标的同名条目会停止，避免覆盖。

回退运行 `scripts/set_local_gateway.ps1 -Mode Disable`，仅删除本工具创建的 hosts 块
和系统代理例外，保留其他条目。公网 DNS 从未修改。

这台电脑的 Clash Verge 持久化设置已加入
`system_proxy_bypass: console.flitfancy.com`，并保留 `use_default_bypass: true`。
配置位于 `%APPDATA%/io.github.clash-verge-rev.clash-verge-rev/verge.yaml`，
修改前已在同目录保存 `verge.yaml.before-flitfancy-*` 备份，重启 Clash 后绕过仍然有效。
回退时先在 Clash 的“系统代理绕过”设置中移除 `console.flitfancy.com`，
再运行上面的 Disable 脚本。脚本只管理 Windows 当前代理设置，不会修改 Clash 偏好。
不要把仅配置代理内部 DIRECT 规则当成浏览器绕过代理。

## 实施步骤

1. 确认公网隧道和本机入口共用 `127.0.0.1:2671`，保留网站登录验证。
2. 安装并核验官方 Caddy，配置仅回环地址可访问的 HTTPS 反向代理。
3. 通过现有隧道完成域名证书验证，先确认受信任的本机 HTTPS 可以访问。
4. 在这台电脑的 hosts 中将控制台域名指向 `127.0.0.1`；公网 DNS 保持原配置。
5. 将同一域名加入 Windows 和 Clash 代理绕过，避免代理重新使用公网解析。
6. 接入现有启动脚本、配置故障恢复，再分别验证本机入口与公网入口。

此 hosts 设置只影响这台电脑。家里其他电脑和手机仍走公网隧道。
本机路由固定生效，不会在 Caddy 停止后自动切回公网；守护进程负责恢复 Caddy，
也可以通过上述回退步骤恢复公网访问。电脑重新登录后仍需使用现有工作台启动入口启动服务。

## 验证

```powershell
curl.exe --noproxy "*" --resolve console.flitfancy.com:443:127.0.0.1 https://console.flitfancy.com/console.html -o NUL -w "%{http_code} %{remote_ip} %{ssl_verify_result}"
powershell -NoProfile -ExecutionPolicy Bypass -File tests/local-gateway.test.ps1
```

期望页面 200、地址 127.0.0.1、证书校验 0；未登录的 `/api/audio/status` 返回 401。
切换后旧管理员令牌可能因访问来源改变而失效，重新登录即可。
本机解析启用后，公网回归测试必须使用其他设备或明确走公网解析的测试请求。
