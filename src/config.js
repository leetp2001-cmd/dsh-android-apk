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

  DSH_HOME,
  DSH_AUTHORITY,
  DSH_ORIGIN: `http://${DSH_AUTHORITY}`,

  /** 本服务监听 */
  PORT: Number(process.env.DSH_APP_PORT || 8760),
  BIND_HOST: process.env.DSH_APP_BIND || "127.0.0.1",

  /** 本机私有文件（都在仓库根，已被 .gitignore 挡住） */
  PASSPHRASE_FILE: path.join(ROOT, ".passphrase"),
  EDGE_SECRET_FILE: path.join(ROOT, ".edge-secret"),
  PUSH_CONFIG_FILE: path.join(ROOT, ".push.json"),

  /** 口令可用环境变量直接给，省去落盘 */
  PASSPHRASE_FROM_ENV: process.env.DSH_APP_PASS || "",
  EDGE_SECRET_FROM_ENV: process.env.DSH_EDGE_SECRET || "",
};
