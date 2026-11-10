"use strict";
/**
 * HTTP 响应工具。
 *
 * 统一出口的价值：gzip 策略、JSON 形状、错误码只在一个地方定义，
 * 路由里只关心"回什么"。
 */

const zlib = require("node:zlib");

/** >=1KB 的文本响应走 gzip（公网隧道带宽只有 ~40KB/s，压缩能省一半以上） */
const GZIP_MIN_BYTES = 1024;

/** 常见的 JSON 响应头 */
const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };

/**
 * 建一个绑定到具体 res 的 send 函数。
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 */
function makeSender(req, res) {
  const acceptsGzip = /\bgzip\b/.test(req.headers["accept-encoding"] || "");

  return function send(status, headers, body) {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body));

    // 已经自己带 Content-Length 的（例如 Range 分段）不要插手
    if (headers["Content-Length"] !== undefined) {
      res.writeHead(status, headers);
      res.end(buf);
      return;
    }

    if (acceptsGzip && buf.length >= GZIP_MIN_BYTES) {
      const gz = zlib.gzipSync(buf);
      res.writeHead(status, {
        ...headers,
        "Content-Encoding": "gzip",
        "Content-Length": gz.length,
        Vary: "Accept-Encoding",
      });
      res.end(gz);
      return;
    }

    res.writeHead(status, { ...headers, "Content-Length": buf.length });
    res.end(buf);
  };
}

/** 回一个 JSON 成功/失败响应 */
function sendJson(send, status, payload) {
  send(status, JSON_HEADERS, JSON.stringify(payload));
}

/** 统一的错误形状：{ok:false, error:{code, message}} */
function sendError(send, status, code, message) {
  sendJson(send, status, { ok: false, error: { code, message } });
}

/** 读取完整请求体（默认上限 32MB —— 发图时 base64 会很大） */
const MAX_BODY_BYTES = 32 * 1024 * 1024;

async function readBody(req, limit = MAX_BODY_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Error("请求体过大");
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** 读 JSON 体；空体返回 {}，解析失败抛错 */
async function readJson(req, limit) {
  const text = await readBody(req, limit);
  if (!text) return {};
  return JSON.parse(text);
}

module.exports = { makeSender, sendJson, sendError, readBody, readJson, JSON_HEADERS };
