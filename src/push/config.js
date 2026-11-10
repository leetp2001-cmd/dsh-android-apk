"use strict";
/**
 * 推送配置：读写 .push.json，对外打码。
 *
 * ## 存放位置
 * 配置存在服务端而不是 localStorage：页面刷新/换设备都不丢，
 * 而且含密钥的东西不该放在一个会被截图外泄的地方。
 *
 * ## 打码约定（前后端必须一致）
 * 读给前端时 key/token 变成 "abc••••xyz"；前端原样提交回来时，
 * 服务端识别出"含 ••••"就保留旧值 —— 否则真 key 会被打码串覆盖，
 * 用户再也收不到推送。
 */

const fs = require("node:fs");

const { PUSH_CONFIG_FILE } = require("../config");

/** 默认配置。enabled=false 是有意的：装完不该突然开始发通知。 */
function defaultConfig() {
  return {
    enabled: false,
    channels: [], // [{ id, type: 'ntfy'|'bark'|'serverchan', ... }]
    on: { turnEnd: true, approval: true, question: true, error: true },
    // 静音时段（本地时间）。手机半夜响一声比漏推还烦。
    quiet: { enabled: false, start: "23:30", end: "07:30" },
    // 点通知回跳用：公网隧道地址（留空则通知不带链接）
    baseUrl: "",
  };
}

const MASK = "••••";

function mask(s) {
  if (!s) return "";
  const t = String(s);
  return t.length <= 6 ? MASK : t.slice(0, 3) + MASK + t.slice(-3);
}

/** 是不是一个被打了码的值（前端原样提交回来时要还原） */
function isMasked(v) {
  return typeof v === "string" && v.includes(MASK);
}

/** 按渠道类型只保留该类型认识的字段，顺手补齐默认服务地址 */
function normalizeChannel(c, i) {
  const id = c.id || "ch" + (i + 1);
  if (c.type === "ntfy") {
    return {
      id,
      type: "ntfy",
      server: c.server || "https://ntfy.sh",
      topic: c.topic,
      token: c.token || "",
    };
  }
  if (c.type === "bark") {
    return { id, type: "bark", server: c.server || "https://api.day.app", key: c.key };
  }
  if (c.type === "serverchan") {
    return { id, type: "serverchan", key: c.key };
  }
  return { id, type: c.type };
}

/** 至少要有 topic 或 key 才有意义 */
function isUsableChannel(c) {
  return !!c.type && !!(c.topic || c.key);
}

class PushConfigStore {
  constructor() {
    this.file = PUSH_CONFIG_FILE;
    this.cfg = this.load();
  }

  load() {
    const base = defaultConfig();
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
      return {
        ...base,
        ...raw,
        on: { ...base.on, ...(raw.on || {}) },
        quiet: { ...base.quiet, ...(raw.quiet || {}) },
        channels: Array.isArray(raw.channels) ? raw.channels : [],
      };
    } catch {
      return base;
    }
  }

  /**
   * 保存。只接受已知字段，避免前端传垃圾把配置写坏。
   * 打码值自动还原成旧的真值。
   */
  save(next) {
    const base = defaultConfig();
    const merged = {
      ...base,
      ...this.cfg,
      ...next,
      on: { ...base.on, ...this.cfg.on, ...(next.on || {}) },
      quiet: { ...base.quiet, ...this.cfg.quiet, ...(next.quiet || {}) },
    };

    // 打码值回传时要把原密钥补回去：前端看到的是 "abc••••xyz"，
    // 若原样保存就把真 key 覆盖成打码串了，用户再也收不到推送。
    if (Array.isArray(next.channels)) {
      const cur = this.cfg.channels || [];
      merged.channels = next.channels.map((c) => {
        const old = cur.find((x) => x.id === c.id);
        const fix = (v, prev) => (isMasked(v) ? prev || "" : v);
        return { ...c, key: fix(c.key, old?.key), token: fix(c.token, old?.token) };
      });
    }

    merged.channels = (merged.channels || [])
      .map(normalizeChannel)
      .filter(isUsableChannel);

    this.cfg = merged;
    try {
      fs.writeFileSync(this.file, JSON.stringify(merged, null, 2), { mode: 0o600 });
    } catch (e) {
      // 写不进去不该让整个保存流程失败：内存里已经生效，下次重启会丢
      console.error(`[push] 写配置失败: ${e.message}`);
    }
    return merged;
  }

  /** 给前端看的版本：密钥打码 */
  publicConfig(extra = {}) {
    return {
      ...this.cfg,
      channels: (this.cfg.channels || []).map((c) => ({
        ...c,
        key: mask(c.key),
        token: mask(c.token),
      })),
      ...extra,
    };
  }
}

module.exports = { PushConfigStore, defaultConfig, mask, isMasked };
