/**
 * 基础工具：DOM 取值、转义、时间、轻量 markdown、RPC。
 *
 * md()/inline() 是本项目唯一不引入外部库的地方（保持无构建设计）：
 * 自己实现的原因不是省依赖，而是手机端只需要渲染 agent 输出的那几种
 * 语法，通用 markdown 库动辄几十 KB 且会带来 XSS 面。
 */

"use strict";

// ---------- 基础工具 ----------
function toast(msg, type) {
  const t = $("toast");
  t.textContent = msg;
  t.style.background = type === "ok" ? "var(--ok)" : "var(--err)";
  t.style.display = "block";
  clearTimeout(t._h); t._h = setTimeout(() => (t.style.display = "none"), 3500);
}
function relTime(ts) {
  if (!ts) return "";
  const d = Date.now() - ts;
  if (d < 60000) return "刚刚";
  if (d < 3600000) return Math.floor(d / 60000) + " 分钟前";
  if (d < 86400000) return Math.floor(d / 3600000) + " 小时前";
  return Math.floor(d / 86400000) + " 天前";
}
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
// 轻量 markdown：块级（标题/列表/表格/引用/代码块）+ 行内（代码/粗体/链接）
// 不引入外部库（保持无构建设计）。渲染顺序：先按行切块，块内做行内替换，
// 最后 esc 已在最外层做过，这里所有文本都不再二次 esc，避免 &amp;lt; 叠加。
function md(text) {
  const raw = String(text ?? "");
  if (!raw) return "";
  const lines = raw.split("\n");
  const out = [];      // 已完成 HTML 块
  let para = [];       // 正在累积的段落行
  let list = null;     // { tag:"ul"|"ol", items:[] }
  let quote = null;    // 引用累积行
  let table = null;    // { head:[], rows:[[]] }

  const flushPara = () => {
    if (!para.length) return;
    out.push(`<div class="p">${inline(para.join("\n"))}</div>`);
    para = [];
  };
  const flushList = () => {
    if (!list) return;
    out.push(`<${list.tag}>${list.items.map((t) => `<li>${inline(t)}</li>`).join("")}</${list.tag}>`);
    list = null;
  };
  const flushQuote = () => {
    if (quote === null) return;
    out.push(`<blockquote>${inline(quote.join("\n"))}</blockquote>`);
    quote = null;
  };
  const flushTable = () => {
    if (!table) return;
    // 对齐：分隔行 :--- / :---: / ---: 决定每列 text-align（缺省左对齐）
    const align = table.align || [];
    const th = table.head.map((c, k) =>
      `<th${align[k] ? ` style="text-align:${align[k]}"` : ""}>${inline(c)}</th>`).join("");
    const tb = table.rows.map((r) =>
      `<tr>${r.map((c, k) => `<td${align[k] ? ` style="text-align:${align[k]}"` : ""}>${inline(c)}</td>`).join("")}</tr>`).join("");
    out.push(`<div class="tbl-wrap"><table><thead><tr>${th}</tr></thead><tbody>${tb}</tbody></table></div>`);
    table = null;
  };
  const flushAll = () => { flushPara(); flushList(); flushQuote(); flushTable(); };

  // 拆表格行：|a|b|c|  →  ["a","b","c"]；容忍首尾无竖线、行内转义 \|
  const splitRow = (ln) => {
    let s = ln.trim();
    if (s.startsWith("|")) s = s.slice(1);
    if (s.endsWith("|")) s = s.slice(0, -1);
    const cells = [];
    let cur = "", esc = false;
    for (const ch of s) {
      if (esc) { cur += ch; esc = false; continue; }
      if (ch === "\\") { esc = true; continue; }
      if (ch === "|") { cells.push(cur.trim()); cur = ""; continue; }
      cur += ch;
    }
    cells.push(cur.trim());
    return cells;
  };
  // 分隔行：|---|:---:|---:|  允许空格、对齐冒号
  const isSep = (ln) => /^\s*\|?[\s:-]*-[\s|:-]*\|?\s*$/.test(ln) && ln.includes("-");
  // 从分隔行解析每列对齐方式：':---:' → center，'---:' → right，其余 left
  const parseAlign = (ln) =>
    splitRow(ln).map((c) => {
      const l = c.startsWith(":"), r = c.endsWith(":");
      return l && r ? "center" : r ? "right" : l ? "left" : null;
    });

  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    const t = ln.trim();

    // 代码块：整体成块，内容原样（只做转义），内部不做任何 md 解析
    if (t.startsWith("```")) {
      flushAll();
      const lang = t.slice(3).trim();
      const buf = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith("```")) { buf.push(lines[i]); i++; }
      const code = esc(buf.join("\n"));
      out.push(
        `<div class="cblock">` +
        `<div class="cbar-head"><span class="clang">${esc(lang || "code")}</span>` +
        `<button class="ccopy" data-copy="${encodeURIComponent(buf.join("\n")).slice(0, 200000)}">复制</button></div>` +
        `<pre><code>${code}</code></pre></div>`
      );
      continue;
    }

    // 表格：当前行像表头，且下一行是分隔行
    if (t.includes("|") && i + 1 < lines.length && isSep(lines[i + 1])) {
      flushAll();
      table = { head: splitRow(t), align: parseAlign(lines[i + 1]), rows: [] };
      i += 2; // 跳过表头与分隔行
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
        table.rows.push(splitRow(lines[i]));
        i++;
      }
      i--;
      flushTable();
      continue;
    }

    // 分隔线
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) { flushAll(); out.push("<hr>"); continue; }

    // 标题
    const h = /^(#{1,4})\s+(.+)$/.exec(t);
    if (h) { flushAll(); const lv = h[1].length; out.push(`<h${lv}>${inline(h[2])}</h${lv}>`); continue; }

    // 空行：结束当前块
    if (!t) { flushAll(); continue; }

    // 引用
    if (t.startsWith(">")) {
      flushPara(); flushList(); flushTable();
      (quote ||= []).push(t.replace(/^>\s?/, ""));
      continue;
    }
    if (quote !== null) flushQuote();

    // 列表（支持 - * + 与 1. ；缩进即嵌套，这里扁平化为同层，手机上够用）
    const ul = /^[-*+]\s+(.*)$/.exec(t);
    const ol = /^\d+[.)]\s+(.*)$/.exec(t);
    if (ul || ol) {
      flushPara(); flushTable();
      const tag = ul ? "ul" : "ol";
      if (!list || list.tag !== tag) { flushList(); list = { tag, items: [] }; }
      list.items.push((ul || ol)[1]);
      continue;
    }
    if (list) flushList();

    para.push(ln);
  }
  flushAll();
  return out.join("");
}
// 行内：`code` / **粗体** / [文字](链接) / ~~删除~~
function inline(s) {
  let x = esc(s);
  // 行内代码先占位，避免其中的 ** 被当粗体
  const codes = [];
  x = x.replace(/`([^`\n]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
  x = x.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
  x = x.replace(/~~([^~\n]+)~~/g, "<s>$1</s>");
  x = x.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  // 裸链接（http/https），避免和已有 <a href> 冲突
  x = x.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (m, p1, url) =>
    `${p1}<a href="${url}" target="_blank" rel="noopener">${url}</a>`);
  x = x.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[+i]}</code>`);
  return x;
}
async function rpc(endpoint, args = {}) {
  const res = await fetch("/rpc/" + endpoint, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ args }),
  });
  if (res.status === 401) { location.href = "/"; return new Promise(() => {}); }
  const body = await res.json();
  if (!body.ok) throw Object.assign(new Error(body.error?.message || "RPC 失败"), { code: body.error?.code });
  return body.value;
}
