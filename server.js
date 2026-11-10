#!/usr/bin/env node
"use strict";
/**
 * dsh 控制台 · 本地服务入口
 * =============================================================================
 * 只做三件事：装配 → 监听 → 优雅退出。所有逻辑都在 src/ 下：
 *
 *   src/config.js          环境变量与路径（唯一来源）
 *   src/auth/              鉴权三层：口令 cookie / 边缘认证 / dsh 会话凭据
 *   src/dsh/               与 dsh 通信：unary RPC 代理、列表瘦身、快照瘦身
 *   src/push/              消息推送：配置、事件探测、通知编排与投递
 *   src/http/              HTTP 层：请求分发、静态资源、各路由
 *   src/ws/                WebSocket 管道（手机 ⇄ dsh 的流式桥）
 *   src/views/             服务端渲染的页面（目前只有登录页）
 *   src/app.js             装配以上各层
 *
 * 对外契约：
 *   · 127.0.0.1:8760 提供静态页面
 *   · POST /rpc/<endpoint>  转发 dsh unary RPC（HTTP）
 *   · WS   /stream          双向管道到 dsh /api/remote.mux（流式 RPC）
 *
 * 不修改 dsh 任何状态；只读它的签名密钥 + 调用它公开的 RPC。
 */

const { createApp } = require("./src/app");
const { runPreflight, printPreflight } = require("./src/lib/preflight");

const app = createApp();

app.listen().catch((err) => {
  if (err && err.code === "EADDRINUSE") {
    console.error(
      `[dsh-app] 端口被占用。换一个端口：DSH_APP_PORT=8761 ./start.sh\n` +
        `           或先停掉已有实例：pkill -f "node server.js"`
    );
  } else {
    console.error("[dsh-app] 启动失败:", err);
  }
  process.exit(1);
});

// 自检放在监听之后跑：即使上游没就绪，本服务也应该先起来（dsh 可能随后启动）。
// 但结果要尽早打出来，否则用户看到空白页面时已经不知道该查什么了。
runPreflight()
  .then(printPreflight)
  .catch((e) => console.error("[preflight] 自检本身出错:", e.message));

// 优雅退出：让 WS 与推送定时器有机会收尾，避免留下半死连接
let shuttingDown = false;
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[dsh-app] 收到 ${sig}，正在退出…`);
    app.close().finally(() => process.exit(0));
    // 兜底：关不干净也别僵在这里
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
