#!/usr/bin/env node
/**
 * 排队条「单条删除」回归测试（手机端为主）
 *
 * 背景：旧版排队条每条只有一个「撤销」按钮，一次点击就直接删。
 * 手机上按钮小、手指宽，误触就把还在排队的消息删了，且不可恢复。
 * 现在改成：✕ → 「确认删除」（变红实心，5 秒不点自动退回）→ 再点才真删。
 *
 * 本测试不依赖真实忙会话：用 page.route 拦截 session/list 与 updateQueue，
 * 造一个带 3 条排队消息的会话，验证
 *  1. 每条都有独立的 ✕ 按钮
 *  2. 第一次点只进确认态，不发任何 RPC
 *  3. 点另一条时确认态互斥转移（不会同时两条带确认态）
 *  4. 5 秒不点自动退回，不会误删
 *  5. 第二次点才发 updateQueue，itemId 正确、action 是 remove
 *  6. 删除后本地立即摘掉该条（不等轮询），其余顺序不变
 *  7. 轮询刷新不会打断正在进行的确认态
 *  8. 长消息可展开 / 收起
 *  9. 手机视口下按钮可点面积 >= 30px，无横向溢出
 *
 * 用法：node test/test-queue-del.js
 */
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const BASE = process.env.BASE || "http://127.0.0.1:8760";
const APP_DIR = path.resolve(__dirname, "..");
const PASS = fs.readFileSync(path.join(APP_DIR, ".passphrase"), "utf8").trim();

let pass = 0, fail = 0;
function ok(c, n, x = "") {
  if (c) { pass++; console.log(`  ✓ ${n}`); }
  else { fail++; console.log(`  ✗ ${n}${x ? " — " + x : ""}`); }
}

const SID = "session-mock-queuedel";
const LONG = "QDEL-长消息-" + "内容".repeat(40);
const mockSession = {
  sessionId: SID,
  running: true,
  cwd: "/tmp",
  updatedAt: Date.now(),
  projections: { values: {
    title: "排队删除自测",
    inbox: {
      "next-turn": [
        { id: "qi-1", source: { kind: "user" }, content: [{ type: "text", text: "QDEL-第一条" }] },
        { id: "qi-2", source: { kind: "user" }, content: [{ type: "text", text: LONG }] },
        { id: "qi-3", source: { kind: "user" }, content: [{ type: "text", text: "QDEL-第三条" }] },
      ],
      "next-step": [],
    },
  } },
};

(async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: false });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });

  const queueCalls = [];   // 捕获 updateQueue 请求体
  let inboxOverride = null; // 允许测试内部改写返回的 inbox（模拟已经删掉）

  await page.route("**/rpc/session/list", async (route) => {
    const s = JSON.parse(JSON.stringify(mockSession));
    if (inboxOverride) s.projections.values.inbox = inboxOverride;
    await route.fulfill({ json: { ok: true, value: { items: [s] } } });
  });
  await page.route("**/rpc/session/updateQueue", async (route) => {
    let body = {};
    try { body = JSON.parse(route.request().postData() || "{}"); } catch {}
    queueCalls.push(body);
    await route.fulfill({ json: { ok: true, value: { accepted: true } } });
  });

  // ---- 登录 ----
  console.log("\n[1] 登录并载入 mock 会话");
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  if (await page.locator("#pw").count()) {
    await page.fill("#pw", PASS);
    await page.click("#go");
    await page.waitForLoadState("networkidle");
  }
  await page.waitForTimeout(1200);
  ok(errors.length === 0, "页面加载无异常", errors.slice(0, 2).join(" | "));

  // 打开 mock 会话（不调 openSession，避免走 follow 真流）
  await page.evaluate((sid) => {
    state.sessions = state.sessions.filter((x) => x.sessionId === sid);
    state.sessionId = sid;
    qbarExpanded.clear(); qbarSig = ""; disarmQueueDel();
    toggleDrawer(false); // 手机视口下抽屉遮罩会挡住排队条
    renderQueueBar();
  }, SID);
  await page.waitForTimeout(300);

  const barVisible = await page.locator("#queue-bar").isVisible();
  ok(barVisible, "排队条出现");
  const nItems = await page.locator("#queue-bar .qitem").count();
  ok(nItems === 3, `渲染 3 条（实际 ${nItems}）`);
  const nDel = await page.locator('#queue-bar button[data-act="remove"]').count();
  ok(nDel === 3, `每条都有独立删除按钮（实际 ${nDel} 个）`);

  console.log("\n[2] 第一次点 ✕ 只进入确认态，不发 RPC");
  const item2 = page.locator("#queue-bar .qitem", { hasText: "QDEL-长消息" }).first();
  await item2.locator('button[data-act="remove"]').click();
  await page.waitForTimeout(250);
  const btnText = (await item2.locator('button[data-act="remove"]').innerText()).trim();
  ok(btnText === "确认删除", `按钮文案变为「确认删除」（实际「${btnText}」）`);
  ok(await item2.locator('button[data-act="remove"]').evaluate((b) => b.classList.contains("armed")), "按钮进入 armed 高亮态");
  ok(queueCalls.length === 0, "未发出任何删除请求", JSON.stringify(queueCalls));

  console.log("\n[3] 点另一条时确认态互斥转移");
  const item3 = page.locator("#queue-bar .qitem", { hasText: "QDEL-第三条" }).first();
  await item3.locator('button[data-act="remove"]').click();
  await page.waitForTimeout(250);
  ok(
    (await item2.locator('button[data-act="remove"]').innerText()).trim() === "✕",
    "上一条恢复为 ✕"
  );
  ok(
    (await item3.locator('button[data-act="remove"]').innerText()).trim() === "确认删除",
    "新点的那条进入确认态"
  );
  const armedCount = await page.locator("#queue-bar .qact-del.armed").count();
  ok(armedCount === 1, `同时只有 1 条处于确认态（实际 ${armedCount}）`);
  ok(queueCalls.length === 0, "仍未发出删除请求");

  console.log("\n[4] 轮询刷新不打断确认态");
  await page.evaluate(() => renderQueueBar()); // 同数据重绘，指纹未变
  await page.waitForTimeout(200);
  ok(
    (await item3.locator('button[data-act="remove"]').innerText()).trim() === "确认删除",
    "同数据刷新后确认态保留"
  );
  ok(queueCalls.length === 0, "刷新不触发删除");

  console.log("\n[5] 5 秒不点自动退回，不会误删");
  await page.waitForTimeout(5300);
  const afterTimeout = (await item3.locator('button[data-act="remove"]').innerText()).trim();
  ok(afterTimeout === "✕", `超时后恢复为 ✕（实际「${afterTimeout}」）`);
  ok(queueCalls.length === 0, "超时未发删除请求");
  ok((await page.locator("#queue-bar .qitem").count()) === 3, "3 条都还在");

  console.log("\n[6] 长消息可展开 / 收起（真删之前测，删的正是那条长消息）");
  const hasToggle = await page.locator('#queue-bar .qmore[data-act="toggle"]').count();
  ok(hasToggle >= 1, `长消息带「展开」（共 ${hasToggle} 个）`);
  if (hasToggle >= 1) {
    const toggle = page.locator('#queue-bar .qmore[data-act="toggle"]').first();
    await toggle.click();
    await page.waitForTimeout(200);
    ok((await toggle.innerText()).trim() === "收起", "点击后变为「收起」");
    ok(
      await page.locator("#queue-bar .qtext.open").count() === 1,
      "对应文本进入展开态（不限两行）"
    );
    await toggle.click();
    await page.waitForTimeout(200);
    ok(await page.locator("#queue-bar .qtext.open").count() === 0, "再点收起");
  }

  console.log("\n[7] 两次点才真删，请求参数正确");
  await item2.locator('button[data-act="remove"]').click();
  await page.waitForTimeout(150);
  await item2.locator('button[data-act="remove"]').click();
  await page.waitForTimeout(500);
  ok(queueCalls.length === 1, `发出 1 次 updateQueue（实际 ${queueCalls.length}）`);
  const req = queueCalls[0]?.args?.request;
  ok(req?.itemId === "qi-2", `itemId 正确（实际 ${req?.itemId}）`);
  ok(req?.action?.kind === "remove", `action 为 remove（实际 ${req?.action?.kind}）`);
  ok(req?.sessionId === SID, "sessionId 正确");

  console.log("\n[8] 删除后本地立即摘掉，其余顺序不变");
  const left = await page.locator("#queue-bar .qtext").allInnerTexts();
  ok(left.length === 2, `剩 2 条（实际 ${left.length}）`);
  ok(!left.some((t) => t.includes("QDEL-长消息")), "被删的那条已消失");
  ok(left[0].includes("QDEL-第一条") && left[1].includes("QDEL-第三条"), "顺序保持 一→三", JSON.stringify(left.map((t) => t.slice(0, 12))));
  ok((await page.locator("#queue-bar .qcount").innerText()).trim() === "2", "条数徽标同步为 2");

  console.log("\n[9] 服务端快照滞后时被删的条目不闪回");
  await page.evaluate(() => refreshSessions()); // mock 仍返回 3 条（服务端未跟上）
  await page.waitForTimeout(400);
  ok(
    (await page.locator("#queue-bar .qitem").count()) === 2,
    "轮询后仍是 2 条，被删的没闪回"
  );


  console.log("\n[10] 手机视口可点面积与溢出");
  const sizes = await page.locator('#queue-bar button[data-act="remove"]').evaluateAll((els) =>
    els.map((e) => { const r = e.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; })
  );
  ok(sizes.every((s) => s.h >= 30 && s.w >= 30), "删除按钮可点区 >= 30×30", JSON.stringify(sizes));
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok(overflow <= 1, `无横向溢出（溢出 ${overflow}px）`);

  console.log("\n[11] 无 JS 异常");
  ok(errors.length === 0, "页面无报错", errors.slice(0, 3).join(" | "));

  console.log(`\n${"=".repeat(46)}\n通过 ${pass} 项，失败 ${fail} 项\n`);
  await browser.close();
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("\n测试崩溃:", e); process.exit(2); });
