/**
 * 事件渲染：把 dsh 的会话事件翻译成 DOM。
 *
 * renderEvent 是唯一的事件分发点，每个分支对应一种 dsh 事件类型。
 * 与服务端 src/dsh/trim-follow.js 的 KEEP_EVENT 是**成对契约**：
 * 那边决定哪些事件能传到手机，这边决定每种事件怎么显示。
 * 新增事件类型必须两边同时改，否则历史消息里那种事件会消失。
 */

"use strict";

function renderEvent(ev) {
  const d = ev.data ?? {};
  switch (ev.type) {
    case "user/message": {
      // 自己发出的消息已乐观回显，事件回确认时跳过；dsh 内部注入（runtime context 等）不冒充用户
      const rpcId = d.source?.rpcId;
      if (rpcId && state.pendingRpcs.has(rpcId)) { state.pendingRpcs.delete(rpcId); break; }
      const kind = d.source?.kind;
      if (kind && kind !== "user") break;
      const parts = (d.content || []).filter((p) => p.type === "text").map((p) => p.text).join("\n");
      const imgs = (d.content || []).filter((p) => p.type === "image" && p.attachment);
      if (parts || imgs.length) {
        const b = msgNode("user", "你", true);
        b.innerHTML = parts ? md(parts) : "";
        if (imgs.length) b.appendChild(renderImages(imgs));
      }
      break;
    }
    case "agent/inbox/spliced": {
      // 排队模式：会话忙时消息先进队列，此时还没有 user/message 事件。
      // 这里不再往消息流里刷"排队等待"提示（一进一出两条，越积越乱），
      // 改由底部常驻排队条统一展示，只触发一次列表刷新。
      // 注意：不能在这里清 pendingRpcs——要等真正的 user/message 事件到来时清，
      // 否则那次事件会被当成"非自己发的"再渲染一遍，消息就重复了。
      if (d.target === "next-turn" && Array.isArray(d.inserted)) {
        const hasUser = d.inserted.some((ins) => ins?.source?.kind === "user");
        if (hasUser) refreshSessionsSoon();
      }
      break;
    }
    case "assistant/message": {
      // 该步已持久化提交：移除实时打字机渲染的临时节点，避免思考/正文重复显示
      hideTyping();
      document.querySelectorAll("#messages .live").forEach((el) => el.remove());
      liveBubble = null; liveReasoning = null;
      for (const part of d.message?.content || []) {
        if (part.type === "reasoning" && part.text?.trim()) {
          const det = document.createElement("details");
          det.className = "reasoning";
          det.innerHTML = `<summary>💭 思考过程</summary><div class="body">${esc(part.text)}</div>`;
          pushNode(det);
        } else if (part.type === "text" && part.text?.trim()) {
          msgNode("assistant", "dsh").innerHTML = md(part.text);
        } else if (part.type === "image" && part.attachment) {
          // 模型回图（read_image 结果转述等）也会落到这里，同样按 id 拉字节
          msgNode("assistant", "dsh").appendChild(renderImages([part]));
        }
      }
      break;
    }
    case "tool/call":
      toolNode(d.callId, d.name, toolText(d).slice(0, 160));
      break;
    case "tool/result": {
      const callId = d.message?.source?.callId;
      // 该提问对应的工具调用已出结果（超时/已在别处回答）：自动撤卡，别让它一直挂着
      if (callId) {
        let changed = false;
        for (const [eid, pq] of state.pendingQuestions) {
          if (pq.wait?.callId && pq.wait.callId === callId) {
            state.pendingQuestions.delete(eid);
            state.qDrafts.delete(eid);
            state.qSteps.delete(eid);
            changed = true;
          }
        }
        if (changed) renderQuestionBanner();
      }
      const chip = state.toolChips.get(callId);
      if (chip) {
        const texts = (d.message?.content || [])
          .flatMap((c) => c.content || c)
          .map((c) => c?.text || "")
          .filter(Boolean);
        chip.querySelector(".tbody").textContent = texts.join("\n").slice(0, 4000) || "(空结果)";
      }
      break;
    }
    case "turn/start": setRunning(true); break;
    case "turn/end": {
      hideTyping();
      renderTurnEnd(d);
      setRunning(false, true); // 本轮结束：事件最权威，绕过宽限期立刻收起中断键
      // 本轮结束：清掉上下文里"运行中"相关的瞬时态，并刷新用量（统计值通常在此刻才定稿）
      renderCtxPill();
      break;
    }
    case "llm/retry": {
      const dd = d || {};
      const secs = typeof dd.delayMs === "number" ? Math.max(1, Math.round(dd.delayMs / 1000)) : null;
      const cnt = dd.retry && dd.maxRetries ? `（${dd.retry}/${dd.maxRetries}）` : "";
      const why = dd.status || dd.code || dd.reason || "";
      sysLine(`🔄 上游返回错误${why ? " " + why : ""}，${secs != null ? secs + "s 后重试" : "稍后重试"}${cnt}`, "sysnote");
      break;
    }
    case "llm/retry-started":
      sysLine("🔄 正在重试…", "sysnote");
      break;
    case "todo/write": {
      // dsh 只发 todo/write（整表替换，last-write-wins），没有 todo/update
      const list = d?.todos;
      if (Array.isArray(list)) {
        state.projVals = state.projVals || {};
        state.projVals.todos = list;
        renderTodoBar();
      }
      break;
    }
    case "compaction/start": sysLine("🧹 上下文压缩中…", "sysnote"); break;
    case "compaction/end":
      sysLine("🧹 压缩完成", "sysnote");
      renderCtxPill(); // 压缩后百分比应该掉下来，立刻更新
      break;
    default: break;
  }
}

// turn/end 的 7 种 reason 可读化（原实现只认 completed/cancelled，其余一律 "结束 (?)"）
function renderTurnEnd(d) {
  const kind = d?.reason?.kind ?? d?.reason ?? "?";
  const fail = d?.reason?.error || d?.error || d?.failure || null;
  switch (kind) {
    case "completed":
      sysLine("— 本轮完成 —");
      break;
    case "aborted":
    case "cancelled":
      sysLine("— 已中断（你点了停止）—");
      break;
    case "blocked":
      sysLine("— 被拦截（权限/审批拒绝）—", "sysnote");
      break;
    case "max-tokens":
      sysLine("⚠ 输出被截断（达到 token 上限），回复不完整", "sysnote");
      break;
    case "interrupted":
      sysLine("— dsh 进程重启导致本轮中断 —", "sysnote");
      break;
    case "forked":
      sysLine("— 已分裂为新会话 —");
      break;
    case "error": {
      // LlmFailure 结构化字段：尽量拼出人能看懂的一行，而不是裸露 JSON
      const bits = [];
      if (fail) {
        if (fail.status) bits.push(`HTTP ${fail.status}`);
        if (fail.code) bits.push(fail.code);
        if (fail.message) bits.push(fail.message);
        else if (fail.error?.message) bits.push(fail.error.message);
        if (fail.provider || fail.model) bits.push([fail.provider, fail.model].filter(Boolean).join("/"));
      }
      const detail = bits.length ? bits.join(" · ") : "未知原因";
      const node = document.createElement("div");
      node.className = "sysnote";
      node.style.color = "var(--err)";
      node.innerHTML = `❌ <b>失败：</b>${esc(detail)} <button class="retry-btn" style="margin-left:8px;padding:3px 10px;font-size:11.5px;border-radius:6px">重试</button>`;
      node.querySelector(".retry-btn").onclick = () => {
        // 重试 = 把最后一条用户消息重新发一次（dsh 没有"重试上一轮"的 RPC）
        const last = state.lastUserText;
        if (!last) { toast("找不到上一轮内容"); return; }
        $("prompt").value = last;
        autosize();
        $("prompt").focus();
        toast("已填回输入框，确认后发送", "ok");
      };
      pushNode(node);
      break;
    }
    default:
      sysLine(`— 结束 (${kind}) —`);
  }
}

// ---------- 打字中指示 ----------
let typingNode = null;
function showTyping() {
  hideTyping();
  const w = document.createElement("div");
  w.className = "msg assistant live";
  w.innerHTML = '<div class="who">dsh</div><div class="bubble"><span class="typing"><i></i><i></i><i></i></span></div>';
  pushNode(w);
  typingNode = w;
}
function hideTyping() {
  typingNode?.remove();
  typingNode = null;
}

// ---------- 打字机：assistant-stream 实时帧 ----------
let liveBubble = null, liveReasoning = null;
function liveFrame(frame) {
  if (frame.type === "start") {
    hideTyping(); // dsh 开始响应，撤掉三点动画
    liveBubble = msgNode("assistant", "dsh ⏳");
    liveBubble.parentElement.classList.add("live");
    liveReasoning = null;
    return;
  }
  if (frame.type === "end") {
    if (liveBubble) liveBubble.parentElement.querySelector(".who").textContent = "dsh";
    liveBubble = null; liveReasoning = null;
    return;
  }
  const chunk = frame.chunk ?? {};
  // 块结束：思考块收尾（下一次思考另起一个折叠块）
  if (chunk.type === "block-end") {
    if (chunk.block?.type === "reasoning" && liveReasoning) {
      const det = liveReasoning.closest("details");
      if (det) det.querySelector("summary").textContent = "💭 思考过程";
      liveReasoning = null;
    }
    return;
  }
  const text = chunk.text ?? "";
  if (!text) return; // tool-call-delta / block-start / usage / finish 忽略（工具卡片走 tool/call 事件）
  if (chunk.type === "reasoning-delta") {
    if (!liveReasoning) {
      // 思考流挂在一个折叠块里
      const det = document.createElement("details");
      det.className = "reasoning live";
      det.innerHTML = `<summary>💭 思考中…</summary><div class="body"></div>`;
      pushNode(det);
      liveReasoning = det.querySelector(".body");
    }
    liveReasoning.textContent += text;
    followScroll();
  } else if (chunk.type === "text-delta") {
    if (!liveBubble) liveBubble = msgNode("assistant", "dsh ⏳");
    liveBubble._raw = (liveBubble._raw || "") + text;
    liveBubble.innerHTML = md(liveBubble._raw);
    followScroll();
  }
}

// ---------- 打开会话（follow 流式回放 + 实时） ----------
function openSession(s) {
  state.sessionId = s.sessionId;
  state.toolChips.clear();
  state.pendingRpcs.clear(); // 快照会完整回放历史，乐观回显标记作废
  state.cursorSeq = -1;
  state.projVals = null; // 换会话：投影缓存必须清，否则会短暂显示上一个会话的用量
  state.projSeq = null;  // 水位一并清：新会话的 asOfSeq 与旧会话不可比
  state.lastUserText = null;
  hideTyping();
  $("messages").innerHTML = '<div class="loading-box"><div class="spinner"></div><div>加载会话内容…</div></div>';
  $("chat-title").textContent = s.projections?.values?.title || "(未命名)";
  $("chat-meta").textContent = (s.cwd || "") + (s.running ? " · 运行中" : "");
  // 换会话：草稿图属于上一个会话，清掉（否则会把 A 会话的图发到 B 会话）
  state.draftImages = [];
  renderAttachBar();
  $("prompt").disabled = false;
  syncComposer(); // 别直接置 send.disabled=false：空输入应保持禁用，否则点了没反应
  // 换会话：宽限期作废（那是上一个会话的乐观置位），直接按目标会话说
  state.runGuardAt = 0;
  setRunning(!!s.running, true);
  renderSessions();
  // 换会话：清掉排队条的展开态与"确认删除"态，避免误删到新会话里的同序号条目
  qbarExpanded.clear(); disarmQueueDel(); qbarSig = "";
  renderQueueBar(); // 换会话后立即按新会话的 inbox 重算排队条
  renderQuestionBanner(); // 换会话后重新过滤提问卡（只显示本会话的）
  renderApprovalBanner(); // 审批卡同理（不显示别的会话的）
  renderCtxPill();        // 用量胶囊先按列表里的投影画一版，snapshot 回来再校准
  renderTodoBar();
  toggleDrawer(false); // 手机上选完会话收起抽屉

  state.followCtl?.abort?.();
  const ctl = new AbortController();
  state.followCtl = ctl;

  const sid = streamOpen(
    "session/follow",
    { args: { request: { address: { kind: "session", sessionId: s.sessionId }, maxMessages: 120, assistantStream: true } } },
    {
      onItem: (v) => {
        if (ctl.signal.aborted) return;
        if (v?.type === "snapshot") {
          $("messages").innerHTML = ""; // 移除加载提示，开始渲染
          $("chat-title").textContent = v.projections?.values?.title || $("chat-title").textContent;
          // 投影快照是 token/上下文/todo 的权威起点：先落到 state 再渲染消息
          if (v.projections?.values) state.projVals = v.projections.values;
          // 记水位：之后 control 流的增量帧与 baseline 都按这个 seq 判新旧，
          // 避免"follow 快照比 control baseline 新"时被旧 baseline 盖回去
          if (typeof v.projections?.asOfSeq === "number") state.projSeq = v.projections.asOfSeq;
          for (const rec of v.records || []) {
            if (rec?.type === "event" && rec.event) renderEvent(rec.event);
          }
          if (v.hasMore) sysLine("（更早的消息未显示）");
          else if (!(v.records || []).length) {
            $("messages").innerHTML = '<div class="empty" style="margin-top:80px">（暂无消息，发第一条试试）</div>';
          }
          renderCtxPill();
          renderTodoBar();
          return;
        }
        // 注意：session/follow 的流里【不会】再出现投影增量。
        // 投影更新走独立的 session/control 流（帧结构是扁平的 {sessionId,key,value,seq}），
        // 由 ensureControlStream() 统一订阅处理 —— 这里只负责 snapshot 落地。
        if (v?.type === "event" && v.event) { renderEvent(v.event); refreshSessionsSoon(); return; }
        if (v?.type === "assistant-stream" && v.frame) { liveFrame(v.frame); return; }
      },
      onEnd: () => { if (!ctl.signal.aborted) setTimeout(() => refreshSessions(), 300); },
      onError: (e) => {
        const errMsg = e?.message ?? JSON.stringify(e);
        // 子代理会话：dsh 拒绝直接 follow（session/agent-busy），给明确指引而非泛泛报错
        if (s.origin === "subagent" || s.parentSessionId || /subagent/i.test(errMsg)) {
          $("messages").innerHTML = '<div class="empty" style="margin-top:80px">这是子代理会话，手机端不支持直接查看<br>请在派发它的主会话里看它的结果</div>';
        } else {
          $("messages").innerHTML = '<div class="empty" style="margin-top:80px">会话加载失败，重新选择试试</div>';
        }
        toast("follow 失败: " + errMsg);
      },
    }
  );
  ctl.signal.addEventListener("abort", () => streamCancel(sid));
}
let refreshTimer = null;
function refreshSessionsSoon() {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => { refreshTimer = null; refreshSessions(); }, 2000);
}
