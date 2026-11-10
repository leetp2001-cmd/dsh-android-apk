/**
 * 发送、中断、输入框。
 *
 * 两条通道的内容不同：
 *   · 文字：{type:"text", text}
 *   · 图片：{type:"image", mediaType, data:base64} —— dsh 收下后换成 attachment 引用
 * 有图无字也允许发（很多场景就是甩一张图让它看）。
 *
 * 中断键用两段式确认：安卓 WebView 不弹 confirm/alert，且手指容易误触。
 */

"use strict";

// ---------- 中断键状态（唯一出口，别再各处直接改 DOM） ----------
// 三路信号都可能更新运行态：session/list 的 running、follow 流的 turn/start|end、
// 发送后的乐观置位。统一走 setRunning，保证按钮的显隐/文案/武装态永远一致。
// 文案由 renderCancel 单点决定，三处（显隐 / 武装 / 忙态）不会互相覆盖。
const CANCEL_ARM_MS = 6000;   // 确认态存活时长：手机上手滑第一下后，6s 内都算数
let cancelArmTimer = null;
let cancelArmed = false; // 两段式确认的第一下已按下
let cancelBusy = false;  // 已发 cancel，等 dsh 回 turn/end
function renderCancel() {
  const btn = $("btn-cancel");
  if (!btn) return;
  btn.classList.toggle("armed", cancelArmed && !cancelBusy);
  btn.textContent = cancelBusy ? "中断中" : cancelArmed ? "确认中断" : "中断";
  btn.disabled = cancelBusy;
  btn.style.display = state.running ? "" : "none";
  // 运行中把「发送」降级成次要按钮，视线自然落到中断上
  $("send")?.classList.toggle("secondary", state.running);
}
function setRunning(run, force) {
  // session/list 有延迟：刚发出消息时后端可能还报 running=false，
  // 4s 内不允许被它按掉，否则按钮刚出现就消失。force=true 可绕过。
  if (!run && !force && state.runGuardAt && Date.now() - state.runGuardAt < 4000) return;
  if (!!run === state.running && !force) { renderCancel(); return; }
  state.running = !!run;
  if (!run) { state.runGuardAt = 0; cancelBusy = false; disarmCancel(); } // 结束即清干净
  renderCancel();
}
// 乐观置位：发送成功后立刻认为在跑（不必等下一轮 session/list）
function markRunning() {
  state.runGuardAt = 0;      // 先清，否则 setRunning 的宽限判定会自我阻挡
  cancelBusy = false;
  disarmCancel();
  setRunning(true, true);    // force：绕过早先残留的宽限期
  state.runGuardAt = Date.now(); // 再开窗，挡住随后 4s 内滞后的 running=false
}
function disarmCancel() {
  cancelArmed = false;
  if (cancelArmTimer) { clearTimeout(cancelArmTimer); cancelArmTimer = null; }
  renderCancel();
}

// ---------- 发送 ----------
// 两条通道的内容不同：
//   · 文字：{type:"text", text}
//   · 图片：{type:"image", mediaType, data:base64} —— dsh 收下后换成 attachment 引用
// 有图无字也允许发（很多场景就是甩一张图让它看）。
async function sendPrompt() {
  const box = $("prompt");
  const text = box.value.trim();
  const drafts = state.draftImages.slice(); // 立刻取快照：后面清空不会影响本次发送
  if ((!text && !drafts.length) || !state.sessionId) return;
  box.value = ""; autosize();
  let echoNode = null;
  // 失败回滚：撤掉乐观回显的消息与打字提示，把内容放回输入框/草稿栏
  const rollbackEcho = () => {
    hideTyping();
    if (echoNode) { echoNode.remove(); echoNode = null; }
    state.pendingRpcs.delete(requestId);
    if (text) box.value = text;
    state.draftImages = drafts;
    renderAttachBar();
    autosize();
    setRunning(false, true); // 没发出去就别显示中断键（绕过 4s 宽限）
  };
  const requestId = crypto.randomUUID();
  const sessionId = state.sessionId;

  // 乐观回显放在读字节之前：手机上读 20 张图要几百毫秒，
  // 不先给出反馈用户会以为没点上而反复按。
  echoNode = msgNode("user", "你", true).parentElement;
  const bubble = echoNode.querySelector(".bubble");
  bubble.innerHTML = text ? md(text) : "";
  if (drafts.length) {
    // 草稿里已有 objectURL，直接复用，不必为了回显再读一遍 base64
    const wrap = document.createElement("div");
    wrap.className = "mimg";
    for (const it of drafts) {
      const cell = document.createElement("div");
      cell.className = "mimg-cell";
      cell.innerHTML = `<img src="${it.previewUrl}" alt="">`;
      cell.onclick = () => openLightbox(it.previewUrl);
      wrap.appendChild(cell);
    }
    bubble.appendChild(wrap);
  }
  showTyping(); // 发出后先给“打字中”提示，dsh 响应或事件确认时撤掉
  markRunning(); // 立刻亮出中断键，不等 session/list 回包

  try {
    const content = [];
    if (text) content.push({ type: "text", text });
    const n = drafts.length;
    for (let i = 0; i < n; i++) {
      const it = drafts[i];
      // 压缩放在这里而不是选图时：选图时压 20 张会让面板卡住好几秒，
      // 而且用户经常选了又删，白压。发送时压，顺便能给出进度反馈。
      if (n > 1) toast(`正在处理图片 ${i + 1}/${n}…`);
      // 读失败就整体放弃：发半截图比不发更糟（用户以为发了）
      const { blob, mediaType, name } = await compressImage(it.file);
      const dataUrl = await fileToDataUrl(blob);
      const comma = dataUrl.indexOf(",");
      if (comma < 0) throw new Error(`读取 ${it.name} 失败`);
      content.push({
        type: "image", mediaType,
        data: dataUrl.slice(comma + 1), name,
      });
    }
    const request = {
      sessionId, requestId, mode: "queue",
      content, clientTimeZone: "Asia/Shanghai",
    };
    state.lastUserText = text; // turn/end(error) 的「重试」按钮要用它填回输入框
    state.pendingRpcs.add(requestId);
    // 发送成功后再清草稿：失败要能原样恢复
    state.draftImages = [];
    renderAttachBar();
    try {
      await rpc("session/prompt", { request });
      refreshSessions();
    } catch (e) {
      if (String(e.message).includes("stream carrier")) {
        // unary 通道不通，走 WS 流
        streamOpen("session/prompt", { args: { request } }, {
          onError: (err) => { rollbackEcho(); toast("发送失败: " + (err?.message ?? "")); },
        });
      } else {
        throw e;
      }
    }
  } catch (e) {
    rollbackEcho();
    toast("发送失败: " + e.message);
  }
}
$("send").onclick = sendPrompt;
// 中断：两段式确认（安卓 WebView 不弹 confirm/alert，不能用对话框）
$("btn-cancel").onclick = async () => {
  const btn = $("btn-cancel");
  if (!state.sessionId || cancelBusy) return;
  if (!cancelArmed) {
    cancelArmed = true;
    renderCancel();
    if (cancelArmTimer) clearTimeout(cancelArmTimer);
    cancelArmTimer = setTimeout(disarmCancel, CANCEL_ARM_MS);
    return;
  }
  disarmCancel();
  cancelBusy = true;
  renderCancel();
  try {
    await rpc("session/cancel", { request: { sessionId: state.sessionId } });
    toast("已请求中断；如有排队消息会自动继续处理", "ok");
    // dsh 收下取消后会发 turn/end(cancelled)，那时 setRunning(false) 收尾。
    // 但会话可能卡在工具执行里不回事件，兜一个超时自愈，别让按钮永远「中断中」。
    setTimeout(() => {
      if (!state.running) return;
      cancelBusy = false;
      renderCancel();
    }, 8000);
    refreshSessions();
  } catch (e) {
    toast("中断失败: " + e.message);
    cancelBusy = false;
    renderCancel();
  }
};
$("prompt").onkeydown = (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendPrompt(); }
};
function autosize() {
  const b = $("prompt");
  b.style.height = "auto";
  b.style.height = Math.min(b.scrollHeight, 180) + "px";
}
$("prompt").oninput = () => { autosize(); syncComposer(); };

// ---------- 上下文仪表交互 ----------
$("ctx-pill").onclick = (e) => {
  e.stopPropagation();
  state.ctxOpen = !state.ctxOpen;
  renderCtxPanel();
};
$("ctx-panel").onclick = (e) => e.stopPropagation();
document.addEventListener("click", () => {
  if (state.ctxOpen) { state.ctxOpen = false; renderCtxPanel(); }
});
