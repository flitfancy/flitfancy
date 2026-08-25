@echo off
setlocal EnableExtensions
chcp 65001 >nul

rem ============================================================
rem  云萤 FFS 服务启动器（协议触发经 start_flitfancy.ps1 白名单校验后调用）
rem  动作：backend | listener | tunnel | dsh | all（缺省 all；dsh 不并入 all）
rem  幂等：已在运行的服务自动跳过；日志写到 logs\starter.log
rem ============================================================
rem  目录假设（迁移机器时必须复刻）：
rem    本文件位于 <仓库>\site\scripts\ 下，ROOT 取 %~dp0..\.. = <仓库> 的父目录。
rem    - logs\           -> %ROOT%\logs（仓库外，勿提交）
rem    - cloudflared.exe -> %ROOT%\tools\cloudflared.exe（隧道可执行文件）
rem    改仓库位置无需改动本文件；但换机器克隆必须保证这两个路径存在，
rem    否则日志会写到意外位置、隧道无法启动。
rem ============================================================

for %%I in ("%~dp0..\..") do set "ROOT=%%~fI"
set "LOG_DIR=%ROOT%\logs"
set "STARTER_LOG=%LOG_DIR%\starter.log"
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"

rem PS 助手：所有内联 PowerShell 一行式已抽到 svc_helpers.ps1，引号只此一处维护
set "PSH=powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0svc_helpers.ps1""

rem --- 动作校验：只接受白名单字面量，绝不把 %1 赋给变量或拼进命令/日志 ---
rem %1 是不可信输入：协议 URL 可被任意网页触发，也可被本地进程直调。
rem 这里只做字面量直接比较；含引号/&/| 的输入只会让比较失败而被忽略。
rem 协议触发一律先经 start_flitfancy.ps1 正则白名单校验，再传入字面量。
if /i "%~1"==""       goto :do_all
if /i "%~1"=="backend"  goto :do_backend
if /i "%~1"=="listener" goto :do_listener
if /i "%~1"=="tunnel"   goto :do_tunnel
if /i "%~1"=="dsh"      goto :do_dsh
if /i "%~1"=="all"      goto :do_all
call :log "未知动作：已忽略（可用 backend / listener / tunnel / dsh / all）"
goto :end

:do_all
call :do_backend
call :do_listener
call :do_tunnel
call :log "=== starter 完成 ==="
goto :end

rem ===================== 本地后端（2671） =====================
:do_backend
call :log "=== starter 开始（backend） ==="
set "BACKEND=%ROOT%\site\backend"
set "SERVER=%BACKEND%\server.py"
if not exist "%SERVER%" (
  call :log "错误：找不到 server.py：%SERVER%"
  goto :eof
)
set "PYTHON_EXE="
for /f "delims=" %%P in ('py -3 -c "import sys; print(sys.executable)" 2^>nul') do set "PYTHON_EXE=%%P"
if not defined PYTHON_EXE (
  for /f "delims=" %%P in ('python -c "import sys; print(sys.executable)" 2^>nul') do set "PYTHON_EXE=%%P"
)
if not defined PYTHON_EXE (
  call :log "错误：找不到 Python（py -3 或 python）"
  goto :eof
)
rem --- 智能判定：pid 文件活着且 /api/status 健康 → 跳过；否则杀掉旧进程重启 ---
set "BE_PIDFILE=%LOG_DIR%\backend.pid"
set "BE_NEED_START=1"
if exist "%BE_PIDFILE%" (
  for /f "usebackq delims=" %%Q in ("%BE_PIDFILE%") do (
    %PSH% -Action is-alive -ProcessId %%Q
    if not errorlevel 1 (
      %PSH% -Action backend-health
      if not errorlevel 1 set "BE_NEED_START=0"
    )
  )
) else (
  %PSH% -Action backend-stale-kill
  if not errorlevel 1 set "BE_NEED_START=0"
)
if "%BE_NEED_START%"=="1" (
  if exist "%BE_PIDFILE%" (
    for /f "usebackq delims=" %%Q in ("%BE_PIDFILE%") do %PSH% -Action stop-process -ProcessId %%Q
    del "%BE_PIDFILE%" >nul 2>nul
  )
  %PSH% -Action start-backend -Exe "%PYTHON_EXE%" -WorkDir "%BACKEND%" -OutLog "%LOG_DIR%\server.out.log" -ErrLog "%LOG_DIR%\server.err.log" -PidFile "%BE_PIDFILE%"
  call :log "后端：已启动（新进程）"
) else (
  call :log "后端：已在运行且健康，跳过"
)
%PSH% -Action wait-backend
if errorlevel 1 (
  call :log "错误：后端 20 秒内未就绪（%LOG_DIR%\server.err.log）"
  goto :eof
)
call :log "后端就绪：http://localhost:2671"
goto :eof

rem ================= 感知板监听器（7777） =================
:do_listener
call :log "=== starter 开始（listener） ==="
set "SENSOR_WATCHDOG=%ROOT%\site\scripts\watch_sensor_listener.ps1"
set "SENSOR_DATA=%ROOT%\site\data\sensors"
set "SENSOR_LISTENER="
if exist "%ROOT%\site\scripts\vendor\listen_wifi.ps1" set "SENSOR_LISTENER=%ROOT%\site\scripts\vendor\listen_wifi.ps1"
if not defined SENSOR_LISTENER (
  for %%D in ("%ROOT%\..\SkyWorks") do (
    if exist "%%~fD\FIREFLY REAL-WORLD SENSE\FIREFLY REAL-WORLD SENSE-ds\FIREFLY-SENSE-ds\scripts\listen_wifi.ps1" (
      set "SENSOR_LISTENER=%%~fD\FIREFLY REAL-WORLD SENSE\FIREFLY REAL-WORLD SENSE-ds\FIREFLY-SENSE-ds\scripts\listen_wifi.ps1"
    )
  )
)
if not defined SENSOR_LISTENER (
  for %%D in ("%USERPROFILE%\Documents\fireflys") do (
    for /r "%%~fD" %%F in (listen_wifi.ps1) do if not defined SENSOR_LISTENER set "SENSOR_LISTENER=%%F"
  )
)
if not defined SENSOR_LISTENER (
  call :log "警告：未找到 listen_wifi.ps1，监听器无法启动（可放入 site\scripts\vendor\）"
  goto :eof
)
rem --- 单实例判定（PID 文件，确定性，不依赖 WMI 命令行字符串）---
rem 已在运行且后端报"监听器健康" → 跳过；进程已死或监听器不健康
rem 数据不新鲜 → 先杀旧进程再启动，保证"点一下 = 修好"。
set "WD_PIDFILE=%LOG_DIR%\sensor-watchdog.pid"
set "WD_NEED_START=1"
if exist "%WD_PIDFILE%" (
  for /f "usebackq delims=" %%Q in ("%WD_PIDFILE%") do (
    %PSH% -Action is-alive -ProcessId %%Q
    if not errorlevel 1 (
      %PSH% -Action listener-health
      if not errorlevel 1 set "WD_NEED_START=0"
    )
  )
)
if "%WD_NEED_START%"=="1" (
  if exist "%WD_PIDFILE%" (
    for /f "usebackq delims=" %%Q in ("%WD_PIDFILE%") do %PSH% -Action stop-process -ProcessId %%Q
    del "%WD_PIDFILE%" >nul 2>nul
  )
  %PSH% -Action start-watchdog -Watchdog "%SENSOR_WATCHDOG%" -Listener "%SENSOR_LISTENER%" -Port 7777 -DataRoot "%SENSOR_DATA%" -OutLog "%LOG_DIR%\sensor-watchdog.out.log" -ErrLog "%LOG_DIR%\sensor-watchdog.err.log"
  call :log "感知板监听器：已启动（新 watchdog）"
) else (
  call :log "感知板监听器：已在运行且健康，跳过"
)
goto :eof

rem ================= Cloudflare 隧道 =================
:do_tunnel
call :log "=== starter 开始（tunnel） ==="
set "CLOUDFLARED=%ROOT%\tools\cloudflared\cloudflared.exe"
set "CF_CONFIG=%USERPROFILE%\.cloudflared\config.yml"
if not exist "%CLOUDFLARED%" (
  call :log "警告：找不到 cloudflared，隧道无法启动"
  goto :eof
)
if not exist "%CF_CONFIG%" (
  call :log "警告：未找到隧道配置 %CF_CONFIG%（隧道未启动）"
  goto :eof
)
rem --- 智能判定：pid 文件活着 → 跳过；无 pid 文件时用 tasklist 兜底（不重复起）---
set "TN_PIDFILE=%LOG_DIR%\cloudflared.pid"
set "TN_NEED_START=1"
if exist "%TN_PIDFILE%" (
  for /f "usebackq delims=" %%Q in ("%TN_PIDFILE%") do (
    %PSH% -Action is-alive -ProcessId %%Q
    if not errorlevel 1 set "TN_NEED_START=0"
  )
) else (
  tasklist /FI "IMAGENAME eq cloudflared.exe" /NH 2>nul | findstr /I "cloudflared" >nul
  if not errorlevel 1 set "TN_NEED_START=0"
)
if "%TN_NEED_START%"=="1" (
  if exist "%TN_PIDFILE%" (
    for /f "usebackq delims=" %%Q in ("%TN_PIDFILE%") do %PSH% -Action stop-process -ProcessId %%Q
    del "%TN_PIDFILE%" >nul 2>nul
  )
  %PSH% -Action start-tunnel -Exe "%CLOUDFLARED%" -Config "%CF_CONFIG%" -WorkDir "%ROOT%" -OutLog "%LOG_DIR%\cloudflared.out.log" -ErrLog "%LOG_DIR%\cloudflared.err.log" -PidFile "%TN_PIDFILE%"
  call :log "隧道：已启动（新进程）"
) else (
  call :log "隧道：已在运行，跳过"
)
goto :eof

rem ============ DeepSeek Harness 大鲸鱼（3080） ============
rem  目录硬编码为本机安装位；换机器时需同步修改。
:do_dsh
call :log "=== starter 开始（dsh） ==="
set "DSH_DIR=S:\DeepSeek\deepseek-harness"
if not exist "%DSH_DIR%\package.json" (
  call :log "警告：未找到 DeepSeek Harness：%DSH_DIR%"
  goto :eof
)
set "PNPM_CMD="
for /f "delims=" %%P in ('where pnpm.cmd 2^>nul') do if not defined PNPM_CMD set "PNPM_CMD=%%P"
if not defined PNPM_CMD (
  call :log "错误：找不到 pnpm.cmd（PATH 中无 pnpm）"
  goto :eof
)
rem --- 幂等：pid 文件活着 → 跳过；否则端口 3080 已监听也跳过 ---
set "DS_PIDFILE=%LOG_DIR%\dsh.pid"
set "DS_NEED_START=1"
if exist "%DS_PIDFILE%" (
  for /f "usebackq delims=" %%Q in ("%DS_PIDFILE%") do (
    %PSH% -Action is-alive -ProcessId %%Q
    if not errorlevel 1 set "DS_NEED_START=0"
  )
)
if "%DS_NEED_START%"=="1" (
  netstat -ano | findstr ":3080" | findstr "LISTENING" >nul 2>nul
  if not errorlevel 1 set "DS_NEED_START=0"
)
if "%DS_NEED_START%"=="1" (
  if exist "%DS_PIDFILE%" (
    for /f "usebackq delims=" %%Q in ("%DS_PIDFILE%") do %PSH% -Action stop-process -ProcessId %%Q
    del "%DS_PIDFILE%" >nul 2>nul
  )
  %PSH% -Action start-dsh -Exe "%PNPM_CMD%" -WorkDir "%DSH_DIR%" -OutLog "%LOG_DIR%\dsh.out.log" -ErrLog "%LOG_DIR%\dsh.err.log" -PidFile "%DS_PIDFILE%"
  call :log "大鲸鱼：已启动（http://127.0.0.1:3080）"
) else (
  call :log "大鲸鱼：已在运行，跳过"
)
goto :eof

:log
echo [%date% %time%] %* >> "%STARTER_LOG%"
goto :eof

:end
exit /b 0
