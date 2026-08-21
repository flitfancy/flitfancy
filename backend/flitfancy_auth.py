"""管理员密码、失败锁定和短期会话令牌。"""

import hashlib
import secrets
import threading
import time


ADMIN_TOKEN_TTL = 12 * 3600
LOGIN_MAX_FAILS = 5
LOGIN_LOCK_SECONDS = 10 * 60
ADMIN_FAILS_MAX_ENTRIES = 4096
PASSWORD_SCHEME = "pbkdf2_sha256"
PASSWORD_ITERATIONS = 600_000
MIN_NEW_PASSWORD_LENGTH = 14
_DUMMY_PASSWORD_SALT = bytes.fromhex("7d0fe8b9c04649c4ae85eb0f826fa5a1")
_DUMMY_PASSWORD_HASH = "0" * 64


class AdminAuth:
    """封装认证内存状态；本地账号记录仍由调用方配置存储负责。"""

    def __init__(self, read_config, save_config, config_lock=None):
        self.read_config = read_config
        self.save_config = save_config
        self.config_lock = config_lock or threading.RLock()
        self.tokens = {}
        self.failures = {}
        self.lock = threading.Lock()

    @staticmethod
    def password_record(password):
        salt = secrets.token_bytes(16)
        digest = hashlib.pbkdf2_hmac(
            "sha256", (password or "").encode("utf-8"), salt, PASSWORD_ITERATIONS
        )
        return {
            "salt": salt.hex(),
            "password_hash": digest.hex(),
            "password_scheme": PASSWORD_SCHEME,
            "password_iterations": PASSWORD_ITERATIONS,
        }

    @staticmethod
    def dummy_password_check(password):
        actual = hashlib.pbkdf2_hmac(
            "sha256", password.encode("utf-8"),
            _DUMMY_PASSWORD_SALT, PASSWORD_ITERATIONS,
        ).hex()
        return secrets.compare_digest(actual, _DUMMY_PASSWORD_HASH)

    def set_password(self, username, password, create=False):
        """更新账号密码；create=True 时允许创建账号。"""
        record = self.password_record(password)
        with self.config_lock:
            cfg = self.read_config()
            accounts = cfg.get("admin_accounts") or []
            for account in accounts:
                if (account.get("username") or "") == (username or ""):
                    account.update(record)
                    self.save_config({"admin_accounts": accounts})
                    return True
            if create:
                record["username"] = username
                accounts.append(record)
                self.save_config({"admin_accounts": accounts})
                return True
        return False

    def verify_password(self, username, password):
        """校验密码；旧 SHA-256 记录成功登录后自动升级为 PBKDF2。"""
        if not isinstance(password, str) or len(password) > 1024:
            return False
        cfg = self.read_config()
        account = next((
            item for item in (cfg.get("admin_accounts") or [])
            if (item.get("username") or "") == (username or "")
        ), None)
        if not account:
            self.dummy_password_check(password)
            return False

        salt_text = account.get("salt") or ""
        expected = account.get("password_hash") or ""
        if not salt_text or not expected:
            self.dummy_password_check(password)
            return False
        scheme = account.get("password_scheme") or "sha256"
        if scheme == PASSWORD_SCHEME:
            try:
                salt = bytes.fromhex(salt_text)
                iterations = int(account.get("password_iterations") or 0)
            except (TypeError, ValueError):
                self.dummy_password_check(password)
                return False
            if len(salt) < 16 or not (100_000 <= iterations <= 10_000_000):
                self.dummy_password_check(password)
                return False
            actual = hashlib.pbkdf2_hmac(
                "sha256", password.encode("utf-8"), salt, iterations
            ).hex()
            return secrets.compare_digest(actual, expected)
        if scheme == "sha256":
            self.dummy_password_check(password)
            actual = hashlib.sha256(
                (salt_text + password).encode("utf-8")
            ).hexdigest()
            valid = secrets.compare_digest(actual, expected)
            if valid:
                self.set_password(username, password)
            return valid
        self.dummy_password_check(password)
        return False

    def _prune_failures(self):
        """仅在 self.lock 内调用，将攻击者制造的失败记录数量封顶。"""
        if len(self.failures) <= ADMIN_FAILS_MAX_ENTRIES:
            return
        now = time.time()
        for key in [
                key for key, value in self.failures.items()
                if value[1] and value[1] <= now]:
            self.failures.pop(key, None)
        if len(self.failures) > ADMIN_FAILS_MAX_ENTRIES:
            half = len(self.failures) // 2
            for key in list(self.failures.keys())[:half]:
                self.failures.pop(key, None)

    def login(self, ip, username, password):
        """成功时返回令牌；失败时按 IP 计数并在达到上限后锁定。"""
        now = time.time()
        with self.lock:
            record = self.failures.get(ip) or [0, 0]
            if record[1] > now:
                remaining = int(record[1] - now)
                minutes = min(
                    int(remaining // 60) + 1, LOGIN_LOCK_SECONDS // 60,
                )
                return False, "尝试次数过多，请 %d 分钟后再试" % minutes
        if not self.verify_password(username, password):
            with self.lock:
                record = self.failures.get(ip) or [0, 0]
                record[0] += 1
                if record[0] >= LOGIN_MAX_FAILS:
                    self.failures[ip] = [0, LOGIN_LOCK_SECONDS + time.time()]
                    self._prune_failures()
                    return False, "密码错误次数过多，已锁定 10 分钟"
                self.failures[ip] = record
                self._prune_failures()
                return False, "用户名或密码错误（还可尝试 %d 次）" % (
                    LOGIN_MAX_FAILS - record[0]
                )
        with self.lock:
            self.failures[ip] = [0, 0]
            token = secrets.token_hex(24)
            self.tokens[token] = time.time() + ADMIN_TOKEN_TTL
            return True, token

    def token_valid(self, token):
        now = time.time()
        with self.lock:
            expires = self.tokens.get(token)
            if not expires:
                return False
            if expires < now:
                self.tokens.pop(token, None)
                return False
            return True

    def logout(self, token):
        with self.lock:
            self.tokens.pop(token, None)
