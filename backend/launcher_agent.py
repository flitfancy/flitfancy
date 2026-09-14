"""Logged-in desktop worker. Reads a user-private queue, exposes no network listener."""
import argparse
import ctypes
import hashlib
import os
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from flitfancy_launcher import LauncherService, normalize_target


def launch_shortcut(target):
    from ctypes import wintypes
    class SHELLEXECUTEINFO(ctypes.Structure):
        _fields_ = [("cbSize", wintypes.DWORD), ("fMask", wintypes.ULONG), ("hwnd", wintypes.HWND),
                    ("lpVerb", wintypes.LPCWSTR), ("lpFile", wintypes.LPCWSTR), ("lpParameters", wintypes.LPCWSTR),
                    ("lpDirectory", wintypes.LPCWSTR), ("nShow", ctypes.c_int), ("hInstApp", wintypes.HINSTANCE),
                    ("lpIDList", ctypes.c_void_p), ("lpClass", wintypes.LPCWSTR), ("hkeyClass", wintypes.HKEY),
                    ("dwHotKey", wintypes.DWORD), ("hIcon", wintypes.HANDLE), ("hProcess", wintypes.HANDLE)]
    info = SHELLEXECUTEINFO()
    info.cbSize = ctypes.sizeof(info)
    info.fMask = 0x40 | 0x100 | 0x400
    info.lpVerb = "open"
    info.lpFile = target["path"]
    info.lpParameters = subprocess.list2cmdline(target["args"])
    info.lpDirectory = target["working_dir"] or None
    info.nShow = 0 if target["hidden"] else 1
    shell = ctypes.WinDLL("shell32", use_last_error=True)
    shell.ShellExecuteExW.argtypes = [ctypes.POINTER(SHELLEXECUTEINFO)]
    shell.ShellExecuteExW.restype = wintypes.BOOL
    if not shell.ShellExecuteExW(ctypes.byref(info)):
        raise ctypes.WinError(ctypes.get_last_error())
    pid = None
    if info.hProcess:
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.GetProcessId.argtypes = [wintypes.HANDLE]
        kernel.GetProcessId.restype = wintypes.DWORD
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        pid = kernel.GetProcessId(info.hProcess)
        kernel.CloseHandle(info.hProcess)
    return {"message": "已发送启动请求", "pid": pid}


def launch(target):
    target = normalize_target(target)
    extension = Path(target["path"]).suffix.lower()
    if extension == ".lnk":
        return launch_shortcut(target)
    command = [target["path"], *target["args"]]
    system = Path(os.environ.get("SystemRoot", "C:/Windows")) / "System32"
    if extension == ".py":
        command = [target["interpreter"] or sys.executable, target["path"], *target["args"]]
    elif extension == ".ps1":
        command = [str(system/"WindowsPowerShell/v1.0/powershell.exe"), "-NoProfile", "-NonInteractive",
                   "-ExecutionPolicy", "Bypass", "-File", target["path"], *target["args"]]
    elif extension in {".bat", ".cmd"}:
        # CMD only for batch files; normalization rejects every shell metacharacter.
        arguments = "".join(' "' + arg + '"' for arg in target["args"])
        command = '"%s" /d /s /c ""%s"%s"' % (system/"cmd.exe", target["path"], arguments)
    options = {"cwd": target["working_dir"] or str(Path(target["path"]).parent),
               "shell": False}
    if target["hidden"]:
        options.update(stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if os.name == "nt":
        options["creationflags"] = subprocess.CREATE_NO_WINDOW if target["hidden"] else subprocess.CREATE_NEW_CONSOLE
    process = subprocess.Popen(command, **options)
    try:
        code = process.wait(timeout=.35)
        if code:
            raise RuntimeError("启动后退出，退出码 %d；请检查路径和参数" % code)
    except subprocess.TimeoutExpired:
        pass
    return {"message": "已启动", "pid": process.pid}


def pick_file():
    system = Path(os.environ["SystemRoot"]) / "System32/WindowsPowerShell/v1.0/powershell.exe"
    script = """
        [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
        Add-Type -AssemblyName System.Windows.Forms
        $owner = New-Object Windows.Forms.Form
        $owner.TopMost = $true
        $picker = New-Object Windows.Forms.OpenFileDialog
        $picker.Title = 'FlitFancy - 选择本机启动文件'
        $picker.Filter = '应用与脚本|*.exe;*.lnk;*.bat;*.cmd;*.ps1;*.py'
        $picker.DereferenceLinks = $false
        try { if ($picker.ShowDialog($owner) -eq 'OK') { [Console]::Write($picker.FileName) } }
        finally { $picker.Dispose(); $owner.Dispose() }
    """
    result = subprocess.run([str(system), "-NoProfile", "-STA", "-Command", script],
                            capture_output=True, encoding="utf-8", timeout=240,
                            creationflags=subprocess.CREATE_NO_WINDOW, check=True)
    return {"path": result.stdout.strip(), "message": "已选择" if result.stdout.strip() else "已取消选择"}


def execute(job):
    try:
        result = pick_file() if job["kind"] == "pick" else launch(job["payload"])
        return "done", result
    except Exception as error:
        return "failed", {"message": str(error)[:300]}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--state-dir", default=str(Path(__file__).parent / "data/launcher"))
    args = parser.parse_args()
    if os.name != "nt":
        raise RuntimeError("桌面助手仅支持 Windows")
    from ctypes import wintypes
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    session = wintypes.DWORD()
    kernel.ProcessIdToSessionId(os.getpid(), ctypes.byref(session))
    if session.value == 0:
        raise RuntimeError("桌面助手必须在已登录的桌面会话中运行")
    kernel.CreateMutexW.argtypes = [ctypes.c_void_p, wintypes.BOOL, wintypes.LPCWSTR]
    kernel.CreateMutexW.restype = wintypes.HANDLE
    key = hashlib.sha256(str(Path(args.state_dir).resolve()).lower().encode()).hexdigest()[:20]
    handle = kernel.CreateMutexW(None, False, "Global\\FlitFancyLauncher-" + key)
    if not handle or ctypes.get_last_error() == 183:
        return
    service = LauncherService(args.state_dir)
    with ThreadPoolExecutor(max_workers=1) as executor:
        job = future = None
        while True:
            try:
                if future and future.done():
                    state, result = future.result()
                    service.finish(job["id"], state, result)
                    future = job = None
                picked = service.claim(accept=future is None)
                if picked:
                    job = picked
                    future = executor.submit(execute, job)
            except Exception:
                time.sleep(2)
            time.sleep(1.5)


if __name__ == "__main__":
    main()
