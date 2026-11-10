"use strict";
/**
 * 定位 ws（WebSocket 库）。
 *
 * 为什么要这么麻烦：本项目刻意不打包 node_modules，`ws` 是唯一的外部依赖。
 * 它几乎总是已经在机器上了——任何装了 dsh 的人都会顺带装上（dsh 的
 * dsh-api-gateway / dsh-experimental-inspector 都依赖 ws ^8.21.3）。
 * 但「装在哪」因人而异：
 *
 *   - 标准全局安装      npm i -g @deepseek-ai/dsh  →  <npm root -g>/@deepseek-ai/...
 *   - 独立安装根（本项目作者用）                    →  ~/.dsh/packages/dsh-install/node_modules
 *   - 仓库内自己装一份  npm i                      →  ./node_modules/ws
 *   - Node 能从上层解析  NODE_PATH 或其他布局       →  require.resolve("ws")
 *
 * 所以这里按顺序探，全都不中再报一个能照着做的错，而不是抛
 * "Cannot find module" 让人去猜。
 */
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
/** 仓库根目录（本文件在 src/lib/ 下） */
const ROOT = path.join(__dirname, "..", "..");

/** npm 全局根目录。取不到就返回 null（没装 npm 也不该因此崩） */
function npmGlobalRoot() {
  try {
    return execFileSync("npm", ["root", "-g"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    }).trim() || null;
  } catch {
    return null;
  }
}

/** ws 是否是可用的一坨（有 package.json 且主入口在） */
function looksUsable(dir) {
  try {
    if (!dir) return false;
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    if (pkg.name !== "ws") return false;
    const main = pkg.main || "index.js";
    return fs.existsSync(path.join(dir, main));
  } catch {
    return false;
  }
}

const candidates = [];
const push = (...segs) => {
  if (segs.every(Boolean)) candidates.push(path.join(...segs));
};

// 1) 仓库自己装的那份优先（用户显式 npm i 的意图最明确）
push(ROOT, "node_modules", "ws");
// 2) 独立安装根：~/.dsh/packages/dsh-install/node_modules
push(DSH_HOME, "packages", "dsh-install", "node_modules", "ws");
// 3) 顺手扫 ~/.dsh 下其他可能的嵌套位置（不同版本的目录布局略有差异）
try {
  for (const entry of fs.readdirSync(path.join(DSH_HOME, "packages"))) {
    push(DSH_HOME, "packages", entry, "node_modules", "ws");
  }
} catch {}
// 4) npm 全局根：标准 `npm i -g @deepseek-ai/dsh` 的落点
const gRoot = npmGlobalRoot();
push(gRoot, "ws");
// dsh 也可能把 ws 嵌在自己依赖树里
push(gRoot, "@deepseek-ai", "dsh", "node_modules", "ws");
try {
  for (const entry of fs.readdirSync(path.join(gRoot || "/nonexistent", "@deepseek-ai"))) {
    push(gRoot, "@deepseek-ai", entry, "node_modules", "ws");
  }
} catch {}
// 5) 交给 Node 自己的解析（NODE_PATH、monorepo 上层等）
try {
  const r = require.resolve("ws");
  // r 形如 .../ws/index.js，回退到包根
  candidates.push(path.dirname(r));
} catch {}

const found = candidates.find(looksUsable);

if (!found) {
  const hint = [
    "找不到 ws（本项目唯一的外部依赖，请任选一种方式装上）：",
    "",
    "  A. 在仓库目录执行        npm install",
    "  B. 全局安装              npm i -g ws",
    "  C. 装了 dsh 但路径特殊    DSH_HOME=/你的/dsh/路径 ./start.sh",
    "",
    "已尝试以下位置：",
    ...candidates.map((c) => "  - " + c),
    "",
    `参考：DSH_HOME=${DSH_HOME}，npm root -g=${gRoot || "(npm 不可用)"}`,
  ].join("\n");
  console.error("\n" + hint + "\n");
  process.exit(1);
}

module.exports = require(found);
module.exports.__resolvedFrom = found;
