#!/usr/bin/env node
/**
 * 排队条回归测试
 *
 * 背景：dsh 的 queue 模式在会话忙时把消息放进 inbox，等当前 turn 结束才执行，
 * 且**没有超时**。实测出现过排队 35 分钟的情况。旧前端只在事件流里打一行
 * 「📨 已发送，排队等待…」，随后既不可见也不可撤销，用户看到的就是"发了没反应"。
 *
 * 本测试验证：
 *  1. 会话忙时发消息 → 排队条出现，条数正确，内容正确
 *  2. 排队条显示的顺序 = dsh inbox 的真实顺序
 *  3. 「撤销」能真正把消息从 inbox 移除
 *  4. 会话空闲时排队条自动隐藏
 *
 * 用法：node test/test-queue-bar.js
 * 需要 dsh-app 正在 8760 上跑（launchctl kickstart 后即可）
 */
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const os = require("os");

const BASE = process.env.BASE || "http://127.0.0.1:8760";
const APP_DIR = path.resolve(__dirname, "..");
const PASS = fs.readFileSync(path.join(APP_DIR, ".passphrase"), "utf8").trim();

let pass = 0, fail = 0;
function ok(cond, name, extra = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? " — " + extra : ""}`); }
}

(async () => {
  const browser = await chromium.launch({
    channel: "chrome",
    headless: true,
  });
  const ctx = await browser.newContext({ viewport: { width: 430, height: 900 } });
  const page = await ctx.newPage();

  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });

  // ---- 登录 ----
  console.log("\n[1] 登录");
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  if (await page.locator("#pw").count()) {
    await page.fill("#pw", PASS);
    await page.click("#go");
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(800);
  }
  await page.waitForTimeout(1500);
  ok(await page.locator("#session-list").count() === 1, "进入主界面");

  // ---- 造一个「忙」的会话：直接挑当前 running 的，没有就跳过 ----
  console.log("\n[2] 定位一个正在运行的会话");
  const running = await page.evaluate(async () => {
    const r = await fetch("/rpc/session/list", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ args: { _request: {} } }),
    });
    const j = await r.json();
    return (j.value?.items || []).filter((s) => s.running && !s.parentSessionId && s.origin !== "subagent");
  });

  if (!running.length) {
    console.log("  ⚠ 当前没有运行中的会话，跳过动态用例（静态结构检查仍执行）");
  } else {
    const s = running[0];
    console.log(`  目标会话: ${s.sessionId.slice(0, 24)} (${s.projections?.values?.title || "?"})`);

    // 打开该会话
    await page.evaluate((sid) => {
      const i = state.sessions.findIndex((x) => x.sessionId === sid);
      if (i >= 0) openSession(state.sessions[i]);
    }, s.sessionId);
    await page.waitForTimeout(1500);

    // ---- 发一条会排队的消息 ----
    const probe = "【排队条自测】这条消息不需要执行，稍后会被撤销 " + Date.now();
    console.log("\n[3] 在忙会话里发一条消息，应进入队列");
    await page.fill("#prompt", probe);
    await page.click("#send");
    await page.waitForTimeout(2500);

    const barVisible = await page.locator("#queue-bar").isVisible();
    ok(barVisible, "排队条出现");

    const barText = barVisible ? await page.locator("#queue-bar").innerText() : "";
    ok(barText.includes("待执行"), "排队条有「待执行」标头", barText.slice(0, 120));
    ok(barText.includes(probe.slice(0, 20)), "排队条里能看到刚发的内容", barText.slice(0, 160));

    const countText = await page.locator("#queue-bar .qcount").innerText().catch(() => "");
    ok(/^\d+$/.test(countText) && Number(countText) >= 1, `条数徽标正确 (=${countText})`);

    // ---- 核对顺序与 dsh inbox 一致 ----
    console.log("\n[4] 排队条顺序应与 dsh inbox 完全一致");
    const inboxOrder = await page.evaluate(async (sid) => {
      const r = await fetch("/rpc/session/list", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ args: { _request: {} } }),
      });
      const j = await r.json();
      const it = (j.value?.items || []).find((x) => x.sessionId === sid);
      const ib = it?.projections?.values?.inbox || {};
      return [...(ib["next-turn"] || []), ...(ib["next-step"] || [])]
        .filter((m) => (m.source?.kind || "user") === "user")
        .map((m) => (m.content || []).filter((p) => p.type === "text").map((p) => p.text).join("\n"));
    }, s.sessionId);
    const domOrder = await page.locator("#queue-bar .qtext").allInnerTexts();
    ok(
      inboxOrder.length === domOrder.length &&
        inboxOrder.every((t, i) => (domOrder[i] || "").trim() === t.trim()),
      `顺序一致 (inbox ${inboxOrder.length} 条 / DOM ${domOrder.length} 条)`,
      JSON.stringify({ inboxOrder: inboxOrder.map((x) => x.slice(0, 18)), domOrder: domOrder.map((x) => x.slice(0, 18)) })
    );

    // ---- 删除 ----
    console.log("\n[5] 点「✕」两次（确认删除）应真的把消息从 inbox 移除");
    const before = inboxOrder.length;
    // 找到包含 probe 的那一条，点它的删除
    const targetItem = page.locator("#queue-bar .qitem", { hasText: probe.slice(0, 20) }).first();
    const found = await targetItem.count();
    ok(found > 0, "能定位到刚发的那一条");
    if (found > 0) {
      const delBtn = targetItem.locator('button[data-act="remove"]');
      // 第一下只进确认态，第二下才真删（手机防误触）
      await delBtn.click();
      await page.waitForTimeout(300);
      ok((await delBtn.innerText()).trim() === "确认删除", "第一下进入「确认删除」确认态");
      await delBtn.click();
      await page.waitForTimeout(2500);
      const after = await page.evaluate(async (sid) => {
        const r = await fetch("/rpc/session/list", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ args: { _request: {} } }),
        });
        const j = await r.json();
        const it = (j.value?.items || []).find((x) => x.sessionId === sid);
        const ib = it?.projections?.values?.inbox || {};
        return [...(ib["next-turn"] || []), ...(ib["next-step"] || [])].length;
      }, s.sessionId);
      ok(after === before - 1, `inbox 条数 ${before} → ${after}`);
      const stillThere = await page.locator("#queue-bar .qtext", { hasText: probe.slice(0, 20) }).count();
      ok(stillThere === 0, "排队条里该条已消失");
    }
  }

  // ---- 空闲会话不显示排队条 ----
  console.log("\n[6] 空闲会话不应显示排队条");
  const idle = await page.evaluate(async () => {
    const r = await fetch("/rpc/session/list", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ args: { _request: {} } }),
    });
    const j = await r.json();
    const it = (j.value?.items || []).find((s) => {
      const ib = s.projections?.values?.inbox || {};
      return !s.running && !s.parentSessionId &&
        (ib["next-turn"] || []).length === 0 && (ib["next-step"] || []).length === 0;
    });
    return it?.sessionId || null;
  });
  if (idle) {
    await page.evaluate((sid) => {
      const i = state.sessions.findIndex((x) => x.sessionId === sid);
      if (i >= 0) openSession(state.sessions[i]);
    }, idle);
    await page.waitForTimeout(1500);
    ok(!(await page.locator("#queue-bar").isVisible()), "空闲会话隐藏排队条");
  } else {
    console.log("  ⚠ 没找到空闲会话，跳过");
  }

  // ---- 无 JS 报错 ----
  console.log("\n[7] 无 JS 异常");
  ok(errors.length === 0, "页面无报错", errors.slice(0, 3).join(" | "));

  console.log(`\n${"=".repeat(46)}\n通过 ${pass} 项，失败 ${fail} 项\n`);
  await browser.close();
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error("\n测试崩溃:", e);
  process.exit(2);
});
