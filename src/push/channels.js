"use strict";
/**
 * 推送渠道投递：把一条 {title, body, url} 送到 ntfy / Bark / Server 酱。
 *
 * 每个渠道的坑都写在对应分支里 —— 这些细节是实测出来的，不是照文档抄的。
 */

/** 单个渠道的 HTTP 超时。推送是后台任务，不能让它吊住进程 */
const TIMEOUT_MS = 12000;

/** 统一去掉结尾斜杠，避免拼出 https://host//path */
const base = (url, fallback) => (url || fallback).replace(/\/+$/, "");

async function deliverNtfy(ch, msg, url) {
  const server = base(ch.server, "https://ntfy.sh");
  // 为什么不用 header 传 title：HTTP header 只允许 ASCII，中文/emoji 必须先
  // URL 编码，但 ntfy 服务端**不会解码**它 —— 手机通知栏里直接显示
  // "%F0%9F%94%94 dsh ..." 这种乱码（实测复现）。
  // 改用 JSON 发布格式（POST 到服务根路径 + topic 放 body），UTF-8 原样透传。
  const headers = { "Content-Type": "application/json" };
  if (ch.token) headers.Authorization = "Bearer " + ch.token;

  const payload = {
    topic: ch.topic,
    title: msg.title,
    message: msg.body,
    priority: 3,
    tags: ["robot"],
  };
  if (url) payload.click = url;

  return fetch(server, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

async function deliverBark(ch, msg, url) {
  const server = base(ch.server, "https://api.day.app");
  return fetch(`${server}/${encodeURIComponent(ch.key)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: msg.title,
      body: msg.body,
      group: "dsh",
      ...(url ? { url } : {}),
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

async function deliverServerChan(ch, msg, url) {
  return fetch(`https://sctapi.ftqq.com/${encodeURIComponent(ch.key)}.send`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      title: msg.title,
      desp: msg.body + (url ? `\n\n[打开会话](${url})` : ""),
    }).toString(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

const HANDLERS = {
  ntfy: deliverNtfy,
  bark: deliverBark,
  serverchan: deliverServerChan,
};

/**
 * 投递一条消息到一个渠道。失败抛错（调用方负责计数与日志）。
 * @returns {Promise<void>}
 */
async function deliver(ch, msg, url) {
  const handler = HANDLERS[ch.type];
  if (!handler) throw new Error("未知渠道类型 " + ch.type);

  const res = await handler(ch, msg, url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

module.exports = { deliver, HANDLERS };
