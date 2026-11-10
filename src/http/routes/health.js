"use strict";
/**
 * GET /healthz —— 存活探测。
 *
 * 给两类调用方用：
 *   · start.sh / 隧道脚本判断"服务起来没有"
 *   · 手机端排障时看一眼 dsh 到底是 up 还是 down
 *
 * dsh 探测本身有 1.5s 超时 + 3s 缓存（见 dsh/rpc.js），
 * 所以这个端点高频调用也不会把上游压死。
 */

const { sendJson } = require("../respond");
const { DSH_AUTHORITY } = require("../../config");

/**
 * @param {object} deps { rpc: DshRpc, port: number }
 */
function createHealthRoute({ rpc, port }) {
  return async function handleHealth({ req, send, url }) {
    if (url.pathname !== "/healthz") return false;

    let dsh = "unknown";
    try {
      dsh = (await rpc.isUp()) ? "up" : "down";
    } catch {
      dsh = "down";
    }

    sendJson(send, 200, {
      ok: true,
      dsh,
      // 上游地址由后端下发，前端不要硬编码 —— 用户改过端口时，
      // 顶栏要显示真实连的那个，否则排障时会被误导。
      authority: DSH_AUTHORITY,
      uptime: Math.round(process.uptime()),
      port,
      memMB: Math.round(process.memoryUsage().rss / 1048576),
    });
    return true;
  };
}

module.exports = { createHealthRoute };
