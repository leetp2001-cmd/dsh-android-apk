"use strict";
/**
 * POST /rpc/<endpoint> —— unary RPC 转发。
 *
 * 三道关：
 *   1. 必须 POST
 *   2. endpoint 必须在白名单里（否则等于把整个 dsh API 暴露到公网）
 *   3. 转发失败回 502，并把上游错误原文带回去（手机端好排查）
 */

const { RPC_ALLOW } = require("../../dsh/rpc");
const { sendJson, sendError, readJson } = require("../respond");

const PREFIX = "/rpc/";

/**
 * @param {object} deps { rpc: DshRpc }
 */
function createRpcRoute({ rpc }) {
  return async function handleRpc({ req, res, send, url }) {
    if (!url.pathname.startsWith(PREFIX)) return false;

    const endpoint = url.pathname.slice(PREFIX.length);

    if (req.method !== "POST") {
      sendError(send, 405, "app/method-not-allowed", "POST only");
      return true;
    }

    if (!RPC_ALLOW.has(endpoint)) {
      sendError(send, 403, "app/forbidden", `endpoint not allowed: ${endpoint}`);
      return true;
    }

    let body;
    try {
      body = await readJson(req);
    } catch {
      sendError(send, 400, "app/bad-json", "bad json");
      return true;
    }

    try {
      const result = await rpc.call(endpoint, body.args ?? {});
      sendJson(send, 200, result);
    } catch (err) {
      sendError(send, 502, "app/proxy-failure", String(err.message));
    }
    return true;
  };
}

module.exports = { createRpcRoute };
