// 验证「点提交」真的发出了 $events/result 请求，且 answers 载荷正确（拦截 mock，不触达 dsh 真实状态）
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

// 口令不写死：优先环境变量，其次读应用目录下自动生成的 .passphrase
const APP_DIR = path.resolve(__dirname, "..");
const PW = process.env.DSH_APP_PASS
  || fs.readFileSync(path.join(APP_DIR, ".passphrase"), "utf8").trim();
const BASE = process.env.BASE || "http://127.0.0.1:8760/";

(async () => {
  const b = await chromium.launch({ channel: "chrome" });
  const p = await b.newPage({ viewport:{width:420,height:860} });
  const errs=[]; p.on("pageerror",e=>errs.push(String(e)));

  let captured = null;
  await p.route("**/rpc/$events/result", async (route) => {
    captured = route.request().postDataJSON();
    await route.fulfill({ status:200, contentType:"application/json",
      body: JSON.stringify({ ok:true, value:{ accepted:true } }) });
  });

  await p.goto(BASE);
  await p.evaluate(async(pw)=>{await fetch("/auth",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({passphrase:pw})});}, PW);
  await p.goto(BASE);
  await p.waitForTimeout(700);

  // 注入测试问题（清掉真实的待答，避免误点他的会话）
  await p.evaluate(() => {
    state.pendingQuestions.clear(); state.qDrafts.clear(); state.qSteps.clear();
    state.evClientId="test-client"; state.sessionId="test-session";
    state.pendingQuestions.set("ev-wire", { eventId:"ev-wire", agent:"test-session", questions:[
      { id:"q1", header:"H", question:"Q", multiSelect:false, options:[{label:"选项A"},{label:"选项B"}] }
    ]});
    renderQuestionBanner();
  });
  await p.waitForTimeout(250);

  await p.click('#q-banner .qopt[data-label="选项A"]');
  await p.waitForTimeout(150);
  const en = await p.evaluate(()=>({disabled:document.querySelector("#q-banner .qsubmit").disabled}));
  await p.click("#q-banner .qsubmit");
  await p.waitForTimeout(700);

  console.log("提交前按钮可点:", en.disabled === false);
  console.log("捕获到请求:", captured ? "是" : "否");
  if (captured) console.log("请求载荷:", JSON.stringify(captured));

  // rpc() 会把参数包在 args 里
  const pl = captured && (captured.args || captured);
  const okPayload = pl
    && pl.eventId === "ev-wire"
    && pl.clientId === "test-client"
    && pl.outcome?.kind === "result"
    && Array.isArray(pl.outcome?.value?.answers)
    && pl.outcome.value.answers[0]?.id === "q1"
    && pl.outcome.value.answers[0]?.selected?.[0] === "选项A";

  const cleared = await p.evaluate(()=>({
    pending: state.pendingQuestions.size,
    cards: document.querySelectorAll("#q-banner .qcard").length,
    bannerDisplay: document.getElementById("q-banner").style.display,
  }));

  console.log("载荷正确:", okPayload);
  console.log("提交后清理:", JSON.stringify(cleared));
  console.log("JS 错误:", errs.length ? errs : "无");

  const pass = en.disabled===false && okPayload && cleared.pending===0 && errs.length===0;
  console.log("\n结果:", pass ? "✅ PASS" : "❌ FAIL");
  await b.close();
  process.exit(pass?0:1);
})();
