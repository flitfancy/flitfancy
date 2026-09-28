import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requestedPython = (process.env.FLITFANCY_PYTHON || "").trim();
const candidates = requestedPython
  ? [{ command: requestedPython, args: [] }]
  : process.platform === "win32"
    ? [
        { command: "py", args: ["-3.14"] },
        { command: "py", args: ["-3"] },
        { command: "python", args: [] }
      ]
    : [
        { command: "python3.14", args: [] },
        { command: "python3", args: [] },
        { command: "python", args: [] }
      ];

const python = candidates.find(({ command, args }) => {
  const probe = spawnSync(command, [...args, "--version"], {
    cwd: root,
    stdio: "ignore"
  });
  return probe.status === 0;
});

if (!python) {
  throw new Error(
    "未找到可用的 Python 3；可安装 Python，或用 FLITFANCY_PYTHON 指定解释器路径"
  );
}

console.log(`backend tests: ${python.command} ${python.args.join(" ")}`.trim());
if (process.platform === "win32") {
  for (const test of ["backend-window.test.ps1", "service-window.test.ps1", "service-process-wait.test.ps1", "service-controller-recovery.test.ps1", "tunnel-starter.test.ps1", "tunnel-watchdog.test.ps1"]) {
    const result = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
      path.join(root, "tests", test)], { cwd: root, stdio: "inherit" });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}
for (const relativePath of ["backend/auth_policy_test.py", "backend/refresh_test.py", "backend/refresh_http_test.py", "backend/activity_test.py", "backend/activity_http_test.py", "backend/connection_test.py", "backend/module_test.py", "backend/launcher_test.py", "backend/bridge_test.py", "backend/bridge_batch_test.py", "backend/smoke_test.py"]) {
  const result = spawnSync(
    python.command,
    [...python.args, path.join(root, relativePath)],
    { cwd: root, stdio: "inherit" }
  );
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
