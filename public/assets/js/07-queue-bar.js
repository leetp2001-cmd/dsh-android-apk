/**
 * 排队条：会话忙时排队的消息，可单条删除 / 插队。
 *
 * dsh 的 queue 模式：会话忙时消息进 inbox，等当前 turn 结束才执行，
 * 期间**没有任何超时**。旧版只在事件里打一行"排队等待"，之后不可见、不可撤，
 * 现象就是"发了消息半天没反应、以为丢了"。这里把它做成常驻、可操作的面板。
 *
 * 手机端特有约束：按钮小、手指宽 → 删除必须两段式确认。
 */

"use strict";

// ---------- 排队条 ----------
// dsh 的 queue 模式：会话忙时消息进 inbox，等当前 turn 结束才执行，
// 期间**没有任何超时**。旧版只在事件里打一行"排队等待"，之后不可见、不可撤，
// 现象就是"发了消息半天没反应、以为丢了"。这里把它做成常驻、可操作的面板：
// 每条都能单独删除（手机两次点确认，防误触）、插队，文字可展开看全文。
let qbarSig = "";           // 内容指纹：无变化就不重绘，保住滚动位置 / 展开态 / 确认态
let qbarArmed = null;       // { id, timer } 已进入"确认删除"的那条
let qbarExpanded = new Set(); // 已展开全文的 itemId
// 本地已确认删除的 id（id -> 时间戳）。删除成功后服务端快照可能还没跟上，
// 若直接用轮询结果重绘，被删的那条会"闪回来"一次，用户会以为没删掉再点第二次
// （那时服务端已删，只会报 queue-item-not-found）。这里做短期屏蔽，5 分钟后自清。
const qbarGone = new Map();
const QBAR_GONE_TTL = 5 * 60 * 1000;
function qbarFilterGone(items) {
  const now = Date.now();
  for (const [id, ts] of qbarGone) if (now - ts > QBAR_GONE_TTL) qbarGone.delete(id);
  if (!qbarGone.size) return items;
  return items.filter((x) => !qbarGone.has(x.m.id));
}

function currentQueued() {
  const s = state.sessions.find((x) => x.sessionId === state.sessionId);
  const inbox = s?.projections?.values?.inbox;
  if (!inbox) return [];
  const nt = (inbox["next-turn"] || []).map((m, i) => ({ m, pos: "turn", i }));
  const ns = (inbox["next-step"] || []).map((m, i) => ({ m, pos: "step", i }));
  return [...nt, ...ns];
}
function disarmQueueDel() {
  if (!qbarArmed) return;
  clearTimeout(qbarArmed.timer);
  qbarArmed = null;
  const bar = $("queue-bar");
  bar?.querySelectorAll(".qact-del.armed").forEach((b) => {
    b.classList.remove("armed");
    b.textContent = "✕";
    b.title = "删除这条排队消息";
  });
  bar?.querySelectorAll(".qitem.confirming").forEach((el) => el.classList.remove("confirming"));
}
function renderQueueBar() {
  const bar = $("queue-bar");
  if (!bar) return;
  const items = qbarFilterGone(
    currentQueued().filter((x) => (x.m.source?.kind || "user") === "user")
  );
  if (!state.sessionId || !items.length) {
    bar.style.display = "none"; bar.innerHTML = "";
    qbarSig = ""; disarmQueueDel();
    return;
  }
  // 待办面板与排队条互斥：排队条说"还有几条没执行"，待办说"agent 走到第几步"。
  // 两者同屏会把输入区顶得太高，而排队条承载的是可操作项（删/插队），优先级更高。
  const tbar = $("todo-bar");
  if (tbar) { tbar.style.display = "none"; }
  const running = state.sessions.find((x) => x.sessionId === state.sessionId)?.running;
  // 指纹里带 sessionId，换会话必须重绘
  const sig = `${state.sessionId}#${running ? 1 : 0}#` + items.map((x) => x.m.id).join(",");
  if (sig === qbarSig) return; // 10s 轮询空转时不打断用户操作
  qbarSig = sig;

  const keepScroll = bar.querySelector(".qlist")?.scrollTop || 0;
  disarmQueueDel(); // 列表要重建，旧的"确认删除"按钮已失效
  bar.style.display = "block";
  bar.innerHTML =
    `<div class="qhead"><span class="qcount">${items.length}</span>` +
    `<span>条待执行</span>` +
    `<span class="qhint">${
      running ? "· 当前任务结束后按顺序执行" : "· 会话空闲，稍后会自动开始"
    }</span></div>` +
    `<div class="qlist">` +
    items
      .map(({ m, i }, n) => {
        const txt = (m.content || []).filter((p) => p.type === "text").map((p) => p.text).join("\n");
        const open = qbarExpanded.has(m.id);
        const long = txt.length > 60 || txt.includes("\n");
        return (
          `<div class="qitem" data-id="${esc(m.id)}">` +
          `<span class="qidx">${n + 1}</span>` +
          `<div class="qmain"><div class="qtext${open ? " open" : ""}">${esc(txt)}</div>` +
          `<div class="qmeta">排队中${i === 0 ? " · 下一个执行" : ""}` +
          (long ? `<span class="qmore" data-act="toggle">${open ? "收起" : "展开"}</span>` : "") +
          `</div></div>` +
          `<div class="qacts">` +
          (running
            ? `<button class="qact-steer" data-act="steer" title="不等当前回复结束，插到下一步">插队</button>`
            : "") +
          `<button class="qact-del" data-act="remove" title="删除这条排队消息">✕</button>` +
          `</div></div>`
        );
      })
      .join("") +
    `</div>`;

  const list = bar.querySelector(".qlist");
  if (list && keepScroll) list.scrollTop = keepScroll;

  // 「展开 / 收起」全文：手机上常驻排队条高度有限，长消息默认两行截断
  bar.querySelectorAll('.qmore[data-act="toggle"]').forEach((sp) => {
    sp.onclick = () => {
      const id = sp.closest(".qitem")?.dataset.id;
      if (!id) return;
      if (qbarExpanded.has(id)) qbarExpanded.delete(id); else qbarExpanded.add(id);
      const t = sp.closest(".qitem").querySelector(".qtext");
      const on = qbarExpanded.has(id);
      t.classList.toggle("open", on);
      sp.textContent = on ? "收起" : "展开";
    };
  });

  bar.querySelectorAll('button[data-act="remove"]').forEach((btn) => {
    btn.onclick = async () => {
      const item = btn.closest(".qitem");
      const id = item?.dataset.id;
      if (!id) return;
      // 第一次点：进入确认态（变红实心 + 文案改成"确认删除"），5 秒不点自动退回
      if (!qbarArmed || qbarArmed.id !== id) {
        disarmQueueDel();
        btn.classList.add("armed");
        btn.textContent = "确认删除";
        item.classList.add("confirming");
        qbarArmed = {
          id,
          timer: setTimeout(() => { disarmQueueDel(); }, 5000),
        };
        return;
      }
      clearTimeout(qbarArmed.timer);
      qbarArmed = null;
      btn.disabled = true;
      btn.textContent = "删除中…";
      try {
        await rpc("session/updateQueue", {
          request: { sessionId: state.sessionId, itemId: id, action: { kind: "remove" } },
        });
        qbarExpanded.delete(id);
        qbarGone.set(id, Date.now()); // 短期屏蔽，防止服务端快照滞后导致"闪回来"
        toast("已删除这条排队消息", "ok");
        // 立即本地摘掉，不等下一轮轮询（体感更快，也避免按钮停在"删除中…"）
        const s = state.sessions.find((x) => x.sessionId === state.sessionId);
        const ib = s?.projections?.values?.inbox;
        if (ib) {
          for (const k of ["next-turn", "next-step"]) {
            if (Array.isArray(ib[k])) ib[k] = ib[k].filter((m) => m.id !== id);
          }
        }
        qbarSig = ""; // 强制重绘
        renderQueueBar();
        refreshSessions();
      } catch (e) {
        const gone = /queue-item-not-found|no longer pending/i.test(e.message);
        toast(gone ? "这条已经执行或已被删除" : "删除失败: " + e.message);
        qbarSig = "";
        refreshSessions();
      }
    };
  });

  bar.querySelectorAll('button[data-act="steer"]').forEach((btn) => {
    btn.onclick = async () => {
      const id = btn.closest(".qitem")?.dataset.id;
      if (!id) return;
      disarmQueueDel();
      btn.disabled = true;
      try {
        await rpc("session/updateQueue", {
          request: { sessionId: state.sessionId, itemId: id, action: { kind: "steer" } },
        });
        toast("已插队，下一步就执行", "ok");
      } catch (e) {
        toast("插队失败: " + e.message);
      }
      qbarSig = "";
      refreshSessions();
    };
  });
}
