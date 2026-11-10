"use strict";
/**
 * 编解码与比较的小工具。
 * 单独成文件是因为「token / cookie 签名 / 边缘校验」三处都要用，
 * 放在任何一处都会让另外两处反向依赖。
 */

const crypto = require("node:crypto");

/** base64url 编码（去掉填充，URL 与 cookie 里都安全） */
function b64url(buf) {
  return Buffer.from(buf)
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

/** base64url 解码 */
function b64urlDecode(s) {
  return Buffer.from(String(s).replaceAll("-", "+").replaceAll("_", "/"), "base64");
}

/**
 * 常量时间字符串比较，避免时序侧信道。
 * 长度不同直接 false —— timingSafeEqual 对不等长会抛异常。
 */
function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

module.exports = { b64url, b64urlDecode, safeEqual };
