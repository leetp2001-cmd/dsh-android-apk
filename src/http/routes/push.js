"use strict";
/**
 * /push 系列：推送配置的读写与测试。
 *
 *   GET  /push        读当前配置（密钥打码，别把 key 原样回给前端）
 *   POST /push        保存配置 { enabled, channels, on, quiet, baseUrl }
 *   POST /push/test   发一条测试推送 → 把每个渠道的真实结果回传
 *
 * GET /push/public 放在 auth.js 之前处理（见 http/router.js），
 * 因为登录页要显示 ntfy topic，而登录页还没 cookie。
 */

const { sendJson, sendError, readJson } = require("../respond");

/**
 * @param {object} deps { push: PushService }
 */
function createPushRoutes({ push, log = console.log }) {
  return async function handlePush({ req, res, send, url }) {
    const p = url.pathname;

    if (p === "/push" && req.method === "GET") {
      sendJson(send, 200, { ok: true, value: push.publicConfig() });
      return true;
    }

    if (p === "/push" && req.method === "POST") {
      let body;
      try {
        body = await readJson(req);
      } catch {
        sendError(send, 400, "app/bad-json", "bad json");
        return true;
      }
      const saved = push.saveConfig(body);
      log(
        `[dsh-app] 推送配置已更新：${saved.enabled ? "开启" : "关闭"} / ${saved.channels.length} 个渠道`
      );
      sendJson(send, 200, { ok: true, value: push.publicConfig() });
      return true;
    }

    if (p === "/push/test" && req.method === "POST") {
      let body = {};
      try {
        body = await readJson(req);
      } catch {
        /* 允许空体：等于测试所有渠道 */
      }
      const r = await push.test(body.channelId);
      sendJson(send, r.ok ? 200 : 502, { ok: r.ok, value: r });
      return true;
    }

    return false;
  };
}

module.exports = { createPushRoutes };
