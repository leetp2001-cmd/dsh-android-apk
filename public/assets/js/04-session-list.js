/**
 * 会话列表：拉取、防重入、失败退避。
 *
 * 关键：手机走公网隧道时这个请求可能十几秒。旧实现有两个致命问题：
 *   1) sessionsLoaded 只有成功才置 true，等待期间侧栏是纯空白（连骨架屏都没有）
 *      → 用户看到的就是"会话全不见了"；
 *   2) 10s 轮询无防重入，请求慢于轮询间隔就层层堆叠，把本已窄的隧道彻底堵死。
 * 两个都在这里解决。
 */

"use strict";

// ---------- 会话列表 ----------
// 关键：手机走公网隧道时这个请求可能十几秒。旧实现有两个致命问题：
// 1) sessionsLoaded 只有成功才置 true，等待期间侧栏是纯空白（连骨架屏都没有）
//    → 用户看到的就是"会话全不见了"；
// 2) 10s 轮询无防重入，请求慢于轮询间隔就层层堆叠，把本已窄的隧道彻底堵死。
let listInFlight = false;      // 防重入：同一时刻只允许一个 session/list 在飞
let listPending = false;       // 飞行期间的补充请求（例如点了"加载更多"），落地后立刻补跑
let listFailStreak = 0;        // 连续失败次数，用于给用户可见反馈
let listRetryTimer = null;
let listScrollMark = 0;        // 上次记录的侧栏 scrollTop，用来区分"用户往下滚"与"重绘触发的 scroll"
let listScrollQuietUntil = 0;  // 重绘后的一小段静默期：期间的 scroll 事件不当作用户滚动
// 分页：历史会话全部保留（不按时间裁剪），只是首屏先要 20 条
// （服务端切片，见 server.js LIST_PAGE），滚到底/点「加载更多」再要下一批。
// listWant = 0 表示"全部"（只在搜索需要跨全量命中时临时用）。
const LIST_PAGE_DEFAULT = 20;
state.listWant = LIST_PAGE_DEFAULT;
state.listAllForSearch = false; // 当前"全量"是不是因为搜索临时拉开的
state.listMoreBusy = false;
state.groupsPinnedOpen = false; // 用户点过"加载更多"：此后不再折叠单日大组
state.listMeta = null;         // { total,kept,limit,shown,hasMore,... } 服务端回填
const lgroupExpanded = new Set(); // 用户手动展开的日期分组 key（大组默认折叠）
function renderListSkeleton() {
  if (state.sessionsLoaded) return;
  const list = $("session-list");
  if (!list || list.children.length) return; // 已有骨架屏就别反复刷
  list.innerHTML = new Array(5).fill('<div class="skel"><div class="l l1"></div><div class="l l2"></div></div>').join("");
}
async function refreshSessions() {
  // 上一轮还没回来：记下"有人还想要新数据"，等落地后补跑一次，
  // 否则点了「加载更多」正好撞上 15s 轮询就会静默失效（点了没反应）。
  if (listInFlight) { listPending = true; return; }
  listInFlight = true;
  if (listRetryTimer) { clearTimeout(listRetryTimer); listRetryTimer = null; }
  if (!state.sessionsLoaded) renderListSkeleton(); // 首屏立刻给骨架，别留纯白
  try {
    const t0 = performance.now();
    // 始终从 offset 0 取前 limit 条：数据在变（新会话不断插到最前），
    // 用 offset 翻页会出现重复/漏条；取"前 N 条"既幂等又不会错位。
    const value = await rpc("session/list", {
      _request: {},
      _app: { limit: state.listWant, pin: state.sessionId || undefined },
    });
    const items = value.items || [];
    // 服务端已把当前会话补进这一页（pin）；这里再兜一次，防止服务端没补上
    // （旧版本后端 / 异常分支）—— 找不到这个会话会让排队条、标题查找、
    // 回前台自愈全部静默失效。
    if (state.sessionId && !items.some((x) => x.sessionId === state.sessionId)) {
      const prev = state.sessions.find((x) => x.sessionId === state.sessionId);
      if (prev) items.push({ ...prev, __outsideWindow: true });
    }
    state.sessions = items;
    state.listMeta = value.appListMeta || null;
    state.sessionsLoaded = true;
    listFailStreak = 0;
    state.listMoreBusy = false;
    state.listLoadMs = Math.round(performance.now() - t0);
    // 渲染前先摘掉"在飞"标记：renderListMore 用它判断要不要显示"加载中…"，
    // 否则这一帧永远画成加载中，按钮根本不出现（点了也没得点）。
    listInFlight = false;
    renderSessions();
    renderQueueBar(); // 队列状态跟着列表一起刷新（session/list 自带 inbox 投影）
    // 列表里的投影是 token/todo 的另一个来源：follow 流未开或刚切换时靠它兜底
    if (!state.projVals) {
      const cur = state.sessions.find((x) => x.sessionId === state.sessionId);
      if (cur?.projections?.values) state.projVals = cur.projections.values;
    }
    renderCtxPill();
    renderTodoBar();
    // 列表是 running 的权威来源：在别的端中断、或事件流漏了 turn/end 时靠它纠正按钮
    const cur = state.sessions.find((x) => x.sessionId === state.sessionId);
    if (cur) setRunning(!!cur.running);
  } catch (e) {
    state.listMoreBusy = false;
    listFailStreak++;
    // 首屏失败必须可见：否则用户只会看到空白，不知道是在加载还是坏了
    if (!state.sessionsLoaded) {
      const list = $("session-list");
      if (list) {
        list.innerHTML =
          `<div class="empty" style="margin-top:40px;font-size:13px;line-height:1.7">` +
          `会话列表加载失败<br><span style="color:var(--muted);font-size:11.5px">${esc(e.message || "")}</span><br>` +
          `<button id="list-retry" style="margin-top:10px;padding:6px 14px">重试</button></div>`;
        const btn = $("list-retry");
        if (btn) btn.onclick = () => { state.sessionsLoaded = false; refreshSessions(); };
      }
    } else if (listFailStreak >= 3) {
      toast("会话列表刷新失败，网络可能不稳");
    }
    // 失败后退避重试（5s、10s、20s，最多 30s），比 10s 死轮询温和
    const delay = Math.min(5000 * 2 ** (listFailStreak - 1), 30000);
    if (listFailStreak <= 4) listRetryTimer = setTimeout(() => { listRetryTimer = null; refreshSessions(); }, delay);
  } finally {
    listInFlight = false;
    if (listPending) {
      listPending = false;
      // 微任务里再跑，避免同步递归把调用栈叠起来
      setTimeout(() => refreshSessions(), 0);
    }
  }
}
