/* dsh 控制台 Service Worker：网络优先 + 静态资源离线兜底；RPC/WS 永远直连 */
/* 版本号变更会让旧缓存整体作废
   v9：会话列表默认只取最近 14 天（可一键切全部）
   v10：会话列表默认只加载 20 条，滚到底分批加载
   v11：历史会话不再按时间裁剪（14 天窗口取消），只保留分页
   v12：整体改亮色主题（浅灰底 + 白卡片），登录页同步
   v13：中断键从顶栏挪到输入栏，状态跟 running 实时同步
   v14：中断键改用 CSS 画图标（⏹ 是彩色 emoji，安卓上染成橙黄跟红色文字撞色）
   v15：消息里可以显示图片 / 发图片（附件走 session/attachment 单独拉取，带缓存）
   v16：发图前先在前端压缩（手机照片 3~5MB，不压走隧道要几分钟）
   v17：前端拆分为 css/ 10 层 + js/ 19 模块，index.html 只剩骨架
   v18：顶栏连接状态显示真实上游地址（原为硬编码 8742，改过端口会误导排障） */
const CACHE = "dshapp-v18";

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (e) => {
  e.waitUntil(
    (async () => {
      // 清掉所有非当前版本的缓存，避免手机端长期持有旧 index.html
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  // 动态请求不缓存不拦截
  if (
    e.request.method !== "GET" ||
    url.pathname.startsWith("/rpc") ||
    url.pathname.startsWith("/auth") ||
    url.pathname.startsWith("/stream")
  ) return;

  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
