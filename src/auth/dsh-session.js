"use strict";
/**
 * dsh 会话凭据（层 3）：向 dsh 证明「我是一个合法的浏览器」。
 *
 * ## 原理
 * dsh web 用 HMAC 签名的 cookie 做鉴权。签名密钥放在 ~/.dsh/.credentials.yaml。
 * 本服务读出该密钥，自己在本地铸一张 cookie，之后调 dsh 的 RPC 都带上它。
 *
 * 这等价于「用 dsh 自己的规则给 dsh 签了一张票」，不改 dsh 任何状态、
 * 也不劫持它的登录流程 —— 只是复用了它对浏览器开放的那套协议。
 *
 * ## 边界
 * 只读密钥 + 调公开 RPC。写操作全部经由用户在前端点按，本质和用浏览器打开
 * dsh 完全一致。
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const { DSH_HOME, DSH_AUTHORITY } = require("../config");
const { b64url, b64urlDecode } = require("../lib/encoding");

const CRED_FILE = path.join(DSH_HOME, ".credentials.yaml");
const COOKIE_TTL_MS = 30 * 86400000;

/** 从 .credentials.yaml 里抠出 secret（该文件是简单 YAML，一个正则足够） */
function readSecret() {
  const raw = fs.readFileSync(CRED_FILE, "utf8");
  const m = raw.match(/secret:\s*(\S+)/);
  if (!m) throw new Error(`${CRED_FILE} 中未找到 secret`);
  return m[1];
}

/**
 * 铸造 dsh browser-session cookie。
 * payload 里带 authority，dsh 会校验它和自己监听的地址一致。
 */
function mint(secretB64) {
  const secretBytes = b64urlDecode(secretB64);
  const now = Date.now();
  const payload = {
    version: 1,
    authority: DSH_AUTHORITY,
    issuedAt: now,
    expiresAt: now + COOKIE_TTL_MS,
  };
  const body = b64url(Buffer.from(JSON.stringify(payload)));
  const sig = b64url(crypto.createHmac("sha256", secretBytes).update(body).digest());
  const name = "dsh-auth-" + b64url(crypto.createHash("sha256").update(DSH_AUTHORITY).digest());
  return `${name}=v1.${body}.${sig}`;
}

/**
 * 会话凭据持有者。
 *
 * 首次调用才读密钥（启动时不读）—— 这样即使用户还没装好 dsh，
 * 本服务也能起来并给出可读的报错，而不是启动即崩。
 * 铸好的 cookie 缓存起来，密钥文件变了才重铸。
 */
class DshSession {
  constructor(log = console.log) {
    this.log = log;
    this._cookie = null;
    this._secretB64 = null;
  }

  /** 当前可用的 cookie 字符串；失败时抛错，由调用方决定怎么兜 */
  cookie() {
    const secretB64 = readSecret();
    if (this._cookie && secretB64 === this._secretB64) return this._cookie;
    this._cookie = mint(secretB64);
    this._secretB64 = secretB64;
    return this._cookie;
  }

  /** 同上，但失败返回空串（给「宁可少一个头也别抛」的场景） */
  cookieSafe() {
    try {
      return this.cookie();
    } catch (e) {
      this.log(`[dsh-app] 取 dsh 凭据失败: ${e.message}`);
      return "";
    }
  }

  /** 密钥或 authority 变化后强制重铸（例如用户重启了 dsh） */
  invalidate() {
    this._cookie = null;
    this._secretB64 = null;
  }
}

module.exports = { DshSession, CRED_FILE };
