/**
 * 应用启动入口。
 *
 * =============================================================================
 * 这是整份前端唯一"按顺序做事"的文件，其他模块只声明函数、绑事件。
 * 顺序如下，每一步都有依赖，不要重排：
 *
 *   1. 消息区滚动行为       —— 纯 DOM，无依赖，先做掉
 *   2. 建立 WS 管道         —— 后续所有实时能力的前提
 *   3. 首屏骨架 + 拉列表     —— 先给视觉反馈，别让用户对着空白等十几秒
 *   4. 15s 轮询兜底         —— 事件流漏帧时靠它纠正 running / 标题
 *   5. 自愈入口             —— 手机切后台回来必须能自救
 *   6. 深链（?s= 从推送来）  —— 必须排在列表请求之后，否则它等的那个列表还没发出
 * =============================================================================
 */

"use strict";

// ---------- 1. 消息区滚动 ----------
const msgBox = $("messages");
msgBox.addEventListener("scroll", () => {
  const near = msgBox.scrollHeight - msgBox.scrollTop - msgBox.clientHeight < 160;
  $("jump-bottom").style.display = near ? "none" : "block";
});
$("jump-bottom").onclick = () => msgBox.scrollTo({ top: msgBox.scrollHeight, behavior: "smooth" });

// ---------- 2. 连接 ----------
connectStream();
loadAuthority(); // 顶栏显示真实上游地址（改过端口时才不会误导）
// 版本徽标：手机上点一下强制重新拉取前端（WebView 缓存偶尔会顽固）
$("app-ver").onclick = () => {
  location.replace(location.pathname + "?v=" + Date.now()); // 加时间戳 = 硬刷新
};

// ---------- 3. 首屏 ----------
renderListSkeleton(); // 立刻出骨架屏，别让手机端对着空白等十几秒
refreshSessions();

// ---------- 4. 轮询兜底 ----------
// 手机走公网隧道时 session/list 可能要十几秒。返回上一级判断在 refreshSessions
// 内部（listInFlight 防重入），这里用 15s，慢网络下才不会永远"上一轮没回来"。
setInterval(refreshSessions, 15000);

// ---------- 5. 自愈 ----------
// 手机端：回前台 / 网络恢复 / 从浏览器缓存恢复页面时，探测并修复事件流
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    streamSelfHeal();
    // 回到前台时列表可能已过期（手机上后台标签页定时器会被冻结），顺手刷一次
    if (state.sessionsLoaded) refreshSessions();
  }
});
window.addEventListener("online", () => streamSelfHeal());
window.addEventListener("pageshow", (e) => { if (e.persisted) streamSelfHeal(); });

// ---------- 6. 深链 ----------
openFromPush();

// 手机端：会话列表在抽屉里，未选会话时自动弹开 + 文案引导
const isMobile = window.matchMedia("(max-width: 720px)").matches;
if (isMobile && !state.sessionId) {
  $("empty-hint").innerHTML = "点左上角 <b>☰</b> 选择会话<br>选择后消息会实时流式显示";
  setTimeout(() => toggleDrawer(true), 400);
}
