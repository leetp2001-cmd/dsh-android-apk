"use strict";
/**
 * 边缘认证（层 2）：走 Cloudflare 命名隧道时免输口令。
 *
 * ## 背景
 * 命名隧道由 Cloudflare 边缘的 Request Header Transform Rule 给每个请求注入
 * 一个自定义头（值 = 本机 .edge-secret）。服务端校验这个头，即可认定
 * 「请求来自我配置的那条隧道」，从而跳过口令输入。
 *
 * ## 为什么用 Transform Rule 而不是 cloudflared 配置
 * cloudflared 本身无法为转发请求注入自定义头（ingress 只支持
 * hostname / service / originRequest 等）。而 Cloudflare 免费版的 Transform
 * Rules 支持「设置静态请求头」，且语义是**覆盖客户端自带的同名头** ——
 * 这正好堵住伪造。
 *
 * ## 安全要点（每条都对应一个真实攻击面，改之前先想清楚）
 *  1. 边缘覆盖：客户端自带的 X-DSH-Edge 会被 CF 改写成本机密钥，伪造无效。
 *  2. 单值校验：本模块拒绝头出现多次（node 会解析成数组），双保险。
 *  3. 同机校验：请求必须来自回环地址 —— 即 cloudflared 与本服务同机。
 *     即使密钥泄漏，也无法从外部直连源站（源站根本不监听公网）。
 *  4. 常量时间比较，避免时序侧信道；密钥文件 0600。
 *  5. 未配置 .edge-secret 时整条路径自动关闭，退回纯口令模式（安全降级）。
 */

const fs = require("node:fs");

const { EDGE_SECRET_FILE, EDGE_SECRET_FROM_ENV } = require("../config");
const { safeEqual } = require("../lib/encoding");

const EDGE_HEADER = "x-dsh-edge";

function loadSecret() {
  if (EDGE_SECRET_FROM_ENV) return EDGE_SECRET_FROM_ENV;
  try {
    return fs.readFileSync(EDGE_SECRET_FILE, "utf8").trim();
  } catch {
    return "";
  }
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

class EdgeAuth {
  constructor(log = console.log) {
    this.secret = loadSecret();
    this.enabled = !!this.secret;
    if (this.enabled) {
      log("[dsh-app] 边缘认证已启用（隧道进来的请求免口令）");
    }
  }

  /** 判定「这把请求是否走的是我自己那条隧道」 */
  matches(req) {
    if (!this.enabled) return false;

    const raw = req.headers[EDGE_HEADER];
    // 关键：不接受数组。node 把头重复出现解析成数组，说明客户端自己也塞了这个头
    // （cloudflared 注入后会形成 2 个值），必须拒绝而不是取其中一个。
    if (typeof raw !== "string") return false;
    if (!safeEqual(raw, this.secret)) return false;

    // 再要求请求确实来自本机回环（cloudflared 与本服务同机部署）。
    // 双保险：即使有人拿到密钥，也无法从外部直接打源站（源站本来也不监听公网）。
    const remote = req.socket?.remoteAddress || "";
    return LOOPBACK.has(remote);
  }
}

module.exports = { EdgeAuth, EDGE_HEADER };
