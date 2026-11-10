"use strict";
/**
 * 推送门面：把「配置 + 探测器 + 编排」组合成一个对象给 HTTP 层用。
 *
 * 上层只跟这个类打交道，不需要知道内部有三块。启动/停止/改配置
 * 都从这里代理下去。
 */

const { PushConfigStore } = require("./config");
const { PushWatcher } = require("./watcher");
const { Notifier } = require("./notifier");

class PushService {
  /**
   * @param {object} deps
   * @param {(limit:number) => Promise<object>} deps.listSessions 走瘦身通道的会话列表
   * @param {() => string} deps.getCookie
   */
  constructor({ listSessions, getCookie, log = console.log }) {
    this.log = log;
    this.store = new PushConfigStore();
    this.notifier = new Notifier(this.store, { log });
    this.watcher = new PushWatcher({ listSessions, getCookie, log });

    // 会话标题由 watcher 维护，notifier 只读 —— 两边共享同一个 Map
    this.notifier.titles = this.watcher.titles;

    // 事件 → 文案 → 投递
    this.watcher.on("turnEnd", (info) => this.notifier.fire("turnEnd", info));
    this.watcher.on("approval", (info) => this.notifier.fire("approval", info));
    this.watcher.on("question", (info) => this.notifier.fire("question", info));
  }

  get cfg() {
    return this.store.cfg;
  }

  /** 启动。没配渠道就不开轮询 —— 空转的定时器白耗电，也让日志噪音变大。 */
  start() {
    this.applySchedule();
    this.log(
      `[push] 已启动（${this.cfg.enabled ? "已开启" : "未开启"}，渠道 ${this.cfg.channels.length} 个）`
    );
  }

  stop() {
    this.watcher.stop();
  }

  /** 配置变化后重算"该不该在后台跑" */
  applySchedule() {
    const want = this.cfg.enabled && this.cfg.channels.length > 0;
    if (want) this.watcher.start();
    else this.watcher.stop();
  }

  saveConfig(next) {
    const saved = this.store.save(next);
    this.applySchedule();
    return saved;
  }

  /** 给前端看的配置（密钥打码 + 运行态） */
  publicConfig() {
    return this.store.publicConfig({
      stats: this.notifier.stats,
      running: (this.cfg.channels || []).length > 0 && this.cfg.enabled,
      watching: this.watcher.watching(),
      evConnected: this.watcher.isEvConnected(),
    });
  }

  test(channelId) {
    return this.notifier.test(channelId);
  }
}

module.exports = { PushService };
