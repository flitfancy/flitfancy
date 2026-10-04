"""Create a local signing identity; password stays in the ignored backend configuration."""
import json
import os
from pathlib import Path
import secrets
import subprocess

site = Path(__file__).resolve().parents[1]
config = site / "backend/ai_local.json"
data = json.loads(config.read_text(encoding="utf-8")) if config.exists() else {}
if "android_signing" not in data:
    tools = json.loads((site.parent / "tools/android-build/toolchain.json").read_text())
    keystore = site / "backend/data/android-signing.p12"
    if keystore.exists():
        raise RuntimeError("Existing private signing key needs its matching configuration")
    keystore.parent.mkdir(parents=True, exist_ok=True)
    password = secrets.token_urlsafe(32)
    result = subprocess.run([str(Path(tools["java_home"]) / "bin/keytool.exe"), "-genkeypair", "-keystore", str(keystore),
                             "-storetype", "PKCS12", "-storepass:env", "FLIT_ANDROID_KEY_PASSWORD",
                             "-keypass:env", "FLIT_ANDROID_KEY_PASSWORD", "-alias", "flitfancy",
                             "-keyalg", "RSA", "-keysize", "3072", "-validity", "10000", "-dname", "CN=FlitFancy Android"],
                            env={**os.environ, "FLIT_ANDROID_KEY_PASSWORD": password}, capture_output=True)
    if result.returncode:
        raise RuntimeError("Signing key initialization failed")
    data = json.loads(config.read_text(encoding="utf-8")) if config.exists() else {}
    data["android_signing"] = {"keystore": str(keystore), "store_password": password}
    pending = config.with_name(".android-signing-config.tmp")
    pending.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    pending.replace(config)
print("Local signing identity ready; private credentials not displayed")
