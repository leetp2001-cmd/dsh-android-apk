"use strict";
/**
 * 运行期配置：所有环境变量与路径的唯一来源。
 *
 * 其他模块不直接读 process.env —— 想改默认值、加新开关，只改这一个文件，
 * 便于一眼看清「这个服务到底受哪些外部因素影响」。
 */

const path = require("node:path");
const os = require("node:os");

/** 仓库根目录（本文件在 src/ 下） */
const ROOT = path.join(__dirname, "..");

/** dsh 的安装/数据目录。自定义安装位置的人用 DSH_HOME 覆盖。 */
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");

/**
 * 可写的状态目录：口令、边缘密钥、推送配置都落这里。
 *
 * 两种跑法，目录必须分开：
 *   · 直接 `./start.sh` —— 包目录就是工作目录，STATE_DIR === ROOT，和以前完全一致
 *   · 作为 dsh 插件被安装 —— 包在 node_modules 下，权限只读、升级时整个替换。
 *     私密文件写进去会丢，所以退到 ~/.dsh/dsh-android-apk
 *
 * 静态资源（PUBLIC_DIR）始终跟着包走，它是只读的，不需要搬。
 * 显式指定用 DSH_APP_STATE_DIR。
 */
function resolveStateDir(root) {
  if (process.env.DSH_APP_STATE_DIR) return process.env.DSH_APP_STATE_DIR;
  // 被包管理器安装时，路径里会出现 node_modules；源码目录不会
  return /[\\/]node_modules[\\/]/.test(root)
    ? path.join(DSH_HOME, "dsh-android-apk")
    : root;
}

const STATE_DIR = resolveStateDir(ROOT);

// 插件态下这个目录是新出现的（~/.dsh/dsh-android-apk），得自己建。
// 源码目录跑时 STATE_DIR === ROOT，一定已存在，这行是空操作。
// 建不出来不致命：口令会退化成「每次启动重新生成」，其余功能照常。
try {
  if (STATE_DIR !== ROOT) require("node:fs").mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
} catch (error) {
  console.warn(`[dsh-app] 无法创建状态目录 ${STATE_DIR}：${error.message}（口令将不落盘）`);
}

/**
 * dsh web 的监听地址（host:port），不是完整 URL。
 *
 * 默认 3080 —— 这是 dsh 自己的默认值（`dsh --dump-default-config --profile web`
 * 里写的是 `ctx.webStartup.port ?? 3080`）。
 *
 * 如果你启动 dsh 时显式指定了别的端口，比如
 *     dsh web --port 8742
 * 那这里也要跟着改：
 *     DSH_AUTHORITY=127.0.0.1:8742 ./start.sh
 *
 * 拿不准自己的 dsh 在哪个体上：`./doctor.sh` 会直接告出来。
 */
const DSH_AUTHORITY = process.env.DSH_AUTHORITY || "127.0.0.1:3080";

module.exports = {
  ROOT,
  PUBLIC_DIR: path.join(ROOT, "public"),
  STATE_DIR,

  DSH_HOME,
  DSH_AUTHORITY,
  DSH_ORIGIN: `http://${DSH_AUTHORITY}`,

  /** 本服务监听 */
  PORT: Number(process.env.DSH_APP_PORT || 8760),
  BIND_HOST: process.env.DSH_APP_BIND || "127.0.0.1",

  /** 本机私有文件（源码目录跑时在仓库根，已被 .gitignore 挡住；插件态在 STATE_DIR） */
  PASSPHRASE_FILE: path.join(STATE_DIR, ".passphrase"),
  EDGE_SECRET_FILE: path.join(STATE_DIR, ".edge-secret"),
  PUSH_CONFIG_FILE: path.join(STATE_DIR, ".push.json"),

  /** 口令可用环境变量直接给，省去落盘 */
  PASSPHRASE_FROM_ENV: process.env.DSH_APP_PASS || "",
  EDGE_SECRET_FROM_ENV: process.env.DSH_EDGE_SECRET || "",
};
