"use strict";
/**
 * 静态资源：public/ 下的页面、样式、脚本、图标、APK。
 *
 * ## 两个特殊性
 *   1. **免鉴权白名单**：manifest / SW / 图标 / 安装包必须能在没有 cookie 时拉取
 *      —— 浏览器请求这些资源时不带 cookie（SW 与 manifest 尤其如此）。
 *   2. **APK 支持 Range**：9MB 安装包在手机弱网上需要断点续传。
 *
 * ## 缓存
 * 页面与脚本禁止中间层缓存：手机端顽固的旧 index.html 会让所有修复"看不见"。
 * 图标与 APK 可以缓存（内容寻址或体积大，重复拉取代价高）。
 */

const fs = require("node:fs");
const path = require("node:path");

const { PUBLIC_DIR } = require("../config");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

const APK_MIME = "application/vnd.android.package-archive";

/**
 * 无 cookie 也要能取到的资源。
 * 都是不含任何用户数据的东西 —— 放行不会泄漏，不放行则 PWA 装不上。
 */
const PUBLIC_PATHS = new Set([
  "/manifest.webmanifest",
  "/sw.js",
  "/icon-192.png",
  "/icon-512.png",
  "/apple-touch-icon.png",
  "/dsh-console.apk",
  "/ntfy.apk",
]);

/** 只有这两个后缀禁止中间层缓存 */
const NO_STORE_EXT = /\.(html|js|css)$/;

function mimeOf(abs) {
  if (abs.toLowerCase().endsWith(".apk")) return APK_MIME;
  return MIME[path.extname(abs).toLowerCase()] || "application/octet-stream";
}

/**
 * 把 URL 路径解析成 public/ 下的绝对路径。
 * 越界（../）一律返回 null —— 这是唯一的外部输入拼进文件系统的位置。
 */
function resolvePath(urlPath) {
  const rel = urlPath === "/" ? "/index.html" : urlPath;
  // normalize 之后仍可能含 ../，再显式剥掉前导的，
  // 最后用 startsWith 兜底（public 自身被拼进去才不会误伤前缀相同的兄弟目录）
  const cleaned = path.normalize(rel).replace(/^(\.\.[/\\])+/, "");
  const abs = path.join(PUBLIC_DIR, cleaned);
  if (abs !== PUBLIC_DIR && !abs.startsWith(PUBLIC_DIR + path.sep)) return null;
  return abs;
}

function statFile(abs) {
  try {
    const st = fs.statSync(abs);
    return st.isFile() ? st : null;
  } catch {
    return null;
  }
}

/**
 * 处理 APK 下载，含 Range 支持。
 * @returns {boolean} 是否已经接管响应
 */
function serveApk(req, res, send, abs) {
  const size = fs.statSync(abs).size;
  const headers = {
    "Content-Type": APK_MIME,
    "Content-Disposition": `attachment; filename="${path.basename(abs)}"`,
    // 9MB 安装包，按 Range 支持断点续传/浏览器停走恢复；手机弱网很常见
    "Accept-Ranges": "bytes",
  };

  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (m) {
      const start = m[1] ? parseInt(m[1], 10) : 0;
      const end = m[2] ? parseInt(m[2], 10) : size - 1;
      if (start <= end && end < size) {
        res.writeHead(206, {
          ...headers,
          "Content-Range": `bytes ${start}-${end}/${size}`,
          "Content-Length": String(end - start + 1),
        });
        fs.createReadStream(abs, { start, end }).pipe(res);
        return true;
      }
    }
  }

  res.writeHead(200, { ...headers, "Content-Length": String(size) });
  fs.createReadStream(abs).pipe(res);
  return true;
}

/**
 * 尝试回一个静态文件。
 * @returns {boolean} true = 已经处理完；false = 交给调用方（通常回 404）
 */
function serveStatic(req, res, send, urlPath) {
  const abs = resolvePath(urlPath);
  if (!abs) return false;

  const st = statFile(abs);
  if (!st) return false;

  if (abs.toLowerCase().endsWith(".apk")) return serveApk(req, res, send, abs);

  const headers = { "Content-Type": mimeOf(abs) };
  if (NO_STORE_EXT.test(abs)) {
    headers["Cache-Control"] = "no-cache, no-store, must-revalidate";
  }
  send(200, headers, fs.readFileSync(abs));
  return true;
}

/** 该路径是否属于免鉴权白名单 */
function isPubliclyReadable(urlPath) {
  return PUBLIC_PATHS.has(urlPath);
}

module.exports = { serveStatic, isPubliclyReadable, MIME, PUBLIC_PATHS, PUBLIC_DIR };
