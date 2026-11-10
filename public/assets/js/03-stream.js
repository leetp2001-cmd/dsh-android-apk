/**
 * 流式通道：WebSocket 管道 + 手机端自愈 + 投影实时流。
 *
 * 这一层是"应用能不能活着"的关键。三个设计要点：
 *   1. 防重入：自愈与 onclose 重连可能并发触发，必须只保留一条连接
 *   2. 重放：断线期间发的 open 帧要重放，否则订阅静默失效
 *   3. 水位：投影按 seq 判新旧，避免旧 baseline 盖掉新快照
 */

"use strict";

// ---------- dsh 流式通道（WS 管道） ----------
function connectStream() {
  // 防重入：已有存活/连接中的管道不重复建（自愈与 onclose 重连可能并发触发）
  const cur = state.stream;
  if (cur && (cur.readyState === WebSocket.OPEN || cur.readyState === WebSocket.CONNECTING)) return;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/stream`);
  state.stream = ws;
  state._wsConnectingSince = Date.now();
  ws.onopen = () => { state._wsConnectingSince = null; };
  ws.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.type === "upstream-open") {
      state.streamReady = true;
      // 重放未完成的 open（含 $events 订阅）
      for (const [sid, entry] of state.pendingOpen) ws.send(JSON.stringify(entry.frame));
      // 投影实时流：断线时 upstream 侧订阅已失效，必须重订，否则仪表停在旧值
      state.controlStreamId = null;
      ensureControlStream();
      updateConn(true);
      return;
    }
    if (m.type === "app-error") { updateConn(false); return; }
    const entry = state.pendingOpen.get(m.streamId);
    if (!entry) return;
    if (m.type === "item") entry.onItem?.(m.value);
    else if (m.type === "end") { state.pendingOpen.delete(m.streamId); entry.onEnd?.(); }
    else if (m.type === "error") { state.pendingOpen.delete(m.streamId); entry.onError?.(m.error); }
  };
  ws.onclose = () => {
    state.streamReady = false;
    state._wsConnectingSince = null;
    updateConn(false);
    // 可取消的重连计时：自愈逻辑可抢先立即重建，避免双连接
    if (state._reconnectTimer) clearTimeout(state._reconnectTimer);
    state._reconnectTimer = setTimeout(() => {
      state._reconnectTimer = null;
      connectStream(); // 内部防重入
    }, 2500);
  };
}

// ---------- 手机端生存保障：回前台/网络恢复自愈 ----------
// iOS 后台挂起会静默回收 WebSocket：onclose 不触发、后台定时器不执行，
// 表现为"消息发得出（HTTP/RPC 通）、回复全无（事件流死）"。
// 回前台/网络恢复时必须主动探测 readyState，不能只依赖 onclose。
function streamSelfHeal() {
  const ws = state.stream;
  const rs = ws ? ws.readyState : WebSocket.CLOSED;
  if (rs === WebSocket.OPEN) {
    // 管道活着：重拉当前会话，兜底静默期可能漏收的事件（快照全量重放）
    const cur = state.sessions.find((x) => x.sessionId === state.sessionId);
    if (!cur) return;
    const drawerWasOpen = sidebar.classList.contains("open");
    openSession(cur); // 内部会 abort 旧 follow 并重放 snapshot
    if (drawerWasOpen) toggleDrawer(true); // openSession 会收抽屉，恢复用户原状
    return;
  }
  if (rs === WebSocket.CONNECTING && state._wsConnectingSince && Date.now() - state._wsConnectingSince < 8000) {
    return; // 正在连接且未超时，等它自己完成
  }
  // 已关闭或连接卡死（>8s）：清掉排队的重连，立即重建
  if (state._reconnectTimer) { clearTimeout(state._reconnectTimer); state._reconnectTimer = null; }
  if (ws && rs === WebSocket.CONNECTING) { try { ws.close(); } catch {} }
  connectStream();
  toast("事件流已重连，正在同步最新内容", "ok");
}
function streamOpen(endpoint, payload, handlers) {
  const streamId = "s" + state.nextStreamId++;
  const entry = { frame: { type: "open", streamId, endpoint, payload }, ...handlers };
  state.pendingOpen.set(streamId, entry);
  if (state.stream?.readyState === WebSocket.OPEN && state.streamReady) {
    state.stream.send(JSON.stringify(entry.frame));
  }
  return streamId;
}
function streamCancel(streamId) {
  state.stream?.send(JSON.stringify({ type: "cancel", streamId }));
  state.pendingOpen.delete(streamId);
}

// ---------- 投影实时流（session/control） ----------
// 为什么必须单独开流：dsh 的 tokenUsage / contextPressure / todos / permissions
// 这些投影【不】随 session/follow 下发增量，只出现在两个地方：
//   1) follow 的 snapshot.projections.values（打开会话那一刻的快照）
//   2) session/control 流 —— 每代先发一帧 baseline（覆盖所有活跃会话），
//      之后每个 key 变化发一帧扁平的 {sessionId, key, value, seq}
// 少了这条流，仪表就永远停在"打开会话时"的数字，跑完一整轮也不动。
// 帧形状实测（@deepseek-ai/dsh-api-session-controller types.d.ts:540）：
//   { type:'baseline',   value:{ projections: { [sessionId]: {asOfSeq, values} } } }
//   { type:'projection', sessionId, key, value, seq }
function ensureControlStream() {
  if (state.controlStreamId) return;
  state.controlStreamId = streamOpen("session/control", { args: {} }, {
    onItem: (v) => {
      if (!v) return;
      if (v.type === "baseline") {
        const all = v.value?.projections || {};
        // baseline 只覆盖活跃会话。它和 follow 的 snapshot 谁先到不确定，
        // 所以用 asOfSeq 做水位比较：只有不比手上旧的才覆盖，避免拿旧值盖新值。
        const mine = all[state.sessionId];
        const asOf = typeof mine?.asOfSeq === "number" ? mine.asOfSeq : null;
        if (mine?.values && (asOf == null || state.projSeq == null || asOf >= state.projSeq)) {
          state.projVals = Object.assign({}, state.projVals || {}, mine.values);
          if (asOf != null) state.projSeq = asOf;
          renderCtxPill(); renderTodoBar();
        }
        return;
      }
      if (v.type === "projection") {
        if (v.sessionId !== state.sessionId) return;
        // 增量帧带 seq，旧帧（乱序/重放）直接丢，避免仪表往回跳
        if (typeof v.seq === "number" && state.projSeq != null && v.seq <= state.projSeq) return;
        if (!state.projVals) state.projVals = {};
        state.projVals[v.key] = v.value;
        if (typeof v.seq === "number") state.projSeq = v.seq;
        renderCtxPill();
        renderTodoBar();
      }
    },
    onEnd: () => { state.controlStreamId = null; },
    onError: () => { state.controlStreamId = null; },
  });
}
// 上游地址不写死：用户可能用 DSH_AUTHORITY 改过端口，
// 顶栏若固定显示 8742 会在排障时误导人。由 /healthz 下发真实值。
state.dshAuthority = ""; // 首次拿到 healthz 后回填
function updateConn(ok) {
  $("conn-dot").className = "dot" + (ok ? " ok" : "");
  const where = state.dshAuthority ? ` ${state.dshAuthority}` : "";
  $("conn-text").textContent = ok ? `已连接${where}` : "连接 dsh 中…";
  refreshSessions();
}
// 拉一次上游地址（失败不影响任何功能，只是顶栏少个后缀）
async function loadAuthority() {
  try {
    const r = await fetch("/healthz", { credentials: "same-origin" });
    const j = await r.json();
    if (j?.authority) {
      state.dshAuthority = j.authority;
      updateConn(true);
    }
  } catch {}
}
