"use strict";
/**
 * WS 双向管道：手机 ⇄ 本服务 ⇄ dsh 的 /api/remote.mux。
 *
 * ## 为什么必须代理而不是让手机直连 dsh
 * dsh 只监听 127.0.0.1。手机要走隧道，就必须有人在中间把 WS 桥过去。
 *
 * ## 这一层额外做的事
 *   · 下行快照瘦身（trim-follow.js）—— 1.7MB → 460KB
 *   · permessage-deflate 两个方向都开
 *   · 上游未就绪时缓冲前 256 帧（手机可能比上游先连上）
 *
 * ## 帧协议（与前端 streamOpen 约定）
 *   上行 {type:"open", streamId, endpoint, payload}
 *   上行 {type:"cancel", streamId}
 *   下行 {type:"item"|"end"|"error", streamId, value|error}
 *   下行 {type:"upstream-open"}  —— 管道就绪，前端据此重放 pendingOpen
 *   下行 {type:"app-error", message} —— 本地错误，不来自 dsh
 */

const { WebSocket, WebSocketServer } = require("../lib/ws");
const { maybeTrimFrame } = require("../dsh/trim-follow");
const { DSH_AUTHORITY } = require("../config");

/** permessage-deflate：快照压缩率约 40%（1.7MB → 460KB），live 小帧因阈值不压缩 */
const DEFLATE = {
  perMessageDeflate: {
    threshold: 1024,
    clientNoContextTakeover: true,
    serverNoContextTakeover: true,
  },
  maxPayload: 64 * 1024 * 1024,
};

const MAX_BACKLOG = 256;

/** 建一条到 dsh 的 WS（本机回环，但仍开压缩：1.7MB 快照同样有解析/拷贝成本） */
function connectUpstream(cookie) {
  return new WebSocket(`ws://${DSH_AUTHORITY}/api/remote.mux`, {
    headers: { Cookie: cookie },
    ...DEFLATE,
  });
}

/**
 * 装一条客户端管道。
 * @param {import("ws").WebSocket} client 已 upgrade 的客户端连接
 * @param {object} deps { getCookie, log }
 */
function handleConnection(client, { getCookie, log = console.log }) {
  let upstream;
  let closed = false;
  const backlog = [];

  const cleanup = () => {
    if (closed) return;
    closed = true;
    try {
      upstream?.close();
    } catch {
      /* 已经关了，无所谓 */
    }
  };

  const openUpstream = () => {
    let cookie = "";
    try {
      cookie = getCookie();
    } catch (e) {
      log(`[dsh-app] WS 上游鉴权失败: ${e.message}`);
      try {
        client.close(1011, "auth failed");
      } catch {}
      return;
    }

    upstream = connectUpstream(cookie);

    upstream.on("open", () => {
      try {
        client.send(JSON.stringify({ type: "upstream-open" }));
      } catch {
        return;
      }
      // 上游就绪前缓存的帧按序补发
      while (backlog.length && upstream.readyState === WebSocket.OPEN) {
        upstream.send(backlog.shift());
      }
    });

    upstream.on("message", (data, isBinary) => {
      if (client.readyState !== WebSocket.OPEN) return;
      if (isBinary) {
        client.send(data, { binary: true });
        return;
      }
      // 只在"前端开了压缩"时才值得先解压再瘦身 —— 解压是额外 CPU，
      // 但省下的带宽更重要（手机端走公网隧道）
      client.send(maybeTrimFrame(data.toString()));
    });

    upstream.on("close", () => {
      if (!closed) client.close(1011, "upstream closed");
    });

    upstream.on("error", (err) => {
      if (!closed) client.close(1011, `upstream error: ${err.message}`);
    });
  };

  openUpstream();

  client.on("message", (data) => {
    const text = data.toString();
    if (upstream && upstream.readyState === WebSocket.OPEN) {
      upstream.send(text);
    } else if (backlog.length < MAX_BACKLOG) {
      backlog.push(text); // 上游未就绪，先缓冲
    } else {
      try {
        client.send(
          JSON.stringify({ type: "app-error", message: "upstream not ready, backlog full" })
        );
      } catch {}
    }
  });

  client.on("close", cleanup);
  client.on("error", cleanup);
}

/**
 * 建 WebSocketServer 并返回。仅用 noServer 模式 ——
 * upgrade 的鉴权在 http 层做，这样 HTTP 与 WS 共用同一套口令判断。
 */
function createServer(deps) {
  const wss = new WebSocketServer({ noServer: true, ...DEFLATE });
  wss.on("connection", (client) => handleConnection(client, deps));
  return wss;
}

module.exports = { createServer, connectUpstream, DEFLATE };
