/**
 * 会话列表渲染：日期分组、折叠、分页、搜索、滚动位置保持。
 *
 * 这个文件几乎每个函数都在处理同一个矛盾的两种表现：
 *   · 重绘会清空 innerHTML → 滚动位置归零
 *   · 但要保持滚动位置，就得判断"用户原本在哪" → 而首屏骨架屏比列表短
 *     → 任何"是否到底"的推断都会误判 → 首屏直接跳到底部
 * 结论：判据必须包含 prevTop > 0，见 renderSessions 里的注释。
 */

"use strict";

function renderSessions() {
  const kw = $("search").value.trim().toLowerCase();
  const list = $("session-list");
  // 首次加载：骨架屏
  if (!state.sessionsLoaded) {
    list.innerHTML = new Array(5).fill('<div class="skel"><div class="l l1"></div><div class="l l2"></div></div>').join("");
    return;
  }
  // 重绘会清空 innerHTML，滚动位置随之归零 —— 15s 轮询一次就把正在往下翻的人弹回顶部。
  // 这里记住再还原。判据只用"原本 scrollTop > 0"：首次渲染时列表里只有骨架屏，
  // scrollHeight 小得可怜，任何"是否到底"的推断都会成立，首屏就会直接跳到最底部
  // （看到的是最老的会话，而不是今天最新的）。
  const prevTop = list.scrollTop;
  const prevH = list.scrollHeight;
  // 必须要求"原本已经滚下去了"（prevTop > 0）才算"在底部"：
  // 骨架屏比列表短得多，此时 scrollHeight - 0 - clientHeight < 0 永远成立，
  // 不加这个条件首屏会直接跳到底部，用户打开看到的是最老的会话。
  const wasNearBottom = prevTop > 0 && prevH - prevTop - list.clientHeight < 80;
  list.innerHTML = "";
  let shown = 0;
  // 先按日期分组（同一天可能有上百个会话，例如批量跑的 bench），
  // 组内超过阈值就折叠，只展开最近的那一组 —— 否则手机上一屏全被同一天占满。
  const groups = [];
  const byKey = new Map();
  for (const s of state.sessions) {
    // 子代理会话在手机端打不开（dsh 要求经父会话地址访问），列表过滤避免误点
    if (s.origin === "subagent" || s.parentSessionId) continue;
    const title = s.projections?.values?.title || "(未命名)";
    if (kw && !title.toLowerCase().includes(kw) && !(s.cwd || "").toLowerCase().includes(kw)) continue;
    const g = dayGroup(s.updatedAt);
    if (!byKey.has(g)) {
      const rec = { key: g, items: [] };
      byKey.set(g, rec);
      groups.push(rec);
    }
    byKey.get(g).items.push({ s, title });
  }
  const GROUP_FOLD_AT = 25; // 超过这个数就要折叠
  for (const rec of groups) {
    // 用户已经手动"加载更多"过，说明他就是想往下看：此时不再折叠，
    // 否则一点加载更多，当天的组越过阈值被整个收起来，用户看到的是"列表空了"。
    const collapsible = rec.items.length > GROUP_FOLD_AT && !state.groupsPinnedOpen;
    // 大组默认折叠，用户点开过才保持展开；搜索时一律展开（既然在搜就别让人再多点一次）；
    // 正在看的会话所在组永远展开，否则一刷新就"当前会话从列表里消失"
    const hasActive = !!state.sessionId && rec.items.some((x) => x.s.sessionId === state.sessionId);
    const open = !collapsible || !!kw || hasActive || lgroupExpanded.has(rec.key);

    const h = document.createElement("div");
    h.className = "dgroup" + (collapsible ? " foldable" : "");
    h.innerHTML = collapsible
      ? `<span>${esc(rec.key)}</span><span class="dcount">${rec.items.length} 个 ${open ? "▾" : "▸"}</span>`
      : `<span>${esc(rec.key)}</span><span class="dcount">${rec.items.length}</span>`;
    if (collapsible) {
      h.title = open ? "收起这一天" : "展开这一天";
      h.onclick = () => {
        if (lgroupExpanded.has(rec.key)) lgroupExpanded.delete(rec.key);
        else lgroupExpanded.add(rec.key);
        renderSessions();
      };
    }
    list.appendChild(h);
    if (!open) continue;

    for (const { s, title } of rec.items) {
      shown++;
      const div = document.createElement("div");
      // P1-2 列表健康状态：agentAvailable=false 的会话在 dsh 侧已打不开（agent 被卸载/迁移）。
      // 原实现点进去才报"会话加载失败"，用户分不清是网络还是会话本身废了。
      const dead = s.agentAvailable === false;
      const migrating = s.formatStatus === "migration-required";
      // running 但 updatedAt 落后超过 5 分钟 → 疑似卡在审批/工具执行（配合强制中断逃生）
      const stuck = s.running === true && s.updatedAt && Date.now() - s.updatedAt > 5 * 60 * 1000;
      div.className = "sess" + (s.sessionId === state.sessionId ? " active" : "") + (dead ? " dead" : "");
      const shortCwd = (s.cwd || "").split("/").filter(Boolean).slice(-1)[0] || "?";
      div.innerHTML = `
        ${s.running ? '<span class="run"></span>' : ""}
        <div class="t">${esc(title)}${dead ? '<span class="tag">已失效</span>' : migrating ? '<span class="tag">需迁移</span>' : stuck ? '<span class="tag stuck">⚠ 疑似卡死</span>' : ""}</div>
        <div class="s"><span class="cwd-chip">${esc(shortCwd)}</span><span>${relTime(s.updatedAt)}</span></div>`;
      div.onclick = () => {
        if (dead) { toast("该会话已失效（agent 已卸载或迁移），无法打开"); return; }
        openSession(s);
      };
      list.appendChild(div);
    }
  }
  const matched = groups.reduce((n, r) => n + r.items.length, 0);
  if (!matched) {
    list.innerHTML = '<div class="empty" style="margin-top:40px;font-size:13px">没有匹配的会话</div>';
  }
  renderListFoot(matched, shown, !!kw);
  renderListMore();
  // 还原滚动位置：内容变长时停在原来的条目上（不要因为插入了新会话就跳走）；
  // 原本就在底部则贴住新的底部（加载更多之后视线不该被拉回顶部）。
  if (wasNearBottom) {
    list.scrollTop = list.scrollHeight;
    listScrollMark = list.scrollTop;
  } else if (prevTop > 0) {
    list.scrollTop = Math.min(prevTop, list.scrollHeight - list.clientHeight);
    listScrollMark = list.scrollTop;
  }
  // 程序性改动滚动位置会派发 scroll；给 250ms 静默期，避免被误判成"用户滑到底"。
  listScrollQuietUntil = performance.now() + 250;
}

// 会话按本地日期分组：今天 / 昨天 / 10月27日 …
function dayGroup(ts) {
  if (!ts) return "更早";
  const d = new Date(ts), n = new Date();
  const startOf = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((startOf(n) - startOf(d)) / 86400000);
  if (diff <= 0) return "今天";
  if (diff === 1) return "昨天";
  if (diff < 7) return `${diff} 天前`;
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
}

// 列表末尾的「加载更多」：分页才是真正省流量的手段（首屏 20 条）。
// 放在列表内部最后，滚到底自然可见；滚到底也会自动触发（见 #session-list 的 scroll 监听）。
function renderListMore() {
  const old = $("list-more");
  if (old) old.remove();
  const meta = state.listMeta;
  if (!meta || !meta.limit || !meta.hasMore) return; // 没分页 or 已到底
  const list = $("session-list");
  const rest = Math.max(0, (meta.kept || 0) - (state.listWant || 0));
  const box = document.createElement("div");
  box.id = "list-more";
  box.innerHTML = state.listMoreBusy || listInFlight
    ? `<span class="lm-busy">加载中…</span>`
    : `<button id="list-more-btn">↓ 加载更多${rest > 0 ? `（还有 ${rest} 个）` : ""}</button>`;
  list.appendChild(box);
  const b = $("list-more-btn");
  if (b) b.onclick = (e) => { e.stopPropagation(); loadMoreSessions(); };
}

// 加载下一批：把 listWant 加大一页再整段重取（服务端始终回"前 N 条"，
// 这样新会话插到最前也不会造成重复行或跳条）。
async function loadMoreSessions() {
  if (state.listMoreBusy) return;
  const meta = state.listMeta;
  if (!meta || !meta.hasMore) return;
  state.listMoreBusy = true;
  // 用户主动要更多 → 别再拿"单日大组折叠"盖回去：否则点了加载更多，
  // 这一天的组一下越过折叠阈值，条目全被收起来，看起来像"点了反而空了"。
  state.groupsPinnedOpen = true;
  // 步长用服务端的默认页大小（meta.pageSize），不能用"当前 limit"——
  // 那是窗口大小，加自己就成指数增长（20→40→80→160），一页变全量。
  const step = meta.pageSize || LIST_PAGE_DEFAULT;
  state.listWant = Math.min(meta.kept || Infinity, (state.listWant || 0) + step);
  renderListMore();
  await refreshSessions();
  state.listMoreBusy = false;
}

// 侧栏底部：只做统计（已加载 / 共 N 个），不再有时间窗开关 ——
// 历史会话全部保留，翻页即可看到，不需要"只看最近 N 天"这种裁剪。
// matched = 当前已加载并命中搜索的会话数；shown = 实际渲染到 DOM 的（折叠组不计）
function renderListFoot(matched, shown, searching) {
  const old = $("list-foot");
  if (old) old.remove();
  const list = $("session-list");
  const meta = state.listMeta;
  const totalAll = meta?.total || matched;
  const keptN = meta?.kept || matched;
  const box = document.createElement("div");
  box.id = "list-foot";
  // 分页后「已加载数」和「总数」是两回事，必须都标出来，
  // 否则用户只看到 20 条会以为老会话被删了。
  let countTxt;
  if (searching) {
    countTxt = keptN > matched ? `匹配 ${matched}/${keptN}` : `匹配 ${matched} 个`;
  } else if (keptN > matched) {
    countTxt = `${matched}/${keptN}`;
  } else {
    countTxt = `${keptN} 个`;
  }
  if (shown < matched) countTxt += ` · 已展开 ${shown}`;
  // 全部加起来的会话数（含未加载）放 title，主文案保持短
  box.innerHTML = `<span title="共 ${totalAll} 个会话">${countTxt}</span>`;
  list.parentElement.appendChild(box);
}
$("search").oninput = () => {
  // 搜索必须搜全量：只搜已加载的 20 条会给出"明明有却搜不到"的错觉。
  // 一开始输入就把窗口拉到全部（一次性），清空后再回到 20 条。
  const kw = $("search").value.trim();
  const meta = state.listMeta;
  if (kw && meta?.hasMore && !state.listAllForSearch) {
    state.listAllForSearch = true;
    state.listWant = 0;
    refreshSessions();
    return;
  }
  if (!kw && state.listAllForSearch) {
    state.listAllForSearch = false;
    state.listWant = LIST_PAGE_DEFAULT;
    refreshSessions();
    return;
  }
  renderSessions();
};

// 侧栏滚到底 → 自动加载下一批（手机上不必再点按钮）
// 关键约束：重绘后浏览器自己会派发 scroll（滚动位置被代码改过），
// 不区分的话会连环翻页（点一次加载更多变 40→80→160）。用"重绘后静默期"挡掉这些杂音。
$("session-list").addEventListener("scroll", () => {
  if (performance.now() < listScrollQuietUntil) return; // 刚重绘完，忽略程序性 scroll
  const box = $("session-list");
  if (!box) return;
  if (box.scrollHeight - box.scrollTop - box.clientHeight > 80) return;
  const meta = state.listMeta;
  if (!meta?.hasMore || state.listMoreBusy || listInFlight) return;
  if ($("search").value.trim()) return; // 搜索态是全量，不需要翻页
  loadMoreSessions();
}, { passive: true });
