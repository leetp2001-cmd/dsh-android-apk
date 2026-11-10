/**
 * 消息区的 DOM 基元：追加节点、跟随滚动、气泡、工具卡片、系统提示行。
 *
 * 所有往 #messages 里塞东西的地方都必须走这里的函数，因为"是否跟随滚动"
 * 的判断只在这里做对了一次 —— 各处直接 appendChild 会绕过它。
 */

"use strict";

// ---------- 会话内容渲染 ----------
// 跟随滚动：只有用户本来就在底部时才自动滚到底；上滑阅读时不打扰，回底部走「⬇ 回到底部」按钮
function nearBottom() {
  const box = $("messages");
  return box.scrollHeight - box.scrollTop - box.clientHeight < 120;
}
function followScroll(force) {
  const box = $("messages");
  if (force || nearBottom()) box.scrollTop = box.scrollHeight;
}
function pushNode(el, force) {
  const box = $("messages");
  box.appendChild(el);
  followScroll(force);
}
function msgNode(kind, who, force) {
  const w = document.createElement("div");
  w.className = "msg " + kind;
  w.innerHTML = `<div class="who">${esc(who)}</div><div class="bubble"></div>`;
  pushNode(w, force);
  return w.querySelector(".bubble");
}
function toolNode(callId, name, desc) {
  const d = document.createElement("details");
  d.className = "tool";
  d.innerHTML = `<summary><span class="tname">🔧 ${esc(name)}</span><span class="tdesc">${esc(desc || "")}</span></summary><div class="tbody">…</div>`;
  pushNode(d);
  if (callId) state.toolChips.set(callId, d);
  return d;
}
function sysLine(text, cls = "divider") {
  const d = document.createElement("div");
  d.className = cls;
  d.textContent = text;
  pushNode(d);
}
