/**
 * 显示偏好：降噪模式 + 回到底部。
 *
 * 降噪 = 隐藏思考过程与工具卡片，只看对话。手机上默认开启 —— 一屏就那么高，
 * 工具调用卡片会把人话顶走。桌面默认关闭。
 *
 * 偏好存 localStorage：这是纯前端观感，没必要惊动服务端。
 */

"use strict";

// ---------- 降噪模式 + 回到底部 ----------
const QUIET_KEY = "dshapp-quiet";
function quietOn() {
  const v = localStorage.getItem(QUIET_KEY);
  if (v === null) return window.matchMedia("(max-width: 720px)").matches; // 手机默认降噪
  return v === "1";
}
function applyQuiet() {
  const on = quietOn();
  $("messages").classList.toggle("quiet", on);
  $("btn-quiet").textContent = on ? "🔇 降噪中" : "🔊 全量";
}
$("btn-quiet").onclick = () => {
  localStorage.setItem(QUIET_KEY, quietOn() ? "0" : "1");
  applyQuiet();
};
applyQuiet();
