"use strict";
/**
 * ws 依赖的唯一入口。
 *
 * 单独包一层是为了让「怎么找到 ws」这件事只在一个地方发生：
 * src/lib/resolve-ws.js 按多路径探测，这里把它定型成导出。
 */
module.exports = require("./resolve-ws.js");
