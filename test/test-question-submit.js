// 多场景回归：多选、跳过、自定义输入、翻题、多题批量
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

// 口令不写死：优先环境变量，其次读应用目录下自动生成的 .passphrase
const APP_DIR = path.resolve(__dirname, "..");
const PW = process.env.DSH_APP_PASS
  || fs.readFileSync(path.join(APP_DIR, ".passphrase"), "utf8").trim();
const URL = process.env.BASE || "http://127.0.0.1:8760/";

async function newPage(browser) {
  const page = await browser.newPage({ viewport: { width: 420, height: 860 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(URL);
  await page.evaluate(async (pw) => {
    await fetch("/auth", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ passphrase: pw }) });
  }, PW);
  await page.goto(URL);
  await page.waitForTimeout(600);
  return { page, errors };
}

async function inject(page, questions, eventId = "ev-test") {
  await page.evaluate(({ questions, eventId }) => {
    state.pendingQuestions.clear(); state.qDrafts.clear(); state.qSteps.clear();
    state.evClientId = "test-client";
    state.sessionId = "test-session";
    state.pendingQuestions.set(eventId, { eventId, agent: "test-session", questions });
    renderQuestionBanner();
  }, { questions, eventId });
  await page.waitForTimeout(250);
}

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "✅" : "❌"} ${name}${detail ? " — " + detail : ""}`);
};

(async () => {
  const browser = await chromium.launch({ channel: "chrome" });

  // --- 场景1：多选，选两项，提交按钮应可点 ---
  {
    const { page, errors } = await newPage(browser);
    await inject(page, [{ id: "q1", header: "多选", question: "选多个", multiSelect: true, options: [{ label: "A" }, { label: "B" }, { label: "C" }] }]);
    await page.click('#q-banner .qopt[data-label="A"]');
    await page.click('#q-banner .qopt[data-label="C"]');
    await page.waitForTimeout(200);
    const r = await page.evaluate(() => ({
      disabled: document.querySelector("#q-banner .qsubmit").disabled,
      selCount: document.querySelectorAll("#q-banner .qopt.sel").length,
      draftSel: null,
    }));
    check("多选：选两项后提交可点", r.disabled === false && r.selCount === 2, JSON.stringify(r));
    check("多选：无 JS 报错", errors.length === 0, errors.join(";"));
    await page.close();
  }

  // --- 场景2：取消选择后，提交按钮应重新禁用 ---
  {
    const { page, errors } = await newPage(browser);
    await inject(page, [{ id: "q1", header: "单选", question: "选一个", multiSelect: false, options: [{ label: "A" }, { label: "B" }] }]);
    await page.click('#q-banner .qopt[data-label="A"]');
    await page.waitForTimeout(150);
    const on = await page.evaluate(() => document.querySelector("#q-banner .qsubmit").disabled);
    await page.click('#q-banner .qopt[data-label="A"]'); // 再点取消
    await page.waitForTimeout(150);
    const off = await page.evaluate(() => ({
      disabled: document.querySelector("#q-banner .qsubmit").disabled,
      selCount: document.querySelectorAll("#q-banner .qopt.sel").length,
      hintVisible: (document.querySelector("#q-banner .qhint") || {}).style ? document.querySelector("#q-banner .qhint").style.display !== "none" : null,
    }));
    check("单选：选中→可点", on === false);
    check("单选：取消→重新禁用", off.disabled === true && off.selCount === 0, JSON.stringify(off));
    check("单选取消：无 JS 报错", errors.length === 0, errors.join(";"));
    await page.close();
  }

  // --- 场景3：跳过按钮：文案切换 + 提交可点 ---
  {
    const { page, errors } = await newPage(browser);
    await inject(page, [{ id: "q1", header: "跳过", question: "可跳过", multiSelect: false, options: [{ label: "A" }] }]);
    await page.click("#q-banner .qskip");
    await page.waitForTimeout(200);
    const r = await page.evaluate(() => ({
      disabled: document.querySelector("#q-banner .qsubmit").disabled,
      skipText: document.querySelector("#q-banner .qskip").textContent,
      skippedClass: document.querySelector("#q-banner .qblock").classList.contains("skipped"),
    }));
    check("跳过：按钮文案变'已跳过'", r.skipText.includes("已跳过"), r.skipText);
    check("跳过：提交可点", r.disabled === false, JSON.stringify(r));
    check("跳过：块加 skipped 样式", r.skippedClass === true);
    check("跳过：无 JS 报错", errors.length === 0, errors.join(";"));
    await page.close();
  }

  // --- 场景4：自定义输入 → 提交可点，且清掉选项高亮 ---
  {
    const { page, errors } = await newPage(browser);
    await inject(page, [{ id: "q1", header: "自定义", question: "随便说", multiSelect: false, options: [{ label: "A" }] }]);
    await page.click('#q-banner .qopt[data-label="A"]');
    await page.waitForTimeout(150);
    await page.fill("#q-banner .qcustom", "我自己写的答案");
    await page.waitForTimeout(200);
    const r = await page.evaluate(() => ({
      disabled: document.querySelector("#q-banner .qsubmit").disabled,
      selCount: document.querySelectorAll("#q-banner .qopt.sel").length,
      val: document.querySelector("#q-banner .qcustom").value,
    }));
    check("自定义：输入后提交可点", r.disabled === false, JSON.stringify(r));
    check("自定义：清掉选项高亮", r.selCount === 0);
    check("自定义：输入值保留", r.val === "我自己写的答案");
    check("自定义：无 JS 报错", errors.length === 0, errors.join(";"));
    await page.close();
  }

  // --- 场景5：两题批量，第一题答完「下一题」可点，翻到第二题答完后「提交回答」可点 ---
  {
    const { page, errors } = await newPage(browser);
    await inject(page, [
      { id: "q1", header: "第一题", question: "Q1", multiSelect: false, options: [{ label: "A1" }] },
      { id: "q2", header: "第二题", question: "Q2", multiSelect: false, options: [{ label: "B1" }] },
    ]);
    const s0 = await page.evaluate(() => ({
      nextExists: !!document.querySelector("#q-banner .qnext"),
      submitExists: !!document.querySelector("#q-banner .qsubmit"),
      nextDisabled: (document.querySelector("#q-banner .qnext") || {}).disabled,
    }));
    check("多题：第1/2题显示「下一题」而非提交", s0.nextExists && !s0.submitExists && s0.nextDisabled === true, JSON.stringify(s0));

    await page.click('#q-banner .qopt[data-label="A1"]');
    await page.waitForTimeout(200);
    const s1 = await page.evaluate(() => ({ nextDisabled: document.querySelector("#q-banner .qnext").disabled }));
    check("多题：答完第1题「下一题」可点", s1.nextDisabled === false);

    await page.click("#q-banner .qnext");
    await page.waitForTimeout(250);
    const s2 = await page.evaluate(() => ({
      submitExists: !!document.querySelector("#q-banner .qsubmit"),
      submitDisabled: (document.querySelector("#q-banner .qsubmit") || {}).disabled,
      batchText: (document.querySelector("#q-banner .qbatch") || {}).textContent || "",
    }));
    check("多题：翻到第2题出现「提交回答」且初始禁用", s2.submitExists && s2.submitDisabled === true, JSON.stringify(s2));

    await page.click('#q-banner .qopt[data-label="B1"]');
    await page.waitForTimeout(200);
    const s3 = await page.evaluate(() => ({ submitDisabled: document.querySelector("#q-banner .qsubmit").disabled }));
    check("多题：答完第2题「提交回答」可点", s3.submitDisabled === false);
    check("多题：无 JS 报错", errors.length === 0, errors.join(";"));
    await page.close();
  }

  await browser.close();

  const failed = results.filter((r) => !r.pass);
  console.log(`\n===== 汇总: ${results.length - failed.length}/${results.length} 通过 =====`);
  if (failed.length) {
    console.log("失败项:");
    failed.forEach((f) => console.log("  - " + f.name + (f.detail ? " :: " + f.detail : "")));
  }
  process.exit(failed.length ? 1 : 0);
})();
