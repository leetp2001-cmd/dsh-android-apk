"use strict";
/**
 * dsh RPC 代理（unary 通道）。
 *
 * 手机端 POST /rpc/<endpoint> → 本模块把它翻成 dsh 的 client-request 帧
 * POST 到 http://<dsh>/api/<endpoint>，再把 server-response.result 原样回给前端。
 *
 * 两个额外职责，都在这一层做（放到别处会更贵）：
 *   1. 白名单：只有手机端真正用到的端点才放行。原来 pathname 直接透传，
 *      等于任意 dsh 端点都能从公网打进来。
 *   2. 瘦身：session/list 在这里裁投影 + 分页；WS 的下行瘦身在 ws 层。
 */

const crypto = require("node:crypto");

const { DSH_ORIGIN } = require("../config");
const { slimSessionList, SLIM_ENABLED } = require("./slim-list");

/**
 * 手机端真正用到的 dsh 端点。新增功能时必须同步补到这里，否则 403。
 * 分组只为人读，Set 本身无序。
 */
const RPC_ALLOW = new Set([
  // 会话读写
  "session/list", "session/page", "session/follow", "session/prompt", "session/cancel",
  "session/create", "session/rename", "session/search", "session/projections",
  "session/fork", "session/selectModel",
  // 排队条：删除排队消息 / 插队（next-step）
  "session/updateQueue",
  // 工作区
  "workspace/pinSession", "workspace/unpinSession",
  "workspace/archiveSession", "workspace/unarchiveSession",
  // 附件
  "fileUploads/upload",
  // 消息里的图片：follow 只给 attachmentId，字节要单独换（参数须包一层 request）
  "session/attachment",
  // 事件答复（提问卡 + 审批卡共用）
  "$events/result",
]);

const PROBE_CACHE_MS = 3000;
const PROBE_TIMEOUT_MS = 1500;

/**
 * 把上游连接失败翻译成能照着做的提示。
 *
 * Node fetch 对网络层错误只抛 "fetch failed"，原因在 err.cause.code 里：
 *   ECONNREFUSED  dsh 没在跑，或端口不对（最常见）
 *   ETIMEDOUT     网络/防火墙拦了
 *   ENOTFOUND     地址写错了
 */
function describeUpstreamError(err) {
  const code = err?.cause?.code || err?.code || "";
  const target = DSH_ORIGIN;
  if (code === "ECONNREFUSED") {
    return (
      `连不上 dsh（${target} 拒绝连接）。` +
      `请确认 dsh web 已启动：另开一个终端执行 "dsh web"，` +
      `并确认它的端口与 DSH_AUTHORITY 一致（当前为 ${target}）。` +
      `不确定就跑 ./doctor.sh 自检。`
    );
  }
  if (code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT") {
    return `连接 dsh（${target}）超时 —— 可能被防火墙或代理拦截。`;
  }
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return `解析不了 dsh 地址（${target}）—— 请检查 DSH_AUTHORITY 是否写错。`;
  }
  return `连不上 dsh（${target}）：${code || err?.message || "未知错误"}`;
}

class DshRpc {
  /**
   * @param {object} deps
   * @param {() => string} deps.getCookie 取上游 dsh cookie
   */
  constructor({ getCookie, log = console.log }) {
    this.getCookie = getCookie;
    this.log = log;
    this._probe = { at: 0, up: false };
  }

  /**
   * 转发一次 unary RPC。
   *
   * @param {string} endpoint 例如 "session/list"
   * @param {object} args     前端给的参数
   * @returns {Promise<object>} dsh 的 result（{ok:true,value} 或 {ok:false,error}）
   */
  async call(endpoint, args) {
    // 前端私有参数（_app）只给代理层看，不能透给 dsh：dsh 用严格 schema 解析 request。
    let fwdArgs = args;
    let appOpts = {};
    if (args && typeof args === "object" && args._app && typeof args._app === "object") {
      const { _app, ...rest } = args;
      appOpts = _app;
      fwdArgs = rest;
    }

    const res = await fetch(`${DSH_ORIGIN}/api/${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: this.getCookie() },
      body: JSON.stringify({
        type: "client-request",
        rpcId: crypto.randomUUID(),
        method: endpoint,
        payload: { args: fwdArgs },
      }),
    }).catch((err) => {
      // Node 的 fetch 只会抛一个光秃秃的 "fetch failed"，真正的原因
      // （ECONNREFUSED / ENOTFOUND / 超时）藏在 err.cause 里。
      // 不把 cause 翻出来，用户在前端只能看到一个无法行动的报错。
      throw new Error(describeUpstreamError(err));
    });

    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`dsh 返回非 JSON (HTTP ${res.status}): ${text.slice(0, 200)}`);
    }
    if (body?.type !== "server-response") {
      throw new Error(`dsh 响应异常: ${text.slice(0, 200)}`);
    }

    let result = body.result; // {ok:true,value} | {ok:false,error}
    if (SLIM_ENABLED && endpoint === "session/list") {
      result = slimSessionList(result, appOpts);
    }
    return result;
  }

  /**
   * dsh 上游是否活着，供 /healthz 用。
   * 1.5s 超时 + 3s 缓存：healthz 高频调用时不会把上游压死。
   */
  async isUp() {
    const now = Date.now();
    if (now - this._probe.at < PROBE_CACHE_MS) return this._probe.up;

    let up = false;
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), PROBE_TIMEOUT_MS);
      const res = await fetch(`${DSH_ORIGIN}/api/session/list`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: this.getCookie() },
        body: JSON.stringify({
          type: "client-request",
          rpcId: crypto.randomUUID(),
          method: "session/list",
          payload: { args: { _request: {} } },
        }),
        signal: ac.signal,
      });
      clearTimeout(timer);
      up = res.ok;
    } catch {
      up = false;
    }

    this._probe = { at: now, up };
    return up;
  }
}

module.exports = { DshRpc, RPC_ALLOW, describeUpstreamError };
