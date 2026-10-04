"""Install a portable, checksum-verified Android build toolchain outside the source tree."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import urllib.request
import urllib.parse
import zipfile

ROOT = Path(__file__).resolve().parents[2] / "tools" / "android-build"
ROOT.mkdir(parents=True, exist_ok=True)
settings_file = ROOT / "toolchain.json"
if settings_file.exists():
    cached = json.loads(settings_file.read_text())
    if all(Path(path).exists() for path in (Path(cached["java_home"]) / "bin/java.exe", cached["gradle"],
                                            Path(cached["sdk"]) / "platforms/android-36/android.jar",
                                            Path(cached["sdk"]) / "build-tools/36.0.0/apksigner.bat")):
        print(json.dumps(cached))
        raise SystemExit(0)


def fetch(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"}), timeout=90) as response:
        return response.read()


def archive(url, checksum, name):
    target = ROOT / name
    if not target.exists() or hashlib.sha256(target.read_bytes()).hexdigest() != checksum:
        print("Downloading " + name, flush=True)
        with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"}), timeout=90) as incoming, target.open("wb") as outgoing:
            while chunk := incoming.read(1024 * 1024):
                outgoing.write(chunk)
    if hashlib.sha256(target.read_bytes()).hexdigest() != checksum:
        raise RuntimeError("Toolchain archive checksum mismatch: " + name)
    return target


def extract(source, destination):
    destination.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(source) as bundle:
        for entry in bundle.infolist():
            target = (destination / entry.filename).resolve()
            if destination.resolve() not in target.parents and target != destination.resolve():
                raise ValueError("Archive path escaped toolchain directory")
        bundle.extractall(destination)


assets = json.loads(fetch("https://api.adoptium.net/v3/assets/latest/21/hotspot?architecture=x64&image_type=jdk&os=windows"))
package = assets[0]["binary"]["package"]
jdk_zip = archive(package["link"], package["checksum"], "jdk21.zip")
jdk_parent = ROOT / "jdk"
if not jdk_parent.exists():
    extract(jdk_zip, jdk_parent)
jdk = next(path for path in jdk_parent.iterdir() if (path / "bin/java.exe").exists())
gradle_hash = fetch("https://services.gradle.org/distributions/gradle-8.13-bin.zip.sha256").decode().strip()
gradle_zip = archive("https://services.gradle.org/distributions/gradle-8.13-bin.zip", gradle_hash, "gradle-8.13-bin.zip")
if not (ROOT / "gradle-8.13/bin/gradle.bat").exists():
    extract(gradle_zip, ROOT)
sdk_zip = archive("https://dl.google.com/android/repository/commandlinetools-win-15859902_latest.zip",
                  "90ae805d20434428bffcb699c290860f19bb5f66a67e6b330067e3de801fb04a", "android-cli.zip")
sdk = ROOT / "sdk"
if not (sdk / "cmdline-tools/latest/bin/sdkmanager.bat").exists():
    stage = ROOT / "android-cli"
    extract(sdk_zip, stage)
    (sdk / "cmdline-tools").mkdir(parents=True, exist_ok=True)
    (stage / "cmdline-tools").rename(sdk / "cmdline-tools/latest")
settings = {"java_home": str(jdk), "sdk": str(sdk), "gradle": str(ROOT / "gradle-8.13/bin/gradle.bat")}
(ROOT / "toolchain.json").write_text(json.dumps(settings, indent=2) + "\n")
manager = sdk / "cmdline-tools/latest/bin/sdkmanager.bat"
environment = {**os.environ, "JAVA_HOME": str(jdk)}
proxy_args = []
proxy = urllib.parse.urlparse(urllib.request.getproxies().get("https", ""))
if proxy.hostname and proxy.port and not proxy.username:
    proxy_args = ["--proxy=http", "--proxy_host=" + proxy.hostname, "--proxy_port=" + str(proxy.port)]
subprocess.run([str(manager), "--sdk_root=" + str(sdk), *proxy_args, "--licenses"],
               input="y\n" * 100, text=True, env=environment, check=True)
subprocess.run([str(manager), "--sdk_root=" + str(sdk), *proxy_args,
                "platform-tools", "platforms;android-36", "build-tools;36.0.0"], env=environment, check=True)
print(json.dumps(settings), flush=True)
