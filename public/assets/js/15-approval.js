/**
 * 交互卡渲染：提问卡 + 审批卡。
 *
 * 两者走完全相同的 $events waterfall 通道，但 outcome 结构不同：
 *   提问 → {kind:"result", value:{answers:[…]}}
 *   审批 → {kind:"result", value:"allowed-once"|"rejected"}
 * 同时存在时审批卡在上（它是阻塞项），提问卡在下。
 *
 * 按会话过滤是必须的：不显示别的会话的卡，但认不出来的 id 一律当本会话
 * —— 宁可多显示一张可操作的卡，也不能把用户自己的审批错判成"别的会话"。
 */

"use strict";

// ---------- P0-1 审批卡渲染 ----------
function renderApprovalBanner() {
  const box = $("a-banner");
  const hide = () => { box.style.display = "none"; box.innerHTML = ""; };
  if (!state.pendingApprovals.size || !state.evClientId) { hide(); return; }
  // 和提问卡同样按会话过滤：必须打开对应会话才能批。
  // 但 agentId 不保证等于 sessionId（dsh 里 Agent 是会话内的实体），
  // 认不出来的 id 一律当"当前会话"处理 —— 宁可多显示一张可操作的卡，
  // 也不能把用户自己的审批错判成"别的会话"，那样会话就永远卡在那里。
  const known = new Set(state.sessions.map((x) => x.sessionId));
  const isMine = (a) => !a || !state.sessionId || a === state.sessionId || !known.has(a);
  const mine = [], others = new Map();
  for (const pa of state.pendingApprovals.values()) {
    if (isMine(pa.agent)) mine.push(pa);
    else others.set(pa.agent, (others.get(pa.agent) || 0) + 1);
  }
  if (!mine.length && !others.size) { hide(); return; }
  const parts = [];
  if (others.size) {
    parts.push(`<div class="acard"><div class="atop"><span class="adot"></span><span class="atitle">其他会话有待批准操作</span></div>
      ${[...others.entries()].map(([agent, n]) =>
        `<button class="qgoto" data-agent="${esc(agent)}" style="display:block;width:100%;text-align:left;background:none;border:none;color:var(--accent);font-size:12.5px;padding:6px 2px;cursor:pointer">📌 会话「${esc(sessionTitleOf(agent))}」有 ${n} 个待批准，点开该会话处理 →</button>`
      ).join("")}</div>`);
  }
  if (mine.length) {
    const pa = mine[0];
    const more = mine.length - 1;
    parts.push(`<div class="acard" data-event="${esc(pa.eventId)}">
      <div class="atop">
        <span class="adot"></span>
        <span class="atitle">等待批准</span>
        ${more ? `<span class="amore">还有 ${more} 个</span>` : ""}
      </div>
      <div class="atool">${esc(pa.toolName)}</div>
      ${pa.reason ? `<div class="areason">${esc(pa.reason)}</div>` : ""}
      <div class="aacts">
        <button class="adeny" data-event="${esc(pa.eventId)}">拒绝</button>
        <button class="aallow" data-event="${esc(pa.eventId)}">允许一次</button>
      </div>
    </div>`);
  }
  box.innerHTML = parts.join("");
  box.style.display = "flex";

  box.querySelectorAll(".qgoto").forEach((btn) => {
    btn.onclick = () => {
      const agent = btn.dataset.agent;
      const s = state.sessions.find((x) => x.sessionId === agent);
      if (s) openSession(s);
      else refreshSessions().then(() => {
        const s2 = state.sessions.find((x) => x.sessionId === agent);
        if (s2) openSession(s2);
      });
    };
  });
  // 拒绝不做二次确认：拒绝是安全方向，误点无害（PLAN 明确要求）
  box.querySelectorAll(".adeny").forEach((btn) => {
    btn.onclick = () => answerApproval(btn.dataset.event, "rejected");
  });
  box.querySelectorAll(".aallow").forEach((btn) => {
    btn.onclick = () => answerApproval(btn.dataset.event, "allowed-once");
  });
}

// ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'
// 只实现前两个：allowed-always 语义不明确（实测枚举里没有），不做。
async function answerApproval(eventId, outcome) {
  const pa = state.pendingApprovals.get(eventId);
  if (!pa) return;
  const btns = document.querySelectorAll(`#a-banner button[data-event="${eventId}"]`);
  btns.forEach((b) => { b.disabled = true; });
  try {
    await rpc("$events/result", {
      clientId: state.evClientId, eventId,
      outcome: { kind: "result", value: outcome },
    });
    state.pendingApprovals.delete(eventId);
    renderApprovalBanner();
    toast(outcome === "allowed-once" ? "已允许本次操作" : "已拒绝", outcome === "allowed-once" ? "ok" : "err");
  } catch (e) {
    btns.forEach((b) => { b.disabled = false; });
    toast("答复失败: " + e.message);
  }
}

function qDraftsFor(eventId, questions) {
  let d = state.qDrafts.get(eventId);
  if (!d || d.length !== questions.length) {
    d = questions.map(() => ({ selected: [], custom: "", skipped: false }));
    state.qDrafts.set(eventId, d);
  }
  return d;
}

function qStepFor(eventId, total) {
  let i = state.qSteps.get(eventId);
  if (typeof i !== "number" || i < 0 || i >= total) { i = 0; state.qSteps.set(eventId, i); }
  return i;
}

function qAnswered(d) { return d.selected.length > 0 || d.custom.trim() !== "" || d.skipped; }

function sessionTitleOf(agent) {
  const s = state.sessions.find((x) => x.sessionId === agent);
  return s?.projections?.values?.title || (s?.cwd || "").split("/").filter(Boolean).slice(-1)[0] || "其他会话";
}

function renderQuestionBanner() {
  const box = $("q-banner");
  const hide = () => { box.style.display = "none"; box.innerHTML = ""; };
  if (!state.pendingQuestions.size || !state.evClientId) { hide(); return; }
  // 提问跟着会话走：必须打开对应会话才显示选择框；未打开的（含未选会话时）只显示跳转条
  const mine = [], others = new Map(); // agent -> 待答事件数
  for (const pq of state.pendingQuestions.values()) {
    if (state.sessionId && (!pq.agent || pq.agent === state.sessionId)) mine.push(pq);
    else others.set(pq.agent || "?", (others.get(pq.agent || "?") || 0) + 1);
  }
  if (!mine.length && !others.size) { hide(); return; }
  const parts = [];
  if (others.size) {
    parts.push(`<div class="qcard qmini">${[...others.entries()].map(([agent, n]) =>
      `<button class="qgoto" data-agent="${esc(agent)}">📌 会话「${esc(sessionTitleOf(agent))}」有 ${n} 个待答问题，点开该会话后作答 →</button>`
    ).join("")}</div>`);
  }
  // 一次只显示最早的一张提问卡；卡内多题时逐题展示（答完/跳过点「下一题」才出下一个）
  if (mine.length) {
    const pq = mine[0];
    const more = mine.length - 1;
    const drafts = qDraftsFor(pq.eventId, pq.questions);
    const total = pq.questions.length;
    const qi = qStepFor(pq.eventId, total);
    const q = pq.questions[qi];
    const draft = drafts[qi];
    const isLast = qi === total - 1;
    const opts = (q.options || []).map((o) => {
      const sel = draft.selected.includes(o.label);
      return `<button class="qopt${sel ? " sel" : ""}" data-event="${esc(pq.eventId)}" data-qi="${qi}" data-label="${esc(o.label)}">${esc(o.label)}${o.description ? `<span class="qdesc">${esc(o.description)}</span>` : ""}</button>`;
    }).join("");
    parts.push(`<div class="qcard" data-event="${esc(pq.eventId)}">
      ${more ? `<div class="qqueue">还有 ${more} 个待答问题，提交这张后依次显示</div>` : ""}
      ${total > 1 ? `<div class="qbatch">第 ${qi + 1}/${total} 题 · 答完点「下一题」，最后一题点「提交回答」</div>` : ""}
      <div class="qblock${draft.skipped ? " skipped" : ""}">
        <h4>❓ ${esc(q.header || `问题 ${qi + 1}/${total}`)}</h4>
        <div class="qtext">${esc(q.question || "")}</div>
        ${opts}
        <input class="qcustom" data-event="${esc(pq.eventId)}" data-qi="${qi}" placeholder="或输入自定义回答…" value="${esc(draft.custom)}">
      </div>
      <div class="qnav">
        ${qi > 0 ? `<button class="qprev" data-event="${esc(pq.eventId)}">‹ 上一题</button>` : "<span></span>"}
        <button class="qskip" data-event="${esc(pq.eventId)}" data-qi="${qi}">${draft.skipped ? "已跳过（点此恢复）" : "跳过此题"}</button>
        ${isLast
          ? `<button class="qsubmit"${qAnswered(draft) ? "" : " disabled"}>提交回答</button>${qAnswered(draft) ? "" : '<span class="qhint" style="font-size:12px;color:#c00;align-self:center">先选一项 / 填自定义 / 点跳过</span>'}`
          : `<button class="qnext" data-event="${esc(pq.eventId)}"${qAnswered(draft) ? "" : " disabled"}>下一题 ›</button>`}
      </div>
    </div>`);
  }
  // 重建前记住各卡滚动位置，重建后恢复（仅同题号时命中，翻题后自然回顶）
  const scrollMemo = new Map();
  box.querySelectorAll(".qcard[data-event]").forEach((c) => {
    scrollMemo.set(c.dataset.event + "|" + state.qSteps.get(c.dataset.event), c.scrollTop);
  });
  box.innerHTML = parts.join("");
  box.style.display = "flex";
  box.querySelectorAll(".qcard[data-event]").forEach((c) => {
    const v = scrollMemo.get(c.dataset.event + "|" + state.qSteps.get(c.dataset.event));
    if (v) c.scrollTop = v;
  });

  box.querySelectorAll(".qgoto").forEach((btn) => {
    btn.onclick = () => {
      const agent = btn.dataset.agent;
      const s = state.sessions.find((x) => x.sessionId === agent);
      if (s) openSession(s);
      else refreshSessions().then(() => {
        const s2 = state.sessions.find((x) => x.sessionId === agent);
        if (s2) openSession(s2);
      });
    };
  });

  // 就地同步导航区状态（不重建卡片，避免选择后跳顶/丢焦点）
  // ⚠️ 顺序有讲究：先更新「提交/下一题」这类决定功能可用性的状态，再做纯文案更新。
  //    曾经的 bug：.qskip 在 .qnav 里却被写成 block.querySelector(".qskip") → null
  //    → 读 .textContent 抛 TypeError → 后面的 sub.disabled 永远执行不到
  //    → 表现为「选项点了有高亮，但提交按钮一直是灰的，点不动」。
  //    故此处：① 用 card 作用域查 .qskip；② 全部改可选链，任何一处缺元素都不再中断后续逻辑。
  const syncCardNav = (card, pq, drafts, qi) => {
    const d = drafts[qi];
    const answered = qAnswered(d);
    // —— 功能状态优先：即使下面文案更新出错，按钮可用性也已被正确设置 ——
    const sub = card.querySelector(".qsubmit");
    if (sub) sub.disabled = !answered;
    const nxt = card.querySelector(".qnext");
    if (nxt) nxt.disabled = !answered;
    const hint = card.querySelector(".qhint");
    if (hint) hint.style.display = answered ? "none" : "";
    // —— 以下是纯视觉/文案，出错也不影响提交 ——
    const block = card.querySelector(".qblock");
    if (block) block.classList.toggle("skipped", d.skipped);
    const skip = card.querySelector(".qskip");
    if (skip) skip.textContent = d.skipped ? "已跳过（点此恢复）" : "跳过此题";
  };

  box.querySelectorAll(".qopt").forEach((btn) => {
    btn.onclick = () => {
      const eventId = btn.dataset.event, qi = +btn.dataset.qi, label = btn.dataset.label;
      const pq = state.pendingQuestions.get(eventId);
      if (!pq) return;
      const q = pq.questions[qi];
      const drafts = qDraftsFor(eventId, pq.questions);
      const d = drafts[qi];
      if (q.multiSelect === true) {
        const i = d.selected.indexOf(label);
        if (i >= 0) d.selected.splice(i, 1); else d.selected.push(label);
      } else {
        // 单选：再点一下已选中的 = 取消选择
        d.selected = d.selected[0] === label ? [] : [label];
        if (d.selected.length) d.custom = "";
      }
      if (d.selected.length) d.skipped = false;
      const card = btn.closest(".qcard"), block = btn.closest(".qblock");
      block.querySelectorAll(".qopt").forEach((b) => b.classList.toggle("sel", d.selected.includes(b.dataset.label)));
      if (!q.multiSelect && d.selected.length) block.querySelector(".qcustom").value = "";
      syncCardNav(card, pq, drafts, qi);
    };
  });

  box.querySelectorAll(".qcustom").forEach((input) => {
    input.oninput = () => {
      // qi 从 input 自己的 dataset 取（曾经从 .qskip 取，但 qskip 在 .qnav 不在 .qblock，
      // block.querySelector 返回 null → TypeError → 自定义输入全程无效，草稿永远是空的）
      const eventId = input.dataset.event;
      const qi = +input.dataset.qi;
      const pq = state.pendingQuestions.get(eventId);
      if (!pq || !Number.isInteger(qi)) return;
      const drafts = qDraftsFor(eventId, pq.questions);
      drafts[qi].custom = input.value;
      if (drafts[qi].custom.trim()) {
        drafts[qi].selected = [];
        drafts[qi].skipped = false;
        const block = input.closest(".qblock");
        if (block) {
          block.querySelectorAll(".qopt").forEach((b) => b.classList.remove("sel"));
          block.classList.remove("skipped");
        }
      }
      syncCardNav(input.closest(".qcard"), pq, drafts, qi); // 不重建卡片，打字不被打断
    };
  });

  box.querySelectorAll(".qskip").forEach((btn) => {
    btn.onclick = () => {
      const eventId = btn.dataset.event, qi = +btn.dataset.qi;
      const pq = state.pendingQuestions.get(eventId);
      if (!pq) return;
      const drafts = qDraftsFor(eventId, pq.questions);
      const d = drafts[qi];
      d.skipped = !d.skipped;
      if (d.skipped) { d.selected = []; d.custom = ""; }
      // ⚠️ .qskip 在 .qnav 里，不在 .qblock 里！用 closest(".qblock") 会得到 null。
      //    曾经因此一点「跳过此题」就抛 TypeError，跳过功能整体失效。
      //    正确做法：先拿到 card，再用 card.querySelector(".qblock") 定位同题的块。
      const card = btn.closest(".qcard");
      const block = card ? card.querySelector(".qblock") : null;
      if (d.skipped && block) {
        block.querySelectorAll(".qopt").forEach((b) => b.classList.remove("sel"));
        const custom = block.querySelector(".qcustom");
        if (custom) custom.value = "";
      }
      syncCardNav(card, pq, drafts, qi);
    };
  });

  box.querySelectorAll(".qnext").forEach((btn) => {
    btn.onclick = () => {
      const eventId = btn.dataset.event;
      const pq = state.pendingQuestions.get(eventId);
      if (!pq) return;
      const step = qStepFor(eventId, pq.questions.length);
      if (step < pq.questions.length - 1) { state.qSteps.set(eventId, step + 1); renderQuestionBanner(); }
    };
  });

  box.querySelectorAll(".qprev").forEach((btn) => {
    btn.onclick = () => {
      const eventId = btn.dataset.event;
      const pq = state.pendingQuestions.get(eventId);
      if (!pq) return;
      const step = qStepFor(eventId, pq.questions.length);
      if (step > 0) { state.qSteps.set(eventId, step - 1); renderQuestionBanner(); }
    };
  });

  box.querySelectorAll(".qsubmit").forEach((btn) => {
    btn.onclick = () => submitEventAnswers(btn.closest(".qcard").dataset.event);
  });
}

async function submitEventAnswers(eventId, onlyQi = null) {
  const pq = state.pendingQuestions.get(eventId);
  if (!pq) return;
  const drafts = qDraftsFor(eventId, pq.questions);
  if (onlyQi !== null && !qAnswered(drafts[onlyQi])) { toast("这一题还没作答（选一项或填自定义）"); return; }
  // 防呆：整批提交时一题都没答（没选/没填/没明确跳过）→ 拒绝提交。
  // 否则会发出 {id, selected:[]} 空答案，dsh 静默按默认继续，用户还以为自己选过了
  if (onlyQi === null && pq.questions.every((q, qi) => !qAnswered(drafts[qi]))) {
    toast("还没有作答：点一个选项、填自定义回答，或点「跳过此题」", "err");
    return;
  }
  // dsh 协议要求整批提交且每题恰好出现一次；未答/跳过统一编码为 {id, selected:[]}
  // onlyQi 指定时 = 只提交这一题，其余全部按跳过编码
  const answers = pq.questions.map((q, qi) => {
    const d = drafts[qi];
    const answerThis = onlyQi === null ? !d.skipped && qAnswered(d) : qi === onlyQi;
    if (!answerThis) return { id: q.id, selected: [] };
    const custom = d.custom.trim();
    if (custom) return { id: q.id, selected: [], custom };
    return { id: q.id, selected: d.selected };
  });
  try {
    await rpc("$events/result", { clientId: state.evClientId, eventId, outcome: { kind: "result", value: { answers } } });
    state.pendingQuestions.delete(eventId);
    state.qDrafts.delete(eventId);
    state.qSteps.delete(eventId);
    renderQuestionBanner();
    // 回显答案摘要：让用户立刻发现自己交上去的到底是哪项（防空提交）
    const summary = answers.map((a) => {
      if (a.custom) return "自定义:" + a.custom.slice(0, 20);
      return a.selected.length ? a.selected.join("、") : "(跳过)";
    }).join(" | ");
    toast(onlyQi !== null
      ? `已提交第 ${onlyQi + 1} 题，其余按跳过处理`
      : `已提交：${summary}`, "ok");
  } catch (e) { toast("提交失败: " + e.message); }
}

// 订阅 dsh 全局事件流（提问/审批等 waterfall 事件从这里来；断线重连后自动重开）
state.pendingOpen.set("events", {
  frame: { type: "open", streamId: "events", endpoint: "$events", payload: { args: {} } },
  onItem: handleEventItem,
});
