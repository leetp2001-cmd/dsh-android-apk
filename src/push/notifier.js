"use strict";
/**
 * 通知编排：把事件变成一条人话通知，去重后送出去。
 *
 * 职责边界很窄 —— 只管"该不该发、发什么文案、发给谁"。
 * 事件从哪来（watcher）、怎么发（channels）都不在这里。
 */

const { deliver } = require("./channels");
const { PushConfigStore } = require("./config");

/** 推送去重窗口：同一 key 在此时间内不重复推 */
const DEDUP_TTL_MS = 12 * 60 * 60 * 1000;

class Notifier {
  /**
   * @param {PushConfigStore} store
   * @param {object} opts { log, titles: Map }
   */
  constructor(store, { log = console.log, titles = new Map() } = {}) {
    this.store = store;
    this.log = log;
    this.titles = titles;
    this.dedup = new Map(); // key -> ts
    this.stats = { sent: 0, failed: 0, lastError: "", lastSentAt: 0 };
  }

  get cfg() {
    return this.store.cfg;
  }

  /** 静音时段判断。跨午夜（23:30 → 07:30）时区间是"或"关系。 */
  inQuietHours(now = new Date()) {
    const q = this.cfg.quiet;
    if (!q?.enabled) return false;

    const cur = now.getHours() * 60 + now.getMinutes();
    const parse = (s) => {
      const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || ""));
      return m ? Number(m[1]) * 60 + Number(m[2]) : null;
    };
    const a = parse(q.start);
    const b = parse(q.end);
    if (a == null || b == null) return false;

    return a <= b ? cur >= a && cur < b : cur >= a || cur < b;
  }

  dedupOk(key) {
    const now = Date.now();
    for (const [k, ts] of this.dedup) if (now - ts > DEDUP_TTL_MS) this.dedup.delete(k);
    if (this.dedup.has(key)) return false;
    this.dedup.set(key, now);
    return true;
  }

  /** 归类成一条通知文案。手机通知栏只有一行标题 + 两行正文，信息要够用。 */
  compose(kind, info) {
    const title =
      info.title || (info.sessionId ? this.titles.get(info.sessionId) : "") || "未命名会话";
    const short = String(title).slice(0, 40);

    switch (kind) {
      case "turnEnd": {
        const r = info.reason || "completed";
        if (r === "error") return { title: `❌ ${short}`, body: "本轮执行出错，点开查看原因" };
        if (r === "cancelled") {
          return this.cfg.on?.cancelled === false ? null : { title: `⏹ ${short}`, body: "已中断" };
        }
        if (r === "max-tokens") {
          return { title: `⚠️ ${short}`, body: "输出被截断（达到 token 上限）" };
        }
        if (r === "interrupted") {
          return { title: `⚠️ ${short}`, body: "dsh 进程重启导致本轮中断" };
        }
        return { title: `✅ ${short}`, body: "已完成" };
      }
      case "approval":
        return {
          title: `🔐 ${short}`,
          body:
            `等待审批：${info.toolName || "未知工具"}` +
            (info.reason ? " · " + String(info.reason).slice(0, 60) : ""),
        };
      case "question":
        return {
          title: `❓ ${short}`,
          body:
            info.count > 1
              ? `${info.count} 个问题等你回答`
              : `等你回答：${String(info.first || "").slice(0, 60)}`,
        };
      default:
        return null;
    }
  }

  /** 点通知回跳地址 */
  clickUrl(sessionId) {
    if (!sessionId) return "";
    const base = (this.cfg.baseUrl || "").replace(/\/+$/, "");
    if (!base) return "";
    return `${base}/?s=${encodeURIComponent(sessionId)}`;
  }

  /**
   * 尝试推送一条。所有开关（总开关/分类开关/静音/去重）都在这里判。
   * 不抛错 —— 推送失败不该影响主流程。
   */
  fire(kind, info) {
    try {
      if (!this.cfg.enabled || !this.cfg.channels.length) return;
      if (this.cfg.on && this.cfg.on[kind] === false) return;
      // error 类单独一个开关：有人只想收"跑完了"，不想被报错打扰
      if (kind === "turnEnd" && info.reason === "error" && this.cfg.on?.error === false) return;
      if (this.inQuietHours()) return;

      const key =
        kind === "turnEnd"
          ? `t:${info.sessionId}:${info.turn ?? Math.floor(Date.now() / 60000)}`
          : `${kind}:${info.eventId || info.sessionId}`;
      if (!this.dedupOk(key)) return;

      const msg = this.compose(kind, info);
      if (!msg) return;

      const url = this.clickUrl(info.sessionId);
      for (const ch of this.cfg.channels) {
        this.send(ch, msg, url).catch((e) => {
          this.stats.failed++;
          this.stats.lastError = e.message.slice(0, 200);
          this.log(`[push] ${ch.type} 发送失败: ${e.message}`);
        });
      }
    } catch (e) {
      this.log("[push] fire 异常: " + e.message);
    }
  }

  async send(ch, msg, url) {
    await deliver(ch, msg, url);
    this.stats.sent++;
    this.stats.lastSentAt = Date.now();
    this.stats.lastError = "";
  }

  /** 测试推送（带真实错误回传，别让用户猜为什么不响） */
  async test(channelId) {
    const list = channelId
      ? this.cfg.channels.filter((c) => c.id === channelId)
      : this.cfg.channels;
    if (!list.length) return { ok: false, error: "还没有配置推送渠道" };

    const msg = { title: "🔔 dsh 控制台测试", body: "收到这条说明推送配置可用" };
    const results = [];
    for (const ch of list) {
      try {
        await this.send(ch, msg, this.clickUrl(""));
        results.push({ id: ch.id, type: ch.type, ok: true });
      } catch (e) {
        results.push({ id: ch.id, type: ch.type, ok: false, error: e.message.slice(0, 200) });
      }
    }
    return { ok: results.every((r) => r.ok), results, stats: this.stats };
  }
}

module.exports = { Notifier, DEDUP_TTL_MS };
