/**
 * dsh 控制台 · 插件外壳（host 半）
 * =============================================================================
 * 把仓库里那套独立代理服务挂进 dsh 的 cordis 树，使它能：
 *   · 被 `dsh plugin add` 安装，出现在插件管理里，可开关
 *   · 随 dsh 启停，而不是靠人手动跑 start.sh
 *
 * 这里只做生命周期，不碰协议。真正的逻辑全在 ../src 下，一行没搬：
 *   createApp() 装配 → listen() 监听 → close() 收尾
 *
 * 与独立跑法的区别只有一处：作为插件时包在 node_modules 下，
 * 口令/推送配置不能写进包目录（只读、升级即丢），改落 STATE_DIR。
 * 这件事由 src/config.js 自己按路径判断，本文件不管。
 */

export const name = "dsh-android-apk";

/** 不 inject 任何服务：这个插件不消费 dsh 的 webServer，自己开端口。 */
export const inject = [];

/**
 * 装载应用。
 *
 * 失败策略：**不抛出**。端口被占、上游 dsh 没起来之类的错误，
 * 打日志后静默降级——插件加载失败会让整棵 cordis 树启动失败，
 * 那是把「手机端连不上」升级成「桌面端也打不开」，代价完全不对等。
 */
export function apply(ctx, config = {}) {
  // CJS 包用动态 import 拿默认导出；require 在 ESM 上下文里不存在
  let app = null;
  let closed = false;
  let loading = null;

  const log = (msg) => ctx.logger?.info?.(`[dsh-android-apk] ${msg}`) ?? console.log(`[dsh-android-apk] ${msg}`);
  const warn = (msg) => ctx.logger?.warn?.(`[dsh-android-apk] ${msg}`) ?? console.warn(`[dsh-android-apk] ${msg}`);

  async function start() {
    // 配置能在加载期生效的只有环境变量；其余走 config 对象直接覆盖
    if (config.port !== undefined) process.env.DSH_APP_PORT = String(config.port);
    if (config.bind !== undefined) process.env.DSH_APP_BIND = String(config.bind);
    if (config.dshAuthority !== undefined) process.env.DSH_AUTHORITY = String(config.dshAuthority);
    if (config.stateDir !== undefined) process.env.DSH_APP_STATE_DIR = String(config.stateDir);

    const mod = await import("../server.js");
    const startServer = mod.startServer ?? mod.default?.startServer;
    if (typeof startServer !== "function") {
      throw new TypeError("../server.js 没有导出 startServer()");
    }

    app = await startServer();
    if (closed) {
      // dispose 在启动完成前就到了：别留一个没人管的监听
      await app.close().catch(() => {});
      return;
    }
    log(`已启动 → http://${process.env.DSH_APP_BIND ?? "127.0.0.1"}:${process.env.DSH_APP_PORT ?? 8760}`);
  }

  loading = start().catch((error) => {
    if (error?.code === "EADDRINUSE") {
      warn(
        `端口 ${process.env.DSH_APP_PORT ?? 8760} 已被占用 —— 大概率是你还在手动跑 start.sh。` +
          `停掉它，或在插件配置里换一个 port。手机端服务本次未启动。`
      );
      return;
    }
    warn(`启动失败，手机端服务未运行：${error?.message ?? error}`);
  });

  // cordis 的收尾钩子：插件卸载/进程退出时关掉监听和推送定时器
  ctx.effect(() => () => {
    closed = true;
    return loading
      .then(() => (app ? app.close() : undefined))
      .catch(() => {});
  }, "dsh-android-apk: phone console listener");
}
