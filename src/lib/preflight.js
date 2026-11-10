"use strict";
/**
 * 启动前置自检：本服务能起来，不代表它能用。
 *
 * ## 为什么要这一层
 *
 * 本服务的失败模式很特殊 —— 上游（dsh）挂了的时候，它**照样启动成功**：
 * HTTP 服务能听、登录页能开、口令能验。然后用户看到一个空的会话列表，
 * 以为是自己哪里配错了，却无从下手。
 *
 * healthz 里虽然有 `dsh:"down"`，但新人不会去翻 healthz。所以把检查搬到
 * 启动那一刻，把「到底哪一环断了」直接打在终端上。
 *
 * ## 检查顺序
 *
 * 从下往上查，每一步失败都给出针对该步的修复建议 —— 顺序不能反，
 * 因为上游缺失时下游的错误全是噪音（比如凭据文件缺失，往往是因为
 * DSH_HOME 指错了，而 DSH_HOME 指错本身也是「没装 dsh」的一种表现）。
 *
 * 本模块**只报告，不阻断启动**：dsh 常常是后启动的（比如从 launchd 拉起来
 * 的时候本服务先醒），硬退出反而让用户更难恢复。
 */

const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");

const { DSH_HOME, DSH_AUTHORITY } = require("../config");

/** TCP 探一下 host:port 是否有人在听。超时短，因为这是本机回环。 */
function probePort(host, port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (ok, reason) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve({ ok, reason });
    };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => finish(true));
    sock.once("timeout", () => finish(false, "ETIMEDOUT"));
    sock.once("error", (e) => finish(false, e.code || "ERROR"));
    try {
      sock.connect(port, host);
    } catch (e) {
      finish(false, e.code || "ERROR");
    }
  });
}

/**
 * 跑完全部检查。
 *
 * @returns {Promise<{ok: boolean, problems: Array<{code: string, msg: string, fix: string}>}>}
 */
async function runPreflight() {
  const problems = [];

  // ---- 1. 上游端口在听吗 ----
  const [host, portStr] = splitAuthority(DSH_AUTHORITY);
  const port = Number(portStr);
  let portOk = false;
  if (!host || !Number.isInteger(port) || port <= 0) {
    problems.push({
      code: "authority-malformed",
      msg: `DSH_AUTHORITY 格式不对：「${DSH_AUTHORITY}」`,
      fix: `应形如 127.0.0.1:3080（host:port，不含 http://）。`,
    });
  } else {
    const p = await probePort(host, port);
    portOk = p.ok;
    if (!p.ok) {
      const hintOnOther = await guessDshPort();
      problems.push({
        code: "upstream-down",
        msg: `连不上 dsh（${host}:${port}，${p.reason}）—— dsh web 可能没在跑`,
        fix:
          `另开一个终端执行 "dsh web" 启动 dsh；` +
          (hintOnOther
            ? `检测到 ${hintOnOther} 端口有服务在听，如果那就是 dsh，` +
              `改用 DSH_AUTHORITY=127.0.0.1:${hintOnOther} ./start.sh。`
            : `若你启动 dsh 时改过端口，需同步设 DSH_AUTHORITY=127.0.0.1:<你的端口>。`),
      });
    }
  }

  // ---- 2. 凭据文件在吗 ----
  // 端口通了才查这个：端口都不通时，凭据缺失多半只是连带现象。
  const credFile = path.join(DSH_HOME, ".credentials.yaml");
  if (!fs.existsSync(credFile)) {
    problems.push({
      code: "credentials-missing",
      msg: `找不到 dsh 凭据文件：${credFile}`,
      fix:
        `通常是 DSH_HOME 指错了。确认 dsh 的数据目录在哪，` +
        `然后 DSH_HOME=/你的/dsh/目录 ./start.sh。` +
        `（默认应为 ~/.dsh；如果你没装过 dsh，先执行 npm i -g @deepseek-ai/dsh 再跑一次 dsh web）`,
    });
  }

  // ---- 3. ws 依赖 ----
  // 正常情况下 resolve-ws 找不到就会 process.exit，能走到这里说明已解析成功；
  // 这里只把解析到的位置打出来，方便用户排查「装了两份 ws」之类的怪事。
  let wsFrom = "";
  try {
    wsFrom = require("./ws.js").__resolvedFrom || "";
  } catch {
    problems.push({
      code: "ws-unresolved",
      msg: "找不到 ws 依赖",
      fix: "在仓库目录执行 npm install。",
    });
  }

  return { ok: problems.length === 0, problems, wsFrom, portOk };
}

/** 把 "127.0.0.1:3080" / "[::1]:3080" 拆成 [host, port] */
function splitAuthority(authority) {
  const s = String(authority || "");
  const m = s.match(/^\[([^\]]+)\]:(\d+)$/);
  if (m) return [m[1], m[2]];
  const i = s.lastIndexOf(":");
  if (i === -1) return [s, ""];
  return [s.slice(0, i), s.slice(i + 1)];
}

/**
 * 猜 dsh 是否跑在别的常见端口上。
 *
 * 这一条专治最高频的错配：用户用 `dsh web --port 8742` 启动，
 * 但没设 DSH_AUTHORITY，于是代理照着默认 3080 去连，连不上。
 * 与其让人自己猜，不如直接把「8742 上有东西在听」告诉他。
 */
async function guessDshPort() {
  const [, cur] = splitAuthority(DSH_AUTHORITY);
  const common = ["3080", "8742", "3000", "8080", "8000"];
  for (const p of common) {
    if (p === cur) continue;
    const r = await probePort("127.0.0.1", Number(p), 300);
    if (r.ok) return p;
  }
  return null;
}

/** 把自检结果打成终端提示（不用 log，避免和正常日志混在一起） */
function printPreflight(result) {
  const out = (s) => process.stdout.write(s + "\n");
  const err = (s) => process.stderr.write(s + "\n");

  if (result.ok) {
    out(`[preflight] 自检通过：dsh 可达，凭据就绪${result.wsFrom ? `，ws=${result.wsFrom}` : ""}`);
    return;
  }

  err("");
  err("=".repeat(72));
  err("  [preflight] 启动自检发现问题 —— 服务仍会启动，但下面的功能会不可用：");
  err("=".repeat(72));
  result.problems.forEach((p, i) => {
    err("");
    err(`  ${i + 1}) ${p.msg}`);
    err(`     → ${p.fix}`);
  });
  err("");
  err("  完整自检随时可跑：./doctor.sh");
  err("=".repeat(72));
  err("");
}

module.exports = { runPreflight, printPreflight, probePort, splitAuthority };
