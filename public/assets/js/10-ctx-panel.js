/**
 * 上下文 / token 仪表与待办面板。
 *
 * 数据来源：session/follow 的 snapshot.projections.values 与后续
 * session/control 的 projection 增量帧。
 *
 * 全部 optional 读取：dsh 升级改字段名时整块隐藏，不报错。
 * 这是有意的降级策略 —— 少一个仪表不影响聊天，抛错会让整个应用白屏。
 */

"use strict";

// ---------- P0-3 上下文 / token 仪表 ----------
// 数据来源：session/follow 的 snapshot.projections.values 与后续 projection 增量帧。
// 全部 optional 读取：dsh 升级改字段名时整块隐藏，不报错（PLAN 风险表第一条）。
function fmtTok(n) {
  if (typeof n !== "number" || !isFinite(n) || n < 0) return "—";
  if (n < 1000) return String(n);
  if (n < 1000000) return (n / 1000).toFixed(n < 10000 ? 1 : 0).replace(/\.0$/, "") + "K";
  return (n / 1000000).toFixed(2).replace(/\.?0+$/, "") + "M";
}
function ctxData() {
  const s = state.sessions.find((x) => x.sessionId === state.sessionId);
  const pv = state.projVals || s?.projections?.values || {};
  const tu = pv.tokenUsage || null;
  const cp = pv.contextPressure || null;
  const cb = pv.contextBreakdown || null;
  const win = typeof cp?.contextWindow === "number" ? cp.contextWindow : null;
  const used = typeof cp?.pressureTokens === "number" ? cp.pressureTokens
    : typeof cp?.projectedTokens === "number" ? cp.projectedTokens : null;
  const pct = win && used != null ? Math.min(100, Math.round((used / win) * 100)) : null;
  // 真实 schema（实测 session/follow snapshot 的 projections.values）：
  //   modelSelection = { lastUsed: { provider, model, reasoningEffort }, next: {...} }
  //   permissions    = { currentValue }  —— 注意键名是复数 permissions，不是 permissionPreset
  //   agentPreset    = "standard" 之类的纯字符串
  // 三者都可能缺失（对应服务没 compose 时整个键不存在），一律 optional 取值。
  const sel = pv.modelSelection || null;
  const use = sel?.lastUsed || sel?.next || null;
  return {
    tu, cp, cb, win, used, pct,
    model: use?.model || (typeof pv.model === "string" ? pv.model : null),
    effort: use?.reasoningEffort || pv.reasoningEffort || null,
    provider: use?.provider || null,
    preset: typeof pv.agentPreset === "string" ? pv.agentPreset : (pv.preset || null),
    perm: pv.permissions?.currentValue || pv.sandboxMode || null,
    todos: Array.isArray(pv.todos) ? pv.todos : null,
    stats: pv.sessionStats || null,
  };
}
function renderCtxPill() {
  const pill = $("ctx-pill");
  const c = ctxData();
  if (c.pct == null) { pill.style.display = "none"; renderCtxPanel(); return; }
  pill.style.display = "inline-flex";
  pill.className = c.pct >= 85 ? "danger" : c.pct >= 60 ? "warn" : "";
  pill.querySelector(".pfill").style.width = c.pct + "%";
  pill.querySelector(".ptext").textContent = c.pct + "%";
  renderCtxPanel();
}
function renderCtxPanel() {
  const p = $("ctx-panel");
  if (!state.ctxOpen) { p.style.display = "none"; return; }
  const c = ctxData();
  const rows = [];
  if (c.used != null && c.win != null) {
    const lvl = c.pct >= 85 ? "var(--err)" : c.pct >= 60 ? "var(--warn)" : "var(--accent)";
    rows.push(`<div class="ctitle">上下文</div>
      <div class="crow"><span>已用 / 上限</span><b>${fmtTok(c.used)} / ${fmtTok(c.win)} · ${c.pct}%</b></div>
      <div class="cbar"><div class="cbfill" style="width:${c.pct}%;background:${lvl}"></div></div>`);
    if (c.cb) {
      rows.push(`<div class="cbench">系统 ${fmtTok(c.cb.systemTokens)} · 工具 ${fmtTok(c.cb.toolsTokens)} · 消息 ${fmtTok(c.cb.messageTokens)}</div>`);
    }
    if (c.pct >= 85) rows.push(`<div class="cwarn">⚠ 上下文接近上限，建议压缩（/compact）</div>`);
  }
  if (c.tu) {
    rows.push(`<div class="csep"></div><div class="ctitle">累计用量</div>
      <div class="crow"><span>输入（未命中缓存）</span><b>${fmtTok(c.tu.uncachedInputTokens)}</b></div>
      <div class="crow"><span>输入（缓存读）</span><b>${fmtTok(c.tu.cacheReadTokens)}</b></div>
      <div class="crow"><span>输出</span><b>${fmtTok(c.tu.outputTokens)}</b></div>`);
    const cw = c.tu.cacheWriteTokens;
    if (typeof cw === "number" && cw > 0) rows.push(`<div class="crow"><span>缓存写</span><b>${fmtTok(cw)}</b></div>`);
  }
  const meta = [];
  if (c.model) {
    const mm = c.model + (c.effort ? " · " + c.effort : "");
    meta.push(`模型 <code>${esc(mm)}</code>`);
  }
  if (c.preset) meta.push(`预设 <code>${esc(c.preset)}</code>`);
  if (c.perm) meta.push(`权限 <code>${esc(c.perm)}</code>`);
  if (meta.length) rows.push(`<div class="csep"></div>${meta.map((m) => `<div class="crow"><span style="color:var(--muted)">${m}</span></div>`).join("")}`);
  if (c.stats && (c.stats.turns || c.stats.steps)) {
    rows.push(`<div class="csep"></div><div class="crow"><span>轮次 / 步数</span><b>${c.stats.turns || 0} / ${c.stats.steps || 0}</b></div>`);
  }
  if (!rows.length) rows.push('<div class="crow" style="color:var(--muted)">该会话暂无用量数据</div>');
  p.innerHTML = rows.join("");
  p.style.display = "block";
}

// ---------- P1-1 待办面板 ----------
function renderTodoBar() {
  const box = $("todo-bar");
  const c = ctxData();
  const todos = c.todos;
  // 排队条优先（那边有可操作项），互斥时直接让位
  const qbarBusy = $("queue-bar")?.style.display === "block";
  if (!todos || !todos.length || qbarBusy) { box.style.display = "none"; return; }
  const done = todos.filter((t) => t.status === "completed").length;
  const cur = todos.find((t) => t.status === "in_progress");
  box.style.display = "block";
  box.classList.toggle("open", !!state.todoOpen);
  const head = `<div class="thead">
    <span class="tcount">${done}/${todos.length}</span>
    <span class="tcur">${cur ? esc(cur.content) : done === todos.length ? "全部完成" : "待开始"}</span>
    <span class="tarrow">${state.todoOpen ? "▾" : "▸"}</span>
  </div>`;
  const items = todos.map((t) => {
    const icon = t.status === "completed" ? "✅" : t.status === "in_progress" ? "⏳" : "⬜";
    const cls = t.status === "completed" ? "done" : t.status === "in_progress" ? "cur" : "";
    return `<div class="titem ${cls}"><span class="ticon">${icon}</span><span class="ttxt">${esc(t.content)}</span></div>`;
  }).join("");
  box.innerHTML = head + `<div class="tlist">${items}</div>`;
  box.querySelector(".thead").onclick = () => { state.todoOpen = !state.todoOpen; renderTodoBar(); };
}
function toolText(data) {
  try {
    const args = typeof data.arguments === "string" ? JSON.parse(data.arguments) : data.arguments;
    return args?.command || args?.content || args?.filePath || args?.pattern || JSON.stringify(args ?? {});
  } catch { return String(data.arguments ?? ""); }
}
