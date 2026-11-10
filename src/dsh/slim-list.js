"use strict";
/**
 * session/list 瘦身 + 分页。
 *
 * ## 为什么要裁
 * dsh 返回每个会话全部 21 个投影（turnOutline / imageLimits / modelSelection /
 * tokenUsage …），587 个会话合计 1.26 MB。手机端只用得上 title + inbox，
 * 其余占 96%。公网快速隧道 ~40KB/s，原样透传要 30 秒，期间前端连骨架屏都
 * 不显示 → 表现为"会话不见了"。所以在代理层裁掉无用投影。
 *
 * ## 为什么不按时间裁
 * 历史会话一律保留，靠分页解决"一次拉太多"的问题。
 * 手机侧栏一屏就十来条，一次下发/渲染几百条纯浪费时间：默认第一页 20 条
 * （DSH_APP_LIST_PAGE，0 = 不分页），前端滚到底再要下一批。
 */

/** 默认页大小。DSH_APP_LIST_PAGE=0 表示不分页（一次给全）。 */
const LIST_PAGE = (() => {
  const n = Number(process.env.DSH_APP_LIST_PAGE);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 20;
})();

/** 是否启用瘦身。DSH_APP_SLIM=0 可整体关掉（排查问题用）。 */
const SLIM_ENABLED = process.env.DSH_APP_SLIM !== "0";

/** 只保留前端真正读的投影 */
function pickProjections(s) {
  const v = s?.projections?.values;
  return { values: { title: v?.title, inbox: v?.inbox } };
}

/** 会话行只保留手机端用得到的字段 */
function pickSession(s) {
  return {
    sessionId: s.sessionId,
    cwd: s.cwd,
    updatedAt: s.updatedAt,
    running: s.running,
    blank: s.blank,
    origin: s.origin,
    parentSessionId: s.parentSessionId,
    agentAvailable: s.agentAvailable,
    projections: pickProjections(s),
  };
}

/** 子代理会话在手机端打不开（dsh 要求经父会话地址访问），列表里先剔掉 */
function isOpenable(s, pinId) {
  if (pinId && s.sessionId === pinId) return true;
  return !(s.origin === "subagent" || s.parentSessionId);
}

function positiveInt(v, fallback) {
  if (v === undefined || v === null) return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

/**
 * 对 session/list 的结果做瘦身 + 切片 + pin 补偿。
 *
 * @param {object} result dsh 原始 result（{ok:true, value:{items:[…]}}）
 * @param {object} opts   { limit, offset, pin } —— 由前端私有参数 _app 传进来
 * @returns {object} 结构不变，但 items 变少、并多一个 appListMeta
 */
function slimSessionList(result, opts = {}) {
  if (!result || result.ok !== true || !result.value || !Array.isArray(result.value.items)) {
    return result;
  }

  const limit = positiveInt(opts.limit, LIST_PAGE);
  const rawOffset = positiveInt(opts.offset, 0);
  const offset = rawOffset > 0 ? rawOffset : 0;
  const pinId = typeof opts.pin === "string" && opts.pin ? opts.pin : "";

  // 先剔子代理再分页，否则"加载 20 条只看到 12 条"。当前正在看的会话例外。
  const all = result.value.items.filter((s) => isOpenable(s, pinId)).map(pickSession);

  // 保持 dsh 原有顺序（活跃度倒序），只切片，绝不重排 ——
  // 重排会让"今天/昨天"分组的日期标题乱序。
  const kept = all;

  const page = limit > 0 ? kept.slice(offset, offset + limit) : kept.slice(offset);
  // consumed = 真正从列表里切出来的条数（不含后面补的 pin），下一批的 offset
  // 必须用它算，否则每次多补一条当前会话就会导致下一批跳过一条。
  const consumed = page.length;
  const hasMore = limit > 0 && offset + consumed < kept.length;
  const nextOffset = offset + consumed;

  // 当前会话若落在这一页之外（用户正在看一个很老的会话），补到页尾，
  // 否则前端"按 sessionId 找会话"会失败 → 排队条、标题、回前台自愈全部静默失效。
  if (pinId && !page.some((s) => s.sessionId === pinId)) {
    const hit = kept.find((s) => s.sessionId === pinId);
    if (hit) page.push({ ...hit, __pinned: true });
  }

  const oldestKept = page.reduce(
    (m, s) => (s.updatedAt && (!m || s.updatedAt < m) ? s.updatedAt : m),
    null
  );

  return {
    ...result,
    value: {
      ...result.value,
      items: page,
      // 前端用它渲染"已显示 x/y"、判断还有没有下一批
      appListMeta: {
        total: all.length,
        kept: kept.length,
        // limit 是本次请求的窗口大小，pageSize 是服务端默认页大小
        // （前端翻页步长用这个，否则每次把"当前 limit"再加一个 limit，会指数式一把拉全）
        offset,
        limit,
        pageSize: LIST_PAGE,
        shown: page.length,
        consumed,
        nextOffset,
        hasMore,
        oldestKept,
      },
    },
  };
}

module.exports = { slimSessionList, SLIM_ENABLED, LIST_PAGE };
