/**
 * 推送设置面板。
 *
 * 与"降噪模式"无关：那个管的是消息列表里要不要折叠工具调用，
 * 这个管的是"人不在页面前时怎么被叫醒"。两件事，别再合并。
 *
 * 配置存在服务端 .push.json（页面刷新/换设备都不丢），这里只做表单。
 * 读取时服务端会把 key 打码成 "abc••••xyz"；保存时若原样提交，服务端会识别
 * 打码串并保留原值 —— 所以这里**不能**擅自清空看起来是打码的值。
 */

"use strict";

// ==========================================================================
// 推送设置
// --------------------------------------------------------------------------
// 与"降噪模式"（#btn-quiet）无关：那个管的是消息列表里要不要折叠工具调用，
// 这个管的是"人不在页面前时怎么被叫醒"。两件事，别再合并。
//
// 配置存在服务端 .push.json（页面刷新/换设备都不丢），这里只做表单。
// 读取时服务端会把 key 打码成 "abc••••xyz"；保存时若原样提交，服务端会识别
// 打码串并保留原值 —— 所以这里**不能**擅自清空看起来是打码的值。
// ==========================================================================
const pushState = { cfg: null, dirty: false };

function pushChannelDefaults(type) {
  if (type === "bark") return { type, server: "https://api.day.app", key: "" };
  if (type === "ntfy") return { type, server: "https://ntfy.sh", topic: "", token: "" };
  if (type === "serverchan") return { type, key: "" };
  return { type };
}

function renderPushChannels() {
  const box = $("push-channels");
  const list = pushState.cfg?.channels || [];
  if (!list.length) {
    box.innerHTML = `<div style="color:var(--muted);font-size:12.5px;padding:4px 0">还没有渠道，先添加一个</div>`;
    return;
  }
  box.innerHTML = "";
  list.forEach((c, i) => {
    const d = document.createElement("div");
    d.className = "pch";
    d.dataset.idx = String(i);
    const label = c.type === "bark" ? "Bark" : c.type === "ntfy" ? "ntfy" : "Server 酱";
    let fields = "";
    if (c.type === "bark") {
      fields = `<input data-f="key" value="${esc(c.key || "")}" placeholder="Bark Key（App 里那串，如 aBcDeF123456）">
                <input data-f="server" value="${esc(c.server || "")}" placeholder="服务地址（默认 https://api.day.app）">`;
    } else if (c.type === "ntfy") {
      fields = `<input data-f="topic" value="${esc(c.topic || "")}" placeholder="Topic（自己起个别人猜不到的名字）">
                <input data-f="server" value="${esc(c.server || "")}" placeholder="服务地址（默认 https://ntfy.sh）">
                <input data-f="token" value="${esc(c.token || "")}" placeholder="Token（自建服务才需要，可留空）">`;
    } else {
      fields = `<input data-f="key" value="${esc(c.key || "")}" placeholder="SendKey（SCT 开头）">`;
    }
    d.innerHTML = `<div class="pch-top">
        <span class="pch-type">${esc(label)}</span>
        <button class="pch-del" title="删除">✕</button>
      </div>${fields}`;
    d.querySelector(".pch-del").onclick = () => {
      pushState.cfg.channels.splice(i, 1);
      pushState.dirty = true;
      renderPushChannels();
    };
    d.querySelectorAll("input").forEach((inp) => {
      inp.oninput = () => {
        pushState.cfg.channels[i][inp.dataset.f] = inp.value;
        pushState.dirty = true;
      };
    });
    box.appendChild(d);
  });
}

// 表单 → cfg 对象（保存前调用，保证点「保存」时抓到的是最新输入）
function collectPushForm() {
  const c = pushState.cfg || {};
  c.enabled = $("push-enabled").checked;
  c.on = {
    turnEnd: $("push-on-turnEnd").checked,
    error: $("push-on-error").checked,
    approval: $("push-on-approval").checked,
    question: $("push-on-question").checked,
  };
  c.quiet = {
    enabled: $("push-quiet-on").checked,
    start: $("push-quiet-start").value.trim() || "23:30",
    end: $("push-quiet-end").value.trim() || "07:30",
  };
  c.baseUrl = $("push-base").value.trim();
  return c;
}

function fillPushForm(cfg) {
  $("push-enabled").checked = !!cfg.enabled;
  $("push-on-turnEnd").checked = cfg.on?.turnEnd !== false;
  $("push-on-error").checked = cfg.on?.error !== false;
  $("push-on-approval").checked = cfg.on?.approval !== false;
  $("push-on-question").checked = cfg.on?.question !== false;
  $("push-quiet-on").checked = !!cfg.quiet?.enabled;
  $("push-quiet-start").value = cfg.quiet?.start || "23:30";
  $("push-quiet-end").value = cfg.quiet?.end || "07:30";
  $("push-base").value = cfg.baseUrl || "";
}

function pushStatus(msg, type) {
  const el = $("push-status");
  el.textContent = msg || "";
  el.className = "pp-status" + (type ? " " + type : "");
}

async function openPushPanel() {
  $("push-mask").classList.add("show");
  pushStatus("读取中…");
  try {
    const r = await fetch("/push", { headers: {} });
    if (r.status === 401) { location.href = "/"; return; }
    const b = await r.json();
    if (!b.ok) throw new Error(b.error?.message || "读取失败");
    pushState.cfg = b.value;
    pushState.dirty = false;
    fillPushForm(b.value);
    renderPushChannels();
    // 顺手把当前访问域名填进"点通知回到"，省得用户自己抄
    if (!b.value.baseUrl) $("push-base").value = location.origin;
    pushStatus("");
  } catch (e) {
    pushStatus("读取配置失败：" + e.message, "err");
  }
}
function closePushPanel() {
  $("push-mask").classList.remove("show");
}

$("btn-push").onclick = openPushPanel;
$("push-mask").querySelector(".pp-close").onclick = closePushPanel;
$("push-mask").onclick = (e) => { if (e.target === $("push-mask")) closePushPanel(); };

$("push-add").onclick = () => {
  if (!pushState.cfg) pushState.cfg = { channels: [], on: {}, quiet: {} };
  if (!Array.isArray(pushState.cfg.channels)) pushState.cfg.channels = [];
  const type = $("push-add-type").value;
  pushState.cfg.channels.push({ id: "ch" + Date.now().toString(36), ...pushChannelDefaults(type) });
  pushState.dirty = true;
  renderPushChannels();
};

$("push-save").onclick = async () => {
  const cfg = collectPushForm();
  // 前端先挡一道，别让用户存完才在白等通知
  if (cfg.enabled && !(cfg.channels || []).length) {
    pushStatus("已开启推送但还没有渠道，先添加一个", "err");
    return;
  }
  pushStatus("保存中…");
  try {
    const r = await fetch("/push", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cfg),
    });
    const b = await r.json();
    if (!b.ok) throw new Error(b.error?.message || "保存失败");
    pushState.cfg = b.value;
    pushState.dirty = false;
    fillPushForm(b.value);
    renderPushChannels();
    pushStatus(b.value.enabled ? "已保存，推送已开启" : "已保存（推送未开启）", "ok");
  } catch (e) {
    pushStatus("保存失败：" + e.message, "err");
  }
};

$("push-test").onclick = async () => {
  // 测试前先存：否则测的是旧配置，用户会以为配错了
  const cfg = collectPushForm();
  pushStatus("发送测试中…");
  try {
    const s = await fetch("/push", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cfg),
    });
    const sb = await s.json();
    if (!sb.ok) throw new Error(sb.error?.message || "保存失败");
    pushState.cfg = sb.value;

    const r = await fetch("/push/test", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const b = await r.json();
    const res = b.value?.results || [];
    if (!res.length) { pushStatus("没有可用的渠道", "err"); return; }
    const okN = res.filter((x) => x.ok).length;
    if (okN === res.length) {
      pushStatus(`已发出 ${okN} 条测试通知，看看手机收到没`, "ok");
    } else {
      const bad = res.filter((x) => !x.ok).map((x) => `${x.type}: ${x.error}`).join("；");
      pushStatus(`${okN}/${res.length} 成功。失败：${bad}`, "err");
    }
  } catch (e) {
    pushStatus("测试失败：" + e.message, "err");
  }
};

// 未保存就关面板：提醒一下，避免"填了半天没保存"
window.addEventListener("beforeunload", (e) => {
  if (pushState.dirty && $("push-mask").classList.contains("show")) {
    e.preventDefault(); e.returnValue = "";
  }
});

// 推送通知点进来会带 ?s=<sessionId>：自动打开那个会话。
// 这里是「定义」，实际触发在 19-main.js 的启动序列末尾 —— 它依赖会话列表
// 已经发起请求，提前跑只会白等一轮。
function openFromPush() {
  const sid = new URLSearchParams(location.search).get("s");
  if (!sid) return;
  // 列表可能还没回来，轮询等它；最多等 20 秒
  let tries = 0;
  const t = setInterval(() => {
    const hit = state.sessions.find((x) => x.sessionId === sid);
    if (hit) {
      clearInterval(t);
      openSession(hit);
      history.replaceState(null, "", location.pathname);
      return;
    }
    if (++tries > 40) clearInterval(t); // 会话可能已归档/删除，别死等
  }, 500);
}
