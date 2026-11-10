"use strict";
/**
 * 登录页：口令输入 + 手机安装包下载 + ntfy 安装引导。
 *
 * 为什么是内联模板而不是 public/login.html：
 * 这一页必须在**未鉴权**时返回，而静态目录整体是鉴权后的。放在代码里
 * 就不需要在静态路由里开一个特殊豁免，边界更干净。
 *
 * 页面本身不含任何用户数据，ntfy topic 是前端异步拉 /push/public 拿的。
 */

const fs = require("node:fs");
const path = require("node:path");

const { PUBLIC_DIR } = require("../config");

/**
 * ntfy 安装包是可选的（9MB，不进 git，不同人未必需要）。
 * 存在才给下载按钮 —— 否则点了就是 404，比不放还糟。
 */
function ntfyDownloadBlock() {
  const localApk = path.join(PUBLIC_DIR, "ntfy.apk");
  if (fs.existsSync(localApk)) {
    return `<p>国内应用商店和 F-Droid 官方站都进不去，本机已存一份官方安装包，点这里下：</p>
      <a class="apk" href="/ntfy.apk" download="ntfy.apk">⬇ 下载 ntfy 安装包</a>`;
  }
  return `<p>装 ntfy 的任一渠道：</p>
      <p class="tip" style="text-align:left;margin-top:6px">
        · 安卓：Google Play 搜 ntfy，或 F-Droid<br>
        · iOS：App Store 搜 ntfy<br>
        · 都装不上：换个渠道，Bark（iOS）或 Server 酱（微信）也行
      </p>`;
}

/** @returns {string} 登录页 HTML */
function renderLogin() {
  return LOGIN_HTML.replace("<!--NTFY_DOWNLOAD-->", ntfyDownloadBlock());
}

const LOGIN_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>dsh 控制台 · 登录</title>
<link rel="manifest" href="/manifest.webmanifest">
<meta name="theme-color" content="#ffffff">
<link rel="icon" href="/icon-192.png">
<style>
  body { font-family: -apple-system, "PingFang SC", sans-serif;
         background: #eef2f9; color: #17202b;
         display: flex; align-items: center; justify-content: center;
         height: 100vh; margin: 0; -webkit-font-smoothing: antialiased; }
  .card { background: #ffffff; border: 1px solid #e5e9f0; border-radius: 16px;
          padding: 32px 28px; width: min(340px, 86vw);
          box-shadow: 0 16px 44px rgba(23,32,43,.10), 0 3px 10px rgba(23,32,43,.05); }
  h1 { font-size: 19px; margin: 0 0 6px; letter-spacing: -.01em; }
  .sub { color: #697688; font-size: 13px; margin: 0 0 20px; }
  input { width: 100%; box-sizing: border-box; padding: 12px 13px; border: 1px solid #d6dde8;
          border-radius: 10px; background: #ffffff; color: #17202b; font-size: 15px; outline: none;
          transition: border-color .15s, box-shadow .15s; }
  input:focus { border-color: #2f6bff; box-shadow: 0 0 0 3px rgba(47,107,255,.13); }
  input::placeholder { color: #9aa6b6; }
  button { width: 100%; margin-top: 14px; padding: 12px; border: 0; border-radius: 10px;
           background: #2f6bff; color: #fff; font-size: 15px; font-weight: 600; cursor: pointer;
           box-shadow: 0 2px 8px rgba(47,107,255,.24); transition: background .15s; }
  button:hover { background: #2359e8; }
  button:active { transform: scale(.99); }
  .err { color: #d92d20; font-size: 13px; margin-top: 10px; min-height: 18px; }
  .apk { display: block; text-align: center; margin-top: 16px; padding: 11px; border-radius: 10px;
         border: 1px solid #c9dbff; background: #eef4ff; color: #2f6bff;
         font-size: 14px; text-decoration: none; font-weight: 500; }
  .apk:active { background: #e0ebff; }
  .tip { color: #8b97a8; font-size: 12px; text-align: center; margin-top: 10px; }
  .ntfy { margin-top: 14px; border-top: 1px solid #eceff4; padding-top: 12px; }
  .ntfy summary { color: #5b6878; font-size: 12.5px; cursor: pointer; list-style: none; }
  .ntfy summary::-webkit-details-marker { display: none; }
  .ntfy summary::before { content: "▸ "; }
  .ntfy[open] summary::before { content: "▾ "; }
  .ntfy p { color: #7590a8; font-size: 12px; line-height: 1.6; margin: 10px 0 0; }
  .ntfy code { display: block; margin-top: 8px; padding: 9px 10px; border-radius: 8px;
               background: #f4f7fb; border: 1px solid #e4eaf2; color: #17202b;
               font-family: ui-monospace, Menlo, monospace; font-size: 12.5px;
               word-break: break-all; user-select: all; }
</style>
</head>
<body>
  <div class="card">
    <h1>🌊 dsh 控制台</h1>
    <p class="sub" id="lead">请输入访问口令</p>
    <input id="pw" type="password" placeholder="访问口令" autofocus autocapitalize="off" autocorrect="off" spellcheck="false" autocomplete="off">
    <button id="go">进入</button>
    <div class="err" id="err"></div>
    <a class="apk" id="apklink" href="/dsh-console.apk" download="dsh-console.apk">⬇ 下载手机 APP 安装包（APK）</a>
    <div class="tip">手机装了 APP 后可不走这页，直接图标进入</div>
    <details class="ntfy">
      <summary>📲 装不上 ntfy？（消息推送要用）</summary>
      <!--NTFY_DOWNLOAD-->
      <p class="tip" style="text-align:left">装好后订阅这个 topic 即可收到推送：</p>
      <code id="ntfy-topic">加载中…</code>
    </details>
  </div>
<script>
  // 登录页也把当前 topic 显示出来：用户装完 ntfy 直接照着输，不用回去翻配置
  fetch("/push/public").then((r) => r.json()).then((j) => {
    const c = (j?.value?.channels || []).find((x) => x.type === "ntfy");
    const el = document.getElementById("ntfy-topic");
    if (el) el.textContent = c?.topic ? c.topic : "（未配置 ntfy 渠道）";
  }).catch(() => {});
</script>
<script>
  const pw = document.getElementById("pw");
  const err = document.getElementById("err");
  async function login() {
    const res = await fetch("/auth", { method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ passphrase: pw.value.trim() }) });
    if (res.ok) { location.href = "/"; return; }
    err.textContent = "口令错误，重试";
    pw.value = ""; pw.focus();
  }
  document.getElementById("go").onclick = login;
  pw.addEventListener("keydown", (e) => { if (e.key === "Enter") login(); });
</script>
</body>
</html>`;

module.exports = { renderLogin };
