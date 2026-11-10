"use strict";
/**
 * HTTP 请求分发。
 *
 * ## 顺序是有意为之，别随便调
 *   1. POST /auth                  —— 登录本身当然不能要求已登录
 *   2. 免鉴权白名单（PWA 资源）     —— 浏览器拉 manifest/SW/图标时不带 cookie
 *   3. GET /push/public            —— 登录页要显示 ntfy topic，此时还没有 cookie
 *   4. 鉴权闸门                     —— 没过就走登录页或 401
 *   5. /rpc/*                     —— 白名单端点转发
 *   6. /push 系列                  —— 配置读写
 *   7. /healthz                    —— 存活探测
 *   8. 静态文件                     —— 最后兜底
 *
 * 鉴权闸门放在 5 之前意味着：只要没过闸，连 /healthz 都拿不到。
 * 这是刻意的 —— healthz 会暴露端口号与内存占用，没必要给公网看。
 */

const { makeSender, sendError } = require("./respond");
const { serveStatic, isPubliclyReadable } = require("./static");
const { renderLogin } = require("../views/login");

/**
 * @param {object} deps
 * @param {object} deps.auth          Authenticator
 * @param {object} deps.rpc           DshRpc
 * @param {object} deps.push          PushService
 * @param {number} deps.port
 * @param {Function} deps.log
 */
function createRouter({ auth, rpc, push, port, log = console.log }) {
  const { createAuthRoute } = require("./routes/auth");
  const { createRpcRoute } = require("./routes/rpc");
  const { createPushRoutes } = require("./routes/push");
  const { createHealthRoute } = require("./routes/health");

  const handleAuth = createAuthRoute({ passphrase: auth.passphrase });
  const handleRpc = createRpcRoute({ rpc });
  const handlePush = createPushRoutes({ push, log });
  const handleHealth = createHealthRoute({ rpc, port });

  return async function route(req, res) {
    const url = new URL(req.url, "http://localhost");
    const send = makeSender(req, res);

    try {
      // 1. 登录
      if (await handleAuth({ req, res, send, url })) return;

      // 2. PWA 资源免鉴权（无敏感信息，浏览器以无 cookie 方式拉取）
      if (isPubliclyReadable(url.pathname)) {
        if (serveStatic(req, res, send, url.pathname)) return;
      }

      // 3. 登录页要显示当前 ntfy topic（用户装完 App 照着输），
      //    但登录页没有 cookie，所以这个接口必须在鉴权之前。
      //    只回 topic 名，不带任何 key/token。
      if (url.pathname === "/push/public" && req.method === "GET") {
        const ntfy = (push.cfg.channels || []).find((c) => c.type === "ntfy");
        send(
          200,
          { "Content-Type": "application/json; charset=utf-8" },
          JSON.stringify({
            ok: true,
            value: {
              channels: ntfy ? [{ type: "ntfy", topic: ntfy.topic, server: ntfy.server }] : [],
            },
          })
        );
        return;
      }

      // 4. 鉴权闸门
      if (!auth.isAuthorized(req)) {
        // 页面请求给登录页（浏览器直接显示更好），其他一律 401
        if (url.pathname === "/" || url.pathname.endsWith(".html")) {
          send(200, { "Content-Type": "text/html; charset=utf-8" }, renderLogin());
          return;
        }
        sendError(send, 401, "app/unauthorized", "need auth");
        return;
      }

      // 5-7. 业务路由（顺序无关，各自按 pathname 自行认领）
      if (await handleRpc({ req, res, send, url })) return;
      if (await handlePush({ req, res, send, url })) return;
      if (await handleHealth({ req, res, send, url })) return;

      // 8. 静态文件
      if (serveStatic(req, res, send, url.pathname)) return;

      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("not found");
    } catch (err) {
      log(`[dsh-app] 请求处理异常 ${req.method} ${req.url}: ${err.stack || err.message}`);
      if (!res.headersSent) {
        sendError(send, 500, "app/internal", String(err.message));
      } else {
        try {
          res.end();
        } catch {}
      }
    }
  };
}

module.exports = { createRouter };
