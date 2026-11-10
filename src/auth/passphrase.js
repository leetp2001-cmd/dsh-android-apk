"use strict";
/**
 * 访问口令（层 1）：手机/局域网访问的第一道门。
 *
 * 口令来源优先级：环境变量 DSH_APP_PASS > .passphrase 文件 > 自动生成并写入文件。
 * 校验通过后签发一个长期 cookie，之后所有请求带 cookie 即可。
 *
 * 口令本身不直接进 cookie：cookie 里存的是 sha256(口令)，即使有人看到 cookie
 * 也无法反推出口令。cookie 带 HttpOnly + SameSite=Strict，JS 拿不到。
 */

const crypto = require("node:crypto");
const fs = require("node:fs");

const { PASSPHRASE_FILE, PASSPHRASE_FROM_ENV } = require("../config");
const { safeEqual } = require("../lib/encoding");

const COOKIE_NAME = "dshapp-token";
const COOKIE_MAX_AGE = 2592000; // 30 天

/** 读口令，没有就生成一个 10 位十六进制并落盘（0600） */
function loadPassphrase(log = console.log) {
  if (PASSPHRASE_FROM_ENV) return PASSPHRASE_FROM_ENV;

  try {
    const fromFile = fs.readFileSync(PASSPHRASE_FILE, "utf8").trim();
    if (fromFile) return fromFile;
  } catch {
    /* 文件不存在：继续往下走生成 */
  }

  const generated = crypto.randomBytes(5).toString("hex");
  try {
    fs.writeFileSync(PASSPHRASE_FILE, generated + "\n", { mode: 0o600 });
    log(`[dsh-app] 已生成访问口令并写入 ${PASSPHRASE_FILE}`);
  } catch (e) {
    log(`[dsh-app] 口令落盘失败（本次仍可用，重启会变）：${e.message}`);
  }
  return generated;
}

class PassphraseAuth {
  constructor(log = console.log) {
    this.log = log;
    this.passphrase = loadPassphrase(log);
    this.token = crypto.createHash("sha256").update(`dshapp:${this.passphrase}`).digest("hex");
    this.cookieName = COOKIE_NAME;
    this.cookieMaxAge = COOKIE_MAX_AGE;
  }

  /** 口令明文比对（登录接口用） */
  verify(input) {
    if (!input) return false;
    return safeEqual(input, this.passphrase);
  }

  /** 请求是否带着有效 cookie */
  hasCookie(req) {
    const raw = req.headers.cookie || "";
    const hit = raw
      .split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith(this.cookieName + "="));
    if (!hit) return false;
    return safeEqual(hit.slice(this.cookieName.length + 1), this.token);
  }

  /** 登录成功后要下发的 Set-Cookie 值 */
  setCookieHeader() {
    return (
      `${this.cookieName}=${this.token}; Max-Age=${this.cookieMaxAge}; ` +
      `Path=/; HttpOnly; SameSite=Strict`
    );
  }
}

module.exports = { PassphraseAuth };
