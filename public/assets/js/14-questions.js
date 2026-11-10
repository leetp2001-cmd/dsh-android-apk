/**
 * dsh 提问交互：接收问题事件、维护草稿、提交答案。
 *
 * 官方语义：一个事件是一批问题，答案必须攒齐全部问题一次性提交（含跳过），
 * 不能逐题提交。所以这里有三层 map：pendingQuestions / qDrafts / qSteps。
 *
 * 本文件只处理"事件 → 状态"；渲染在 15-approval.js（两者共用一个 banner 体系）。
 */

"use strict";

// ---------- dsh 提问（ask_user_question）交互 ----------
// 官方语义：一个事件是一批问题，答案必须攗齐全部问题一次性提交（含跳过），不能逐题提交
function handleEventItem(v) {
  if (v?.type === "ready" && v.clientId) { state.evClientId = v.clientId; return; }
  if (v?.type === "waterfall" && v.event === "user-questions/request") {
    const incoming = v.request?.questions || [];
    const prev = state.pendingQuestions.get(v.eventId);
    if (prev) {
      // 同一事件重投（WS 断线重连后会重放 pending 事件）：保留已填草稿，别把用户选了一半的选项清掉
      prev.questions = incoming;
      prev.agent = v.request?.agent || v.agentId;
      prev.wait = v.request?.wait;
    } else {
      state.pendingQuestions.set(v.eventId, {
        eventId: v.eventId,
        questions: incoming,
        // 会话 ID：网关会把 request 里的 agent 剥掉，改放顶层 agentId（client.browser.js:958 严格校验）
        agent: v.request?.agent || v.agentId,
        wait: v.request?.wait,   // callId：用于该问题被超时/别处回答后自动撤卡
      });
    }
    renderQuestionBanner();
    return;
  }
  // P0-1 审批请求：与提问走完全相同的 waterfall 通道，只是 outcome 结构不同。
  // 这一条不做的话，回退到 workspace-write 沙箱后手机端无审批 UI → 会话永久锁死。
  if (v?.type === "waterfall" && v.event === "approval/request") {
    const r = v.request || {};
    state.pendingApprovals.set(v.eventId, {
      eventId: v.eventId,
      agent: v.agentId || r.agent,   // 会话 ID 在顶层 agentId
      callId: r.callId,
      toolName: r.toolName || r.tool || "未知工具",
      reason: r.reason || r.message || "",
    });
    renderApprovalBanner();
    // 审批是阻塞项，必须盖过提问卡
    renderQuestionBanner();
    return;
  }
  // 审批被别处处理 / 超时：网关发的是 {type:"cancel", eventId} 帧 —— 不是 approval/decided。
  // approval/decided 是 session 日志事件，根本不会出现在 $events 流里（转发白名单里没有它）。
  if (v?.type === "cancel" && v.eventId) {
    let changed = false;
    if (state.pendingApprovals.delete(v.eventId)) changed = true;
    if (state.pendingQuestions.delete(v.eventId)) changed = true;
    if (changed) { renderApprovalBanner(); renderQuestionBanner(); }
    return;
  }
  // 审批对应的工具调用已出结果：同样撤卡（超时/兜底路径）
  if (v?.type === "waterfall" && v.event === "tool/call") {
    const r = v.request || {};
    if (r.callId) {
      let changed = false;
      for (const [eid, pa] of state.pendingApprovals) {
        if (pa.callId === r.callId) { state.pendingApprovals.delete(eid); changed = true; }
      }
      if (changed) renderApprovalBanner();
    }
  }
}
