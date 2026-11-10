#!/usr/bin/env node
/**
 * 会话列表「不裁剪历史」+ 日期分组回归
 * 背景：曾经按 14 天窗口裁剪列表（为了省流量），后改为只靠分页解决，
 * 历史会话一律保留。本测试锁死这个决策，防止窗口逻辑被重新引入。
 *
 * 覆盖：
 *  1) 服务端不再按时间裁剪：老会话（40 天/90 天前）照样返回
 *  2) 服务端仍按页切：默认 20 条，limit=0 拿全集
 *  3) meta 里不再有 days 字段
 *  4) 前端底部条只有统计（已加载/总数），没有时间窗切换按钮
 *  5) 日期分组标题 + 单日大组默认折叠 / 可展开 / 搜索自动展开
 *  6) 当前会话所在大组强制展开
 *  7) 手机视口无横向溢出、无 JS 异常
 *
 * 用法：NODE_PATH=<playwright> node test/test-list-window.js
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const APP = path.resolve(__dirname, "..");
const PASS = fs.readFileSync(path.join(APP, ".passphrase"), "utf8").trim();
const BASE = process.env.BASE || "http://127.0.0.1:8760";

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log("  ✓ " + label); }
  else { fail++; console.log("  ✗ " + label + (extra ? "  → " + extra : "")); }
}
const DAY = 86400000;

// ---------- 1. 服务端：不裁剪 + 仍分页 ----------
async function serverSide() {
  console.log("\n[1] 服务端：历史会话不裁剪、只分页");
  const auth = await fetch(BASE + "/auth", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ passphrase: PASS }),
  });
  ok(auth.ok, "/auth 成功");
  const ck = auth.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");

  const call = async (app) => {
    const r = await fetch(BASE + "/rpc/session/list", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: ck },
      body: JSON.stringify({ args: { _request: {}, _app: app } }),
    });
    return r.json();
  };

  const d = await call({});
  ok(d.ok === true, "session/list 返回 ok");
  const meta = d.value.appListMeta;
  ok(!!meta, "带回 appListMeta");
  ok(meta && !("days" in meta), `meta 里不再有 days（实际 ${JSON.stringify(Object.keys(meta || {}))}）`);
  ok(meta?.limit === 20, `默认分页 20 条（实际 limit=${meta?.limit}）`);
  ok(d.value.items.length === 20, `默认只回 20 条（实际 ${d.value.items.length}）`);
  ok(meta?.total === meta?.kept, `不裁剪：total == kept（${meta?.total} / ${meta?.kept}）`);

  // 全集里必须存在 30 天以上的老会话，且一条都没被过滤掉
  const all = await call({ limit: 0 });
  const items = all.value.items;
  ok(items.length === all.value.appListMeta.total,
    `limit=0 返回全部（${items.length}）`);
  const cutoff30 = Date.now() - 30 * DAY;
  const oldOnes = items.filter((s) => s.updatedAt && s.updatedAt < cutoff30);
  ok(oldOnes.length > 0,
    `30 天以上的老会话仍在列表里（${oldOnes.length} 条）`,
    "若为 0 说明时间窗又被加回来了");

  // 明确带 days 参数（旧前端缓存可能还发）也不能被裁掉 —— 代理层已忽略 days
  const withDays = await call({ days: 14, limit: 0 });
  ok(withDays.value.items.length === items.length,
    `请求带 days=14 也不裁剪（${withDays.value.items.length} vs ${items.length}）`);

  // 顺序仍由 dsh 决定（活跃度倒序），分页不得重排
  const desc = items.every((s, i) => i === 0 || (items[i - 1].updatedAt || 0) >= (s.updatedAt || 0));
  ok(desc, "整体按 updatedAt 倒序（不重排）");

  // 瘦身仍在生效
  const first = items[0];
  if (first) {
    const pk = Object.keys(first.projections?.values || {});
    ok(pk.length <= 2 && pk.every((k) => k === "title" || k === "inbox"),
      `投影仍只保留 title/inbox（实际 ${pk.join(",")}）`);
  }
  return { total: items.length };
}

// ---------- 2. 前端 ----------
function mockSessions() {
  const now = Date.now();
  const mk = (id, title, ageDays, extra = {}) => ({
    sessionId: id, cwd: "/home/user/projects/demo", running: false,
    updatedAt: now - ageDays * DAY, origin: "user", parentSessionId: null,
    projections: { values: { title, inbox: { "next-turn": [], "next-step": [] } } },
    ...extra,
  });
  return [
    mk("s-today", "今天的会话", 0.1),
    mk("s-yest", "昨天的会话", 1.2),
    mk("s-d3", "三天前的会话", 3.3),
    mk("s-d10", "十天前的会话", 10.4),
    mk("s-d40", "四十天前的会话", 40),
    mk("s-d90", "九十天前的会话", 90),
  ];
}

async function frontend() {
  console.log("\n[2] 前端：老会话照常显示、底部条无时间窗开关");
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") errs.push("console: " + m.text()); });

  const ALL = mockSessions();
  const seenApps = []; // 记录前端实际发的 _app

  await page.route("**/rpc/session/list", async (route) => {
    const app = route.request().postDataJSON()?.args?._app || {};
    seenApps.push(app);
    const limit = app.limit === undefined ? 20 : app.limit; // 与 server.js 默认值一致
    const kept = ALL; // 不裁剪
    const items = limit > 0 ? kept.slice(0, limit) : kept.slice();
    if (app.pin && !items.some((x) => x.sessionId === app.pin)) {
      const hit = kept.find((x) => x.sessionId === app.pin);
      if (hit) items.push({ ...hit, __pinned: true });
    }
    await route.fulfill({
      json: {
        ok: true,
        value: {
          items,
          appListMeta: {
            total: ALL.length, kept: kept.length, offset: 0, limit, pageSize: 20,
            shown: items.length, consumed: Math.min(limit || kept.length, kept.length),
            hasMore: limit > 0 && items.length < kept.length,
            oldestKept: null,
          },
        },
      },
    });
  });

  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  if (await page.locator("#pw").count()) {
    await page.fill("#pw", PASS); await page.click("#go");
    await page.waitForLoadState("networkidle");
  }
  await page.waitForFunction(() => typeof state !== "undefined" && state.sessionsLoaded, null, { timeout: 20000 });
  await page.waitForTimeout(300);

  ok(!("days" in (seenApps[0] || {})), `请求不再带 days（实际 ${JSON.stringify(seenApps[0])}）`);
  ok(seenApps[0]?.limit === 20, `首屏仍按 20 条分页（limit=${seenApps[0]?.limit}）`);

  const titles = await page.locator("#session-list .sess .t").allInnerTexts();
  ok(titles.includes("四十天前的会话"), "40 天前的会话显示出来了（未被裁剪）");
  ok(titles.includes("九十天前的会话"), "90 天前的会话显示出来了");
  ok(titles.length === 6, `6 条全部显示（实际 ${titles.length}）`);

  const foot = page.locator("#list-foot");
  ok(await foot.count() === 1, "底部条存在");
  const footText = (await foot.innerText()).replace(/\s+/g, " ");
  ok(!footText.includes("天"), `底部条不再提时间窗（"${footText}"）`);
  ok(/6\s*个/.test(footText), `底部条显示会话数（"${footText}"）`);
  ok(await foot.locator("button").count() === 0, "底部条没有时间窗切换按钮");

  // localStorage 里旧的时间窗选择应该不再影响行为
  await page.evaluate(() => localStorage.setItem("dshapp.listDays", "14"));
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => typeof state !== "undefined" && state.sessionsLoaded, null, { timeout: 20000 });
  await page.waitForTimeout(300);
  const afterReload = await page.locator("#session-list .sess .t").allInnerTexts();
  ok(afterReload.includes("四十天前的会话"),
    "旧缓存里的 listDays=14 不再影响列表（老会话照常显示）");
  await page.evaluate(() => localStorage.removeItem("dshapp.listDays"));

  console.log("\n[3] 日期分组标题");
  const groups = (await page.locator("#session-list .dgroup").allInnerTexts())
    .map((t) => t.replace(/\s+/g, " ").trim());
  ok(groups.length >= 2, `有分组标题（${JSON.stringify(groups)}）`);
  ok(groups[0].startsWith("今天"), `第一组是「今天」（实际「${groups[0]}」）`);
  ok(groups.some((g) => g.startsWith("昨天")), "含「昨天」");
  ok(groups.every((g) => /\d/.test(g)), "每组都带会话数", JSON.stringify(groups));

  console.log("\n[4] 手机视口布局");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok(overflow <= 1, `无横向溢出（${overflow}px）`);

  console.log("\n[5] 单日大会话组默认折叠，可展开");
  const foldInfo = await page.evaluate(() => {
    const now = Date.now();
    const big = [];
    for (let i = 0; i < 60; i++) {
      big.push({
        sessionId: "big-" + i, cwd: "/tmp/big", running: false, origin: "user",
        parentSessionId: null, updatedAt: now - 3 * 86400000 - i * 1000,
        projections: { values: { title: "批量会话 " + i, inbox: { "next-turn": [], "next-step": [] } } },
      });
    }
    state.sessions = big;
    state.sessionId = null;
    state.listMeta = { total: 60, kept: 60, oldestKept: null };
    renderSessions();
    const h = document.querySelector("#session-list .dgroup");
    return {
      foldable: h?.classList.contains("foldable"),
      headerText: h?.innerText.replace(/\s+/g, " "),
      rendered: document.querySelectorAll("#session-list .sess").length,
    };
  });
  ok(foldInfo.foldable, "大组标题标记为可折叠");
  ok(/60/.test(foldInfo.headerText || ""), `标题显示条数（"${foldInfo.headerText}"）`);
  ok(foldInfo.rendered === 0, `默认折叠不渲染条目（实际 ${foldInfo.rendered}）`);
  const footCollapsed = (await page.locator("#list-foot").innerText()).replace(/\s+/g, " ");
  ok(footCollapsed.includes("已展开 0"), `折叠时底部条标注已渲染数（"${footCollapsed}"）`);

  await page.locator("#session-list .dgroup").first().click();
  await page.waitForTimeout(250);
  const afterExpand = await page.evaluate(() => document.querySelectorAll("#session-list .sess").length);
  ok(afterExpand === 60, `点开渲染 60 条（实际 ${afterExpand}）`);
  const footAfter = (await page.locator("#list-foot").innerText()).replace(/\s+/g, " ");
  ok(!footAfter.includes("已展开"), `全部展开后不再标注折叠数（"${footAfter}"）`);

  // 搜索时应无视折叠
  await page.click("#session-list .dgroup").catch(() => {});
  await page.waitForTimeout(200);
  await page.fill("#search", "批量会话 5");
  await page.waitForTimeout(400);
  const searched = await page.evaluate(() => document.querySelectorAll("#session-list .sess").length);
  ok(searched > 0, `搜索时自动展开（命中 ${searched} 条）`);
  await page.fill("#search", "");
  await page.waitForTimeout(300);

  console.log("\n[6] 当前打开会话所在大组强制展开");
  const activeGroup = await page.evaluate(() => {
    const now = Date.now();
    const big = [];
    for (let i = 0; i < 60; i++) {
      big.push({
        sessionId: "big-" + i, cwd: "/tmp/big", running: false, origin: "user",
        parentSessionId: null, updatedAt: now - 3 * 86400000 - i * 1000,
        projections: { values: { title: "批量会话 " + i, inbox: { "next-turn": [], "next-step": [] } } },
      });
    }
    state.sessions = big;
    state.sessionId = "big-7";
    lgroupExpanded.clear();
    renderSessions();
    return {
      rendered: document.querySelectorAll("#session-list .sess").length,
      activeShown: !!document.querySelector("#session-list .sess.active"),
    };
  });
  ok(activeGroup.rendered === 60, `当前会话所在组自动展开（渲染 ${activeGroup.rendered}）`);
  ok(activeGroup.activeShown, "当前会话在列表里可见（不会一刷新就消失）");

  console.log("\n[7] 无 JS 异常");
  ok(errs.length === 0, `零异常（${errs.length}）`, errs.slice(0, 3).join(" | "));

  await page.screenshot({ path: "/tmp/list-window.png" });
  await browser.close();
}

(async () => {
  try {
    await serverSide();
    await frontend();
  } catch (e) {
    fail++;
    console.log("\n✗ 异常中断: " + e.stack);
  }
  console.log(`\n结果：${pass} 过 / ${fail} 挂`);
  process.exit(fail ? 1 : 0);
})();
