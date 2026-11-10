/**
 * 启动流程：PWA 注册与安装引导。
 *
 * 顺序要求：本文件必须在使用 $() 取 DOM 的模块**之后**加载，
 * 因为它一执行就绑事件。真正的启动动作（connectStream / refreshSessions）
 * 在 19-main.js 里，且必须排在所有模块之后（启动序列见该文件头部）。
 */

"use strict";

// ---------- 启动 ----------
// PWA：Service Worker + 安装入口（常驻按钮：支持则直接唤起，不支持则给手动指引）
if ("serviceWorker" in navigator) {
  // 旧缓存清理交给 sw.js 的 activate（按 CACHE 版本号整体作废）。
  // 这里不要再写死版本号：曾经写成只保留 "dshapp-v5"，反而把当时在用的缓存全删了。
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}
let installEvent = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  installEvent = e;
});
window.addEventListener("appinstalled", () => ($("btn-install").style.display = "none"));

const UA = navigator.userAgent;
const badBrowser = /MicroMessenger|UCBrowser|QQBrowser|Quark|Baidu|HeyTapBrowser|VivoBrowser|HuaweiBrowser|MiuiBrowser/i.test(UA);
const isChromeLike = /Chrome\/|CriOS|Edg\//i.test(UA) && !badBrowser;

function installHelpHtml() {
  if (badBrowser) {
    return `<p style="color:#f87171">⚠️ 当前浏览器不支持安装（微信/UC/夸克/QQ 等内置浏览器都不行）。</p>
      <p style="margin:10px 0">请复制下面的地址，粘贴到 <b>Chrome</b> 或 <b>Edge</b> 打开：</p>
      <p style="user-select:all;background:var(--code-bg);padding:9px;border-radius:8px;word-break:break-all;font-size:12px">${location.origin}</p>`;
  }
  return `<p style="margin:8px 0">在 Chrome 里点右上角 <b>⋮</b> 菜单，选择：</p>
    <p style="background:var(--code-bg);padding:9px;border-radius:8px;font-size:13px">「安装应用」或「添加到主屏幕」</p>
    <p style="margin-top:10px;color:var(--muted);font-size:12px">装好后桌面会出现 🌊 dsh 图标，点开即全屏运行。</p>`;
}

$("btn-install").onclick = async () => {
  if (installEvent) {
    installEvent.prompt();
    await installEvent.userChoice;
    installEvent = null;
    return;
  }
  // 无原生安装事件：弹手动指引
  const mask = document.createElement("div");
  mask.style.cssText = "position:fixed;inset:0;background:rgba(23,32,43,.3);backdrop-filter:blur(2px);-webkit-backdrop-filter:blur(2px);z-index:30;display:flex;align-items:center;justify-content:center;padding:20px";
  mask.innerHTML = `<div style="background:var(--panel);border:1px solid var(--border);border-radius:14px;padding:22px;max-width:400px;font-size:14px;box-shadow:var(--shadow-lg)">
    <h3 style="margin-bottom:12px">📲 安装到手机桌面</h3>${installHelpHtml()}
    <div style="text-align:right;margin-top:14px"><button id="ih-ok" class="primary">知道了</button></div></div>`;
  document.body.appendChild(mask);
  mask.onclick = (e) => { if (e.target === mask || e.target.id === "ih-ok") mask.remove(); };
};
// Chrome 可能延迟 30 秒才允许唤起原生安装框；期间按钮先显示，点击走指引
if (!installEvent && !isChromeLike) $("btn-install").textContent = "📲 安装 APP";
