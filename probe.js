// 探针：打开 dsh /api/remote.mux，试探各端点参数形态并打印返回帧。
// 用途：dsh 升级后 RPC 参数发生变化时，用它快速确认实际接受的格式。
//
// 用法：
//   node probe.js
//
// 注意：签名密钥从 ~/.dsh/.credentials.yaml 实时读取，不在代码里硬编码。
// 该凭据等同 dsh web 的浏览器会话权限，任何情况下都不要提交进仓库。

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
// ws 与 server.js 共用同一套多路径解析
const { WebSocket } = require("./src/lib/ws.js");

// dsh web 默认监听 3080；如果你启 dsh 时改了端口，用 DSH_AUTHORITY 覆盖
const authority = process.env.DSH_AUTHORITY || "127.0.0.1:3080";

function readDshSecret() {
  const raw = fs.readFileSync(path.join(DSH_HOME, ".credentials.yaml"), "utf8");
  const m = raw.match(/secret:\s*(\S+)/);
  if (!m) throw new Error(`${DSH_HOME}/.credentials.yaml 中未找到 secret`);
  return m[1];
}

const b64url = (buf) =>
  Buffer.from(buf).toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
const b64urlDecode = (s) =>
  Buffer.from(String(s).replaceAll("-", "+").replaceAll("_", "/"), "base64");

const secretBytes = b64urlDecode(readDshSecret());
const cookieName = "dsh-auth-" + b64url(crypto.createHash("sha256").update(authority).digest());
const payload = { version: 1, authority, issuedAt: Date.now(), expiresAt: Date.now() + 86400000 };
const body = b64url(JSON.stringify(payload));
const sig = b64url(crypto.createHmac("sha256", secretBytes).update(body).digest());
const cookie = cookieName + "=v1." + body + "." + sig;

const ws = new WebSocket(`ws://${authority}/api/remote.mux`, { headers: { Cookie: cookie, Host: authority } });
ws.on("open", () => {
  const variants = [
    ["session/list", { args: { _request: {} } }],
    ["session/list", { _request: {} }],
    ["session/page", { args: { _request: { address: {}, throughSeq: -1, maxMessages: 5 } } }],
  ];
  variants.forEach(([ep, payload], i) => {
    ws.send(JSON.stringify({ type: "open", streamId: "s" + i, endpoint: ep, payload }));
  });
});
ws.on("message", (data) => {
  const s = data.toString();
  console.log(s.length > 1500 ? s.slice(0, 1500) + " ...[truncated]" : s);
});
ws.on("error", (e) => { console.error("WS error:", e.message); process.exit(1); });
ws.on("close", (c, r) => { console.error("closed", c, r.toString().slice(0, 100)); process.exit(0); });
setTimeout(() => process.exit(0), 8000);
