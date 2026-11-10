"use strict";
/**
 * 推送探测器：找出"该推的事件"。
 *
 * ## 为什么放在服务端
 * 前端要页面在前台活着才能收 WS 事件。手机锁屏/切后台后 WebView 被挂起，
 * 事件流静默死亡 —— 这恰恰是"最需要推送"的场景。本服务常驻，
 * 天然知道所有会话状态。
 *
 * ## 触发点怎么找（本模块最容易写错的地方，每个都实测过）
 *
 * 「跑完了」不能靠 session/control 的投影差分 —— 实测 baseline 里**没有 running**
 * （只有 title/tokenUsage/contextPressure/inbox/sessionStats/turnOutline…），
 * 而且 running 是 session/list 的行级字段，不是投影，永远不会从 control 流推过来。
 *
 * 两个可行信号，本模块组合使用：
 *   ① 轮询 session/list 的 running 字段，检测 false→true（会话开始干活）
 *   ② 一旦发现某会话在跑，就为它单开 session/follow，等它自己的 turn/end
 *      —— turn/end 带 reason.kind（completed / error / cancelled / max-tokens …），
 *      文案能说清"是跑完了还是出错了"，只有轮询做不到这个区分。
 *      收完就关掉 follow，没人跑的时候零订阅开销。
 *
 * 「等你审批」只能挂 $events 全局流（waterfall 帧），这是审批/提问的唯一来源。
 * 注意撤卡信号是 {type:"cancel"} 而不是 approval/decided（后者是 session 日志事件，
 * 根本不在 $events 转发白名单里）。
 */

const { EventEmitter } = require("node:events");
const crypto = require("node:crypto");

const { WebSocket } = require("../lib/ws");
const { connectUpstream, DEFLATE } = require("../ws/pipe");
const { DSH_AUTHORITY } = require("../config");

// 轮询间隔：2.5 秒。
// 取舍：一轮任务若在 2.5 秒内跑完，running 的 false→true→false 会整个落在两次
// 轮询之间，检测不到 → 不推送。这是**故意的**：2 秒就答完的问题，人肯定还在
// 屏幕前看着，推送反而是噪音。推送要解决的是"跑去干别的了"的场景。
// 代价侧：一次限 20 条约 8KB / 60ms（回环），2.5 秒一发完全不心疼。
const POLL_MS = 2500;

// 单个会话 follow 的超时兜底：dsh 卡死时不会有 turn/end，别让订阅永久挂着
const FOLLOW_MAX_MS = 30 * 60 * 1000;

// 上游 WS 断线重连间隔
const RECONNECT_MS = 5000;

// running 状态表超过这个规模就清理已消失的会话，避免 Map 无限长
const RUNNING_MAP_MAX = 400;

/**
 * 事件源。
 *
 * 事件（emit）：
 *   "turnEnd"  { sessionId, title, reason, turn? }  reason 见 turn/end 的 kind
 *   "approval" { eventId, sessionId, toolName, reason }
 *   "question" { eventId, sessionId, count, first }
 */
class PushWatcher extends EventEmitter {
  /**
   * @param {object} deps
   * @param {(limit:number) => Promise<object>} deps.listSessions 走瘦身通道的会话列表
   * @param {() => string} deps.getCookie
   */
  constructor({ listSessions, getCookie, log = console.log }) {
    super();
    this.listSessions = listSessions;
    this.getCookie = getCookie;
    this.log = log;

    // 会话标题缓存：通知里必须有标题，否则一堆 session-xxxx 完全分不清
    this.titles = new Map();
    // 轮询基线：sessionId -> running
    this.running = new Map();
    this.tracked = new Map(); // sessionId -> { ws, timer, openedAt, ready }
    this.evWs = null;
    this.evClientId = null;
    this.pollTimer = null;
    this.pollBusy = false;
    this.active = false;
  }

  /** 开轮询 + 挂全局事件流。重复调用无害。 */
  start() {
    if (this.active) return;
    this.active = true;
    this.pollTimer = setInterval(() => this.pollOnce().catch(() => {}), POLL_MS);
    this.pollOnce().catch(() => {});
    this.ensureEvents();
  }

  /** 停掉一切后台活动（关推送时调用，零空转） */
  stop() {
    this.active = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    for (const sid of [...this.tracked.keys()]) this.untrack(sid);
    this.dropEvents();
  }

  isEvConnected() {
    return !!this.evClientId;
  }

  /** 当前正在跑的会话 id 列表（给前端显示"正在跟踪 N 个"） */
  watching() {
    return [...this.running.entries()].filter(([, v]) => v).map(([k]) => k);
  }

  // ---------- 轮询：发现"开始跑"的会话 ----------
  async pollOnce() {
    if (this.pollBusy) return;
    this.pollBusy = true;
    try {
      // 20 条足够：正在跑的会话 updatedAt 一定最新，翻不到第二页去。
      // 走 app 的瘦身通道，一次 ~8KB，轮询完全不心疼。
      const value = await this.listSessions(20);
      const items = Array.isArray(value?.items) ? value.items : [];

      for (const s of items) {
        const sid = s.sessionId;
        if (!sid) continue;

        const title = s?.projections?.values?.title;
        if (title) this.titles.set(sid, title);

        const was = this.running.get(sid) === true;
        const now = s.running === true;
        this.running.set(sid, now);

        if (now && !was) {
          // 刚开始跑：开 follow 等它的 turn/end。
          // 不开 follow 只靠轮询的话，"跑完了"能感知，但分不清 completed / error。
          this.track(sid);
        } else if (!now && was) {
          // 兜底：轮询发现已经停了但 follow 没送来 turn/end（WS 断了 / 任务太快）。
          const t = this.tracked.get(sid);
          if (t && Date.now() - t.openedAt > POLL_MS * 2) {
            this.untrack(sid);
            this.emit("turnEnd", {
              sessionId: sid,
              title: this.titles.get(sid),
              reason: "completed",
              guessed: true,
            });
          }
        }
      }

      // 会话已被删除 / 掉出前 20 且不在跑：清掉跟踪状态，避免 Map 无限长
      if (this.running.size > RUNNING_MAP_MAX) {
        const alive = new Set(items.map((s) => s.sessionId));
        for (const sid of [...this.running.keys()]) {
          if (!alive.has(sid) && !this.running.get(sid)) this.running.delete(sid);
        }
      }
    } catch {
      // 轮询失败不吵人：dsh 重启期间必然失败几次，等下一轮就好
    } finally {
      this.pollBusy = false;
    }
  }

  // ---------- 单会话 follow：等 turn/end ----------
  track(sid) {
    if (this.tracked.has(sid)) return;

    let ws;
    try {
      ws = connectUpstream(this.getCookie());
    } catch (e) {
      this.log("[push] follow 建连失败: " + e.message);
      return;
    }

    const entry = { ws, openedAt: Date.now(), timer: null, ready: false };
    this.tracked.set(sid, entry);

    // 兜底超时：dsh 卡在工具里时不会发 turn/end
    entry.timer = setTimeout(() => this.untrack(sid), FOLLOW_MAX_MS);

    ws.on("open", () => {
      try {
        ws.send(
          JSON.stringify({
            type: "open",
            streamId: "push-" + sid,
            endpoint: "session/follow",
            payload: {
              args: {
                request: {
                  address: { kind: "session", sessionId: sid },
                  // maxMessages:1 —— 只要实时帧，历史全部不关心。
                  // assistantStream 必须 true：schema 里是 const:true，传 false 直接
                  // gateway/input-invalid（这个坑踩过一次）。
                  maxMessages: 1,
                  assistantStream: true,
                },
              },
            },
          })
        );
      } catch {}
    });

    ws.on("message", (data) => {
      let m;
      try {
        m = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (m.type !== "item") return;

      const v = m.value;
      // snapshot = 历史回放。里面可能带有上一轮的 turn/end，
      // 不挡住就会"刚打开 follow 就推一条已完成"，用户莫名其妙。
      // maxMessages:1 已经让快照很小，但仍会回放最近事件，所以显式跳过。
      if (v?.type === "snapshot") {
        entry.ready = true;
        return;
      }
      if (!entry.ready) entry.ready = true; // 没收到快照也放行（某些会话快照为空）

      const ev = v?.event;
      if (!ev || ev.type !== "turn/end") return;

      const reason = ev.data?.reason?.kind || "completed";
      const turn = ev.data?.turn;
      this.untrack(sid);
      this.emit("turnEnd", { sessionId: sid, title: this.titles.get(sid), reason, turn });
    });

    ws.on("error", () => this.untrack(sid));
    ws.on("close", () => {
      if (this.tracked.get(sid)?.ws === ws) this.untrack(sid);
    });
  }

  untrack(sid) {
    const t = this.tracked.get(sid);
    if (!t) return;
    this.tracked.delete(sid);
    if (t.timer) clearTimeout(t.timer);
    try {
      t.ws?.close();
    } catch {}
  }

  // ---------- 全局事件流：审批 / 提问 ----------
  dropEvents() {
    this.evClientId = null;
    try {
      this.evWs?.close();
    } catch {}
    this.evWs = null;
  }

  ensureEvents() {
    if (this.evWs && (this.evWs.readyState === 0 || this.evWs.readyState === 1)) return;

    let ws;
    try {
      ws = new WebSocket(`ws://${DSH_AUTHORITY}/api/remote.mux`, {
        headers: { Cookie: this.getCookie() },
        ...DEFLATE,
      });
    } catch {
      return;
    }
    this.evWs = ws;

    ws.on("open", () => {
      try {
        ws.send(
          JSON.stringify({
            type: "open",
            streamId: "push-events",
            endpoint: "$events",
            payload: { args: {} },
          })
        );
      } catch {}
    });

    ws.on("message", (data) => {
      let m;
      try {
        m = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (m.type !== "item") return;

      const v = m.value;
      if (v?.type === "ready") {
        this.evClientId = v.clientId;
        return;
      }

      if (v?.type === "waterfall" && v.event === "approval/request") {
        const r = v.request || {};
        this.emit("approval", {
          eventId: v.eventId,
          sessionId: v.agentId || r.agent,
          toolName: r.toolName || r.tool || "未知工具",
          reason: r.reason || r.message || "",
        });
        return;
      }

      if (v?.type === "waterfall" && v.event === "user-questions/request") {
        const qs = v.request?.questions || [];
        const first = qs[0]?.question || qs[0]?.header || qs[0]?.text || "";
        this.emit("question", {
          eventId: v.eventId,
          sessionId: v.request?.agent || v.agentId,
          count: qs.length,
          first,
        });
      }
    });

    const reconnect = () => {
      this.evClientId = null;
      if (this.evWs === ws) this.evWs = null;
      // 只有"推送还开着"才重连，否则关掉后还会自己爬起来
      if (this.active) setTimeout(() => this.ensureEvents(), RECONNECT_MS);
    };
    ws.on("error", reconnect);
    ws.on("close", reconnect);
  }
}

module.exports = { PushWatcher, POLL_MS, FOLLOW_MAX_MS };
