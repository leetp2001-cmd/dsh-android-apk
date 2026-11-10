"use strict";
/**
 * POST /auth —— 口令登录。
 *
 * 校验通过后下发一个 30 天 cookie，之后所有请求靠它。失败回 401。
 */

const { sendJson, sendError, readJson } = require("../respond");

/**
 * @param {object} deps { passphrase: PassphraseAuth }
 * @returns {(ctx) => Promise<boolean>}
 */
function createAuthRoute({ passphrase }) {
  return async function handleAuth({ req, res, send, url }) {
    if (url.pathname !== "/auth") return false;
    if (req.method !== "POST") {
      sendError(send, 405, "app/method-not-allowed", "POST only");
      return true;
    }

    let body = {};
    try {
      body = await readJson(req);
    } catch {
      /* 坏 JSON 当作空口令，走失败分支 */
    }

    if (!passphrase.verify(body.passphrase)) {
      sendJson(send, 401, { ok: false, message: "口令错误" });
      return true;
    }

    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Set-Cookie": passphrase.setCookieHeader(),
    });
    res.end(JSON.stringify({ ok: true }));
    return true;
  };
}

module.exports = { createAuthRoute };
