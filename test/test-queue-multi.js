#!/usr/bin/env node
/**
 * 多消息排队 + 插队回归测试
 *
 * 场景：忙会话里连发 3 条 → 排队条应按顺序显示 3 条，
 *       点其中一条的「插队」应把它从 next-turn 移到 next-step（下一步就执行），
 *       且顺序不乱。
 */
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const BASE = process.env.BASE || "http://127.0.0.1:8760";
const APP_DIR = path.resolve(__dirname, "..");
const PASS = fs.readFileSync(path.join(APP_DIR, ".passphrase"), "utf8").trim();

let pass = 0, fail = 0;
function ok(c, n, x = "") {
  if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${x ? " — " + x : ""}`); }
}

async function listSessions(page) {
  return page.evaluate(async () => {
    const r = await fetch("/rpc/session/list", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ args: { _request: {} } }),
    });
    return (await r.json()).value?.items || [];
  });
}

(async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const ctx = await browser.newContext({ viewport: { width: 430, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  if (await page.locator("#pw").count()) {
    await page.fill("#pw", PASS);
    await page.click("#go");
    await page.waitForLoadState("networkidle");
  }
  await page.waitForTimeout(1500);

  const running = (await listSessions(page)).filter(
    (s) => s.running && !s.parentSessionId && s.origin !== "subagent"
  );
  if (!running.length) {
    console.log("⚠ 无运行中会话，跳过");
    await browser.close();
    process.exit(0);
  }
  const sid = running[0].sessionId;

  await page.evaluate((s) => {
    const i = state.sessions.findIndex((x) => x.sessionId === s);
    if (i >= 0) openSession(state.sessions[i]);
  }, sid);
  await page.waitForTimeout(1200);

  console.log("\n[1] 连发 3 条，排队条应按序显示 3 条");
  const tag = "QTEST" + Date.now();
  const msgs = [`${tag}-A`, `${tag}-B`, `${tag}-C`];
  // 用 RPC 直接投递，避免 UI 输入框在忙碌时被禁用的干扰
  for (const t of msgs) {
    await page.evaluate(async ([sessionId, text]) => {
      await fetch("/rpc/session/prompt", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          args: { request: {
            sessionId, requestId: crypto.randomUUID(), mode: "queue",
            content: [{ type: "text", text }], clientTimeZone: "Asia/Shanghai",
          } },
        }),
      });
    }, [sid, t]);
    await new Promise((r) => setTimeout(r, 400));
  }
  await page.waitForTimeout(3000);

  const domOrder = await page.locator("#queue-bar .qtext").allInnerTexts();
  const mine = domOrder.map((s) => s.trim()).filter((s) => s.startsWith(tag));
  ok(mine.length === 3, `排队条显示了 3 条我的消息（实际 ${mine.length}）`, JSON.stringify(mine));
  ok(
    JSON.stringify(mine) === JSON.stringify(msgs),
    "顺序为 A→B→C（与发送顺序一致）",
    JSON.stringify(mine)
  );

  console.log("\n[2] 点 B 的「插队」，B 应变成下一步就执行");
  const itemB = page.locator("#queue-bar .qitem", { hasText: `${tag}-B` }).first();
  if (await itemB.count()) {
    const steerBtn = itemB.locator('button[data-act="steer"]');
    if (await steerBtn.count()) {
      await steerBtn.click();
      await page.waitForTimeout(2500);
      const st = await page.evaluate(async (s) => {
        const r = await fetch("/rpc/session/list", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ args: { _request: {} } }),
        });
        const it = ((await r.json()).value?.items || []).find((x) => x.sessionId === s);
        const ib = it?.projections?.values?.inbox || {};
        const txt = (m) => (m.content || []).filter((p) => p.type === "text").map((p) => p.text).join("\n");
        return { nt: (ib["next-turn"] || []).map(txt), ns: (ib["next-step"] || []).map(txt) };
      }, sid);
      ok(
        st.ns.some((t) => t.includes(`${tag}-B`)),
        "B 已进入 next-step（插队成功）",
        JSON.stringify(st)
      );
    } else {
      console.log("  ⚠ 会话未在运行，插队按钮未出现（符合预期：空闲时无插队）");
    }
  } else {
    ok(false, "没找到 B 条目");
  }

  console.log("\n[3] 清理：撤销本次测试产生的全部排队消息");
  const cleanup = await page.evaluate(async ([sessionId, t]) => {
    const r0 = await fetch("/rpc/session/list", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ args: { _request: {} } }),
    });
    const it = ((await r0.json()).value?.items || []).find((x) => x.sessionId === sessionId);
    const ib = it?.projections?.values?.inbox || {};
    const all = [...(ib["next-turn"] || []), ...(ib["next-step"] || [])];
    let n = 0;
    for (const m of all) {
      const txt = (m.content || []).filter((p) => p.type === "text").map((p) => p.text).join("\n");
      if (!txt.includes(t)) continue;
      const r = await fetch("/rpc/session/updateQueue", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ args: { request: { sessionId, itemId: m.id, action: { kind: "remove" } } } }),
      });
      if ((await r.json()).ok) n++;
    }
    return n;
  }, [sid, tag]);
  ok(cleanup >= 1, `已撤销 ${cleanup} 条测试消息`);

  // 注意：这里的撤销是直接走 RPC 完成的，绕过了 UI 的「撤销」按钮，
  // 因此前端不会自动刷新，必须显式触发一次（真实点击路径见 test-queue-bar.js）。
  await page.evaluate(() => refreshSessions());
  await page.waitForTimeout(1200);
  const leftover = await page.locator("#queue-bar .qtext").allInnerTexts();
  ok(!leftover.some((s) => s.includes(tag)), "排队条中已无本次测试残留", JSON.stringify(leftover));
  ok(errors.length === 0, "无 JS 异常", errors.slice(0, 2).join(" | "));

  console.log(`\n${"=".repeat(46)}\n通过 ${pass} 项，失败 ${fail} 项\n`);
  await browser.close();
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("\n崩溃:", e); process.exit(2); });
