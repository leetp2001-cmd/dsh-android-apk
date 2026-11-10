#!/usr/bin/env node
/**
 * 会话列表分页回归（默认只加载 20 条，滚到底再加载下一批）
 * 覆盖：
 *  1) 服务端默认只回 20 条 + meta 分页字段正确
 *  2) limit 递增拿到更多，limit=0 拿全部
 *  3) 当前会话（pin）即使在第 21 条之后也会被补进这一页，且不占用 consumed
 *  4) 子代理会话不进列表（否则"加载 20 条只看到 12 条"）
 *  5) 前端首屏只渲染 20 条 + 出现「加载更多」
 *  6) 点「加载更多」→ 40 条
 *  7) 滚到底自动加载
 *  8) 搜索时自动拉全量（否则搜不到未加载的老会话），清空后回到 20 条
 *  9) 手机视口无横向溢出、零 JS 异常
 *
 * 用法：NODE_PATH=<playwright> node test/test-list-page20.js
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const APP = path.resolve(__dirname, "..");
const PASS = fs.readFileSync(path.join(APP, ".passphrase"), "utf8").trim();
const BASE = process.env.BASE || "http://127.0.0.1:8760";
const DAY = 86400000;

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log("  ✓ " + label); }
  else { fail++; console.log("  ✗ " + label + (extra ? "  → " + extra : "")); }
}

// ---------- 1. 服务端 ----------
async function serverSide() {
  console.log("\n[1] 服务端：默认 20 条分页");
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
  const m = d.value.appListMeta;
  ok(m?.limit === 20, `默认 limit=20（实际 ${m?.limit}）`);
  ok(d.value.items.length === 20, `默认只回 20 条（实际 ${d.value.items.length}）`);
  ok(m?.hasMore === true, "还有更多（hasMore=true）");
  ok(m?.kept > 20, `14 天窗口内 ${m?.kept} 个，确实超过一页`);
  ok(m?.consumed === 20 && m?.nextOffset === 20, `consumed/nextOffset 正确（${m?.consumed}/${m?.nextOffset}）`);

  // 条数太少时不该谎报 hasMore
  const one = await call({ limit: 1 });
  ok(one.value.items.length === 1, `limit=1 只回 1 条（实际 ${one.value.items.length}）`);
  ok(one.value.appListMeta.hasMore === true, "limit=1 时 hasMore=true");

  const all = await call({ limit: 0 });
  ok(all.value.items.length === all.value.appListMeta.kept, `limit=0 回全集（${all.value.items.length}）`);
  ok(all.value.appListMeta.hasMore === false, "limit=0 时 hasMore=false（不再提示加载更多）");

  const big = await call({ limit: 100000 });
  ok(big.value.items.length === all.value.items.length, "超大 limit 等于全集，不越界");

  // 分页不能改变顺序：前 40 条的前 20 条 == 前 20 条
  const p20 = (await call({ limit: 20 })).value.items.map((x) => x.sessionId);
  const p40 = (await call({ limit: 40 })).value.items.map((x) => x.sessionId);
  ok(p20.every((id, i) => p40[i] === id), "前 20 条顺序与 limit=40 时一致（分页稳定）");
  ok(new Set(p40).size === p40.length, "没有重复条目");

  // 子代理会话必须被剔掉
  const subs = all.value.items.filter((x) => x.origin === "subagent" || x.parentSessionId);
  ok(subs.length === 0, `列表里没有子代理会话（${subs.length} 条）`);

  // pin：把第 60 条的 id 当当前会话，limit=20 时它必须出现，且 consumed 仍是 20
  const target = all.value.items[60]?.sessionId;
  if (target) {
    const pinned = await call({ limit: 20, pin: target });
    const has = pinned.value.items.some((x) => x.sessionId === target);
    ok(has, "当前会话不在第一页时被补进来（否则排队条/自愈静默失效）");
    const p = pinned.value.items.find((x) => x.sessionId === target);
    ok(p?.__pinned === true, "被补进来的条目带 __pinned 标记");
    ok(pinned.value.appListMeta.consumed === 20,
      `补 pin 不占用分页计数（consumed=${pinned.value.appListMeta.consumed}）`);
  } else {
    ok(true, "会话数不足 61 条，跳过 pin 用例");
  }

  // _app 私有参数不能透给 dsh
  ok(d.ok === true && all.ok === true, "_app 私有参数未导致 dsh 报错");
  return { kept: all.value.appListMeta.kept };
}

// ---------- 2. 前端 ----------
function mockSessions(n) {
  const now = Date.now();
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      sessionId: "m-" + i,
      cwd: "/tmp/page",
      running: false,
      blank: false,
      origin: "user",
      parentSessionId: null,
      // 全部塞在今天，方便断言"就是前 N 条"
      updatedAt: now - i * 60000,
      projections: { values: { title: "会话 " + i, inbox: { "next-turn": [], "next-step": [] } } },
    });
  }
  return out;
}

async function frontend() {
  console.log("\n[2] 前端：首屏 20 条 + 加载更多");
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") errs.push("console: " + m.text()); });

  const ALL = mockSessions(120);
  const reqs = []; // { days, limit }

  await page.route("**/rpc/session/list", async (route) => {
    const app = route.request().postDataJSON()?.args?._app || {};
    const limit = app.limit === undefined ? 20 : app.limit;
    reqs.push({ limit });
    const kept = ALL; // 不按时间裁剪，只分页
    const items = limit > 0 ? kept.slice(0, limit) : kept.slice();
    await route.fulfill({
      json: {
        ok: true,
        value: {
          items,
          appListMeta: {
            total: ALL.length, kept: kept.length, offset: 0, limit, pageSize: 20,
            shown: items.length, consumed: items.length,
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

  ok(reqs[0]?.limit === 20, `首屏请求 limit=20（实际 ${JSON.stringify(reqs[0])}）`);
  let n = await page.locator("#session-list .sess").count();
  ok(n === 20, `首屏只渲染 20 条（实际 ${n}）`);

  const more = page.locator("#list-more button");
  ok(await more.count() === 1, "出现「加载更多」按钮");
  const moreTxt = (await more.innerText()).replace(/\s+/g, " ");
  ok(/还有\s*100/.test(moreTxt), `按钮标注剩余数量（"${moreTxt}"）`);

  const foot = (await page.locator("#list-foot").innerText()).replace(/\s+/g, " ");
  ok(/20\/120/.test(foot), `底部条显示 已加载/总数（"${foot}"）`);

  console.log("\n[3] 点「加载更多」→ 40 条");
  await more.click();
  await page.waitForTimeout(700);
  n = await page.locator("#session-list .sess").count();
  ok(n === 40, `加载后 40 条（实际 ${n}）`);
  ok(reqs.some((r) => r.limit === 40), `请求带了 limit=40（实际 ${JSON.stringify(reqs.map((r) => r.limit))}）`);
  const titles = await page.locator("#session-list .sess .t").allInnerTexts();
  ok(titles[0] === "会话 0" && titles[39] === "会话 39", "顺序稳定、无重复无跳条");
  ok(new Set(titles).size === 40, "40 条互不重复");

  console.log("\n[4] 滚到底自动加载");
  const before = n;
  await page.evaluate(() => {
    const box = document.getElementById("session-list");
    listScrollQuietUntil = 0; // 模拟真用户：静默期已过
    box.scrollTop = box.scrollHeight;
    box.dispatchEvent(new Event("scroll"));
  });
  await page.waitForTimeout(800);
  n = await page.locator("#session-list .sess").count();
  ok(n > before, `滚动到底自动加载（${before} → ${n}）`);

  console.log("\n[4b] 点一次「加载更多」只翻一页（不连环翻）");
  const beforeWant = await page.evaluate(() => state.listWant);
  const reqBefore = reqs.length;
  await page.locator("#list-more button").click();
  await page.waitForTimeout(1000);
  const afterWant = await page.evaluate(() => state.listWant);
  ok(afterWant === beforeWant + 20, `只涨一页（want ${beforeWant} → ${afterWant}）`);
  ok(reqs.length - reqBefore <= 2, `请求数没爆（${reqs.length - reqBefore} 次）`);

  console.log("\n[5] 搜索自动拉全量");
  // 前面的"滚到底"用例可能已经把窗口拉大了，先复位，才能验证"搜索触发全量"
  await page.evaluate(() => { state.listWant = 20; state.listAllForSearch = false; return refreshSessions(); });
  await page.waitForTimeout(600);
  const reqBeforeSearch = reqs.length;
  await page.fill("#search", "会话 11");
  await page.waitForTimeout(900);
  const searchReqs = reqs.slice(reqBeforeSearch);
  ok(searchReqs.some((r) => r.limit === 0), `搜索时请求 limit=0（全量）：${JSON.stringify(searchReqs.map((r) => r.limit))}`);
  const hit = await page.locator("#session-list .sess .t").allInnerTexts();
  ok(hit.length >= 11, `命中 11 个及以后的老会话（实际 ${hit.length}）`);
  ok(hit.includes("会话 119"), "能搜到第 120 条（超出首屏的部分）");

  await page.fill("#search", "");
  await page.waitForTimeout(900);
  n = await page.locator("#session-list .sess").count();
  ok(n === 20, `清空搜索后回到 20 条（实际 ${n}）`);

  console.log("\n[6] 全部滚到底后按钮消失");
  await page.evaluate(() => {
    // 直接把窗口拉到全部，模拟一路滚到底
    state.listWant = 0;
    return refreshSessions();
  });
  await page.waitForTimeout(700);
  n = await page.locator("#session-list .sess").count();
  ok(n === 120, `全量渲染 120 条（实际 ${n}）`);
  ok(await page.locator("#list-more").count() === 0, "到底后不再显示「加载更多」");

  console.log("\n[7] 手机视口");
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok(overflow <= 1, `无横向溢出（${overflow}px）`);

  console.log("\n[8] 无 JS 异常");
  ok(errs.length === 0, `零异常（${errs.length}）`, errs.slice(0, 3).join(" | "));

  await page.screenshot({ path: "/tmp/list-page20.png" });
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
