/**
 * 零散交互：代码块复制、新建会话、上下文面板开合。
 *
 * 都是"点一下就完事"的小动作，不值得各自开文件，但也不该塞进 composer。
 */

"use strict";

// ---------- 代码块「复制」按钮（事件委托，兼容实时打字机与历史回放） ----------
// 手机 WebView 里 navigator.clipboard 常常不可用（非安全上下文/无用户手势），
// 必须 fallback 到 execCommand("copy")，否则按钮点了没反应。
$("messages").addEventListener("click", (e) => {
  const btn = e.target.closest(".ccopy");
  if (!btn) return;
  e.stopPropagation();
  let text = "";
  try { text = decodeURIComponent(btn.dataset.copy || ""); } catch { text = btn.dataset.copy || ""; }
  const done = () => { btn.textContent = "已复制"; setTimeout(() => (btn.textContent = "复制"), 1600); };
  const fail = () => {
    // 最后兜底：选中文本让用户手动长按复制
    const pre = btn.closest(".cblock")?.querySelector("pre");
    if (pre) {
      const r = document.createRange();
      r.selectNodeContents(pre);
      const sel = window.getSelection();
      sel.removeAllRanges(); sel.addRange(r);
      toast("已选中，长按可复制");
    } else toast("复制失败");
  };
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => {
      const ta = document.createElement("textarea");
      ta.value = text; ta.style.cssText = "position:fixed;opacity:0;top:0;left:0";
      document.body.appendChild(ta); ta.select();
      const ok = (() => { try { return document.execCommand("copy"); } catch { return false; } })();
      ta.remove();
      ok ? done() : fail();
    });
  } else {
    const ta = document.createElement("textarea");
    ta.value = text; ta.style.cssText = "position:fixed;opacity:0;top:0;left:0";
    document.body.appendChild(ta); ta.select();
    const ok = (() => { try { return document.execCommand("copy"); } catch { return false; } })();
    ta.remove();
    ok ? done() : fail();
  }
});

// ---------- 新会话 ----------
$("btn-new").onclick = () => { $("modal-mask").style.display = "flex"; $("new-cwd").focus(); };
$("modal-cancel").onclick = () => ($("modal-mask").style.display = "none");
$("new-cwd").onkeydown = (e) => { if (e.key === "Enter") $("modal-ok").click(); };
$("modal-ok").onclick = async () => {
  const cwd = $("new-cwd").value.trim();
  if (!cwd) return toast("请填写工作目录");
  const btn = $("modal-ok");
  btn.disabled = true; btn.textContent = "创建中…";
  try {
    const v = await rpc("session/create", { request: { cwd } });
    $("modal-mask").style.display = "none";
    await refreshSessions();
    const s = state.sessions.find((x) => x.sessionId === v.sessionId);
    if (s) openSession(s);
  } catch (e) { toast("创建失败: " + e.message); }
  btn.disabled = false; btn.textContent = "创建";
};
