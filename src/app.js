"use strict";
/**
 * 服务装配：把各层接起来，返回一个可启停的应用对象。
 *
 * 这是唯一知道"全貌"的地方 —— 其他模块只认识自己依赖的那一两个接口。
 * 想把某一层换成别的实现（比如把认证换成 OAuth），只改这里。
 */

const http = require("node:http");
const os = require("node:os");

const config = require("./config");
const { PassphraseAuth } = require("./auth/passphrase");
const { EdgeAuth } = require("./auth/edge");
const { DshSession } = require("./auth/dsh-session");
const { Authenticator } = require("./auth");
const { DshRpc } = require("./dsh/rpc");
const { PushService } = require("./push");
const { createRouter } = require("./http/router");
const wsPipe = require("./ws/pipe");

/**
 * @param {object} [opts]
 * @param {Function} [opts.log]
 */
function createApp(opts = {}) {
  const log = opts.log || console.log;
  const { PORT, BIND_HOST } = config;

  // ---- 鉴权三层 ----
  const passphrase = new PassphraseAuth(log);
  const edge = new EdgeAuth(log);
  const dshSession = new DshSession(log);
  const auth = new Authenticator({ passphrase, edge, dshSession });
  // 路由层需要直接拿 passphrase 校验明文口令
  auth.passphrase = passphrase;

  // ---- dsh 代理 ----
  const rpc = new DshRpc({ getCookie: () => dshSession.cookie(), log });

  // ---- 推送 ----
  // 复用 rpc 的瘦身通道：dsh 原生 session/list 不吃 limit（1.9MB/次），
  // slimSessionList 能压到 20 条 / 8KB，轮询才敢 2.5 秒一次。
  const push = new PushService({
    getCookie: () => dshSession.cookie(),
    listSessions: async (limit) => {
      const r = await rpc.call("session/list", { _request: {}, _app: { limit } });
      if (r?.ok !== true) throw new Error("session/list 失败");
      return r.value;
    },
    log,
  });

  // ---- HTTP + WS ----
  const route = createRouter({ auth, rpc, push, port: PORT, log });
  const server = http.createServer(route);
  const wss = wsPipe.createServer({ getCookie: () => dshSession.cookie(), log });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/stream" && auth.isAuthorized(req)) {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
      return;
    }
    socket.destroy();
  });

  /** 启动时打印本机可达地址（局域网/mDNS/IPv6），省得用户自己查 */
  function logAccessHints() {
    if (BIND_HOST === "127.0.0.1") return;

    log(`[dsh-app] LAN access enabled — passphrase required (see ${config.PASSPHRASE_FILE})`);

    // 打印固定可用的 mDNS 地址：不依赖 DHCP、不依赖隧道，重启也不变
    const mdns = `${os.hostname().replace(/\.local$/i, "")}.local`;
    log(`[dsh-app] mDNS 固定地址: http://${mdns}:${PORT}  （同 Wi-Fi 手机可用，永不变）`);

    for (const list of Object.values(os.networkInterfaces())) {
      for (const ni of list || []) {
        // 只打全局/公网 IPv6（跳过 fe80 链路本地，那个手机用不了）
        if (ni.family === "IPv6" && !ni.internal && !/^fe[89ab]/i.test(ni.address)) {
          log(`[dsh-app] 全局 IPv6: http://[${ni.address}]:${PORT}`);
          break;
        }
      }
    }
  }

  return {
    server,
    wss,
    push,
    rpc,
    auth,

    listen() {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(PORT, BIND_HOST, () => {
          server.off("error", reject);
          log(`[dsh-app] listening on http://${BIND_HOST}:${PORT}  (dsh: ${config.DSH_ORIGIN})`);
          push.start();
          logAccessHints();
          resolve();
        });
      });
    },

    async close() {
      push.stop();
      try {
        wss.close();
      } catch {}
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

module.exports = { createApp };
