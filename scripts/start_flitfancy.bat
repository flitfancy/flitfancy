@echo off
setlocal EnableExtensions

rem ============================================================
rem  FlitFancy FFS service starter (invoked by the protocol handler
rem  start_flitfancy.ps1 after whitelist validation, or directly).
rem  Actions: backend | listener | audio | tunnel | all (default all)
rem  Idempotent: running+healthy services are skipped; all logs go
rem  to logs\starter.log. ASCII-only on purpose: this file must
rem  parse identically under any console codepage.
rem ============================================================
rem  Layout assumptions (must be replicated if the repo moves):
rem    this file lives in <repo>\site\scripts\ ; ROOT = %~dp0..\.. =
rem    the repo parent. logs\ -> %ROOT%\logs (outside the repo),
rem    cloudflared.exe -> %ROOT%\tools\cloudflared\cloudflared.exe.
rem ============================================================

for %%I in ("%~dp0..\..") do set "ROOT=%%~fI"
set "LOG_DIR=%ROOT%\logs"
set "STARTER_LOG=%LOG_DIR%\starter.log"
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"

rem PS helper: every inline PowerShell one-liner lives in svc_helpers.ps1;
rem quoting is maintained in exactly one place.
set "PSH=powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0svc_helpers.ps1""

rem --- action check: literal comparison only, %1 is untrusted input ---
if /i "%~1"==""        goto :do_all
if /i "%~1"=="backend"  goto :do_backend
if /i "%~1"=="listener" goto :do_listener
if /i "%~1"=="audio"    goto :do_audio
if /i "%~1"=="tunnel"   goto :do_tunnel
if /i "%~1"=="all"      goto :do_all
call :log "Unknown action ignored (use backend / listener / audio / tunnel / all)"
goto :end

:do_all
call :do_backend
call :do_listener
call :do_tunnel
call :log "=== starter done ==="
goto :end

rem ===================== local backend (2671) =====================
:do_backend
call :log "=== starter begin (backend) ==="
set "BACKEND=%ROOT%\site\backend"
set "SERVER=%BACKEND%\server.py"
if not exist "%SERVER%" (
  call :log "ERROR: server.py not found: %SERVER%"
  goto :eof
)
set "PYTHON_EXE="
if defined FLITFANCY_PYTHON if exist "%FLITFANCY_PYTHON%" set "PYTHON_EXE=%FLITFANCY_PYTHON%"
if defined PYTHON_EXE goto :backend_python_ready
for /f "delims=" %%P in ('py -3 -c "import sys; print(sys.executable)" 2^>nul') do set "PYTHON_EXE=%%P"
if not defined PYTHON_EXE (
  for /f "delims=" %%P in ('python -c "import sys; print(sys.executable)" 2^>nul') do set "PYTHON_EXE=%%P"
)
if not defined PYTHON_EXE (
  call :log "ERROR: Python not found (py -3 or python)"
  goto :eof
)
:backend_python_ready
rem --- the backend is guarded by watch_backend.ps1: one click ensures
rem --- the watchdog runs; a dead backend is revived by it within ~30s.
set "BE_WD_PIDFILE=%LOG_DIR%\backend-watchdog.pid"
set "BE_NEED_START=1"
if exist "%BE_WD_PIDFILE%" (
  for /f "usebackq delims=" %%Q in ("%BE_WD_PIDFILE%") do (
    %PSH% -Action is-alive -ProcessId %%Q
    if not errorlevel 1 (
      %PSH% -Action backend-health
      if not errorlevel 1 set "BE_NEED_START=0"
    )
  )
)
if "%BE_NEED_START%"=="1" (
  if exist "%BE_WD_PIDFILE%" (
    for /f "usebackq delims=" %%Q in ("%BE_WD_PIDFILE%") do %PSH% -Action stop-process -ProcessId %%Q
    del "%BE_WD_PIDFILE%" >nul 2>nul
  )
  %PSH% -Action start-backend-watchdog -Watchdog "%ROOT%\site\scripts\watch_backend.ps1" -Server "%SERVER%" -Exe "%PYTHON_EXE%" -WorkDir "%BACKEND%" -OutLog "%LOG_DIR%\backend-watchdog.out.log" -ErrLog "%LOG_DIR%\backend-watchdog.err.log" -PidFile "%LOG_DIR%\backend.pid"
  call :log "Backend: watchdog started (guards the backend process)"
) else (
  call :log "Backend: watchdog already running and healthy; skipping"
)
%PSH% -Action wait-backend
if errorlevel 1 (
  call :log "ERROR: backend not ready within 20s (see %LOG_DIR%\server.err.log)"
  goto :eof
)
call :log "Backend ready: http://localhost:2671"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start_local_gateway.ps1"
goto :eof

rem ================= sensor listener (7777) =================
:do_listener
call :log "=== starter begin (listener) ==="
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
  call :log "WARNING: listen_wifi.ps1 not found; listener not started (place a copy in site\scripts\vendor\)"
  goto :eof
)
rem --- single instance via pid file: alive + healthy -> skip; else kill + start ---
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
  call :log "Sensor listener: watchdog started"
) else (
  call :log "Sensor listener: watchdog already running and healthy; skipping"
)
goto :eof

rem ================= FIREFLY AUDIO (7865) =================
:do_audio
call :log "=== starter begin (audio) ==="
for %%I in ("%ROOT%\..\NatureCraft\FIREFLY AUDIO\FFV-transfer") do set "AUDIO_DIR=%%~fI"
for %%I in ("%ROOT%\..\Fireflys\Miniconda3\venv\venv_voxcpm\python.exe") do set "AUDIO_PY=%%~fI"
if not exist "%AUDIO_DIR%\app.py" (
  call :log "ERROR: audio app.py not found: %AUDIO_DIR%"
  goto :eof
)
if not exist "%AUDIO_PY%" (
  call :log "ERROR: audio Python not found: %AUDIO_PY%"
  goto :eof
)
%PSH% -Action audio-health -Url "http://127.0.0.1:7865/status"
if not errorlevel 1 (
  call :log "Audio: already running and healthy; skipping"
  goto :eof
)
set "AUDIO_PIDFILE=%LOG_DIR%\audio.pid"
if exist "%AUDIO_PIDFILE%" (
  for /f "usebackq delims=" %%Q in ("%AUDIO_PIDFILE%") do %PSH% -Action stop-process -ProcessId %%Q
  del "%AUDIO_PIDFILE%" >nul 2>nul
)
%PSH% -Action start-audio -Exe "%AUDIO_PY%" -WorkDir "%AUDIO_DIR%" -OutLog "%LOG_DIR%\audio.out.log" -ErrLog "%LOG_DIR%\audio.err.log" -PidFile "%AUDIO_PIDFILE%"
if errorlevel 1 (
  call :log "ERROR: audio service could not be started"
  goto :eof
)
%PSH% -Action wait-audio -Url "http://127.0.0.1:7865/status"
if errorlevel 1 (
  call :log "ERROR: audio service not ready within 60s (see %LOG_DIR%\audio.err.log)"
  goto :eof
)
%PSH% -Action write-port-pid -Port 7865 -PidFile "%AUDIO_PIDFILE%"
call :log "Audio ready: http://127.0.0.1:7865"
goto :eof

rem ================= Cloudflare tunnel =================
:do_tunnel
call :log "=== starter begin (tunnel) ==="
set "CLOUDFLARED=%ROOT%\tools\cloudflared\cloudflared.exe"
set "CF_CONFIG=%USERPROFILE%\.cloudflared\config.yml"
if not exist "%CLOUDFLARED%" (
  call :log "WARNING: cloudflared not found; tunnel cannot start"
  goto :eof
)
if not exist "%CF_CONFIG%" (
  call :log "WARNING: tunnel config not found: %CF_CONFIG% (tunnel not started)"
  goto :eof
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start_tunnel.ps1"
if errorlevel 1 (
  call :log "ERROR: tunnel watchdog did not start (see tunnel-watchdog.err.log)"
) else (
  call :log "Tunnel: automatic recovery enabled"
)
goto :eof

:log
echo [%date% %time%] %*
echo [%date% %time%] %* >> "%STARTER_LOG%"
goto :eof

:end
exit /b 0
