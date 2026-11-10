"use strict";
/**
 * session/follow 快照瘦身。
 *
 * ## 实测数据
 * dsh 的 snapshot 把整条历史原样铺开，1.0~1.7 MB，其中七成是手机端从不读取的字段：
 *   · event.data.stream —— 流式增量的原始帧，占 678KB/985KB，历史渲染完全不用
 *   · message.source.replayState —— 重放用的模型元数据，33KB
 *   · job/settled、job/registered、request/header、step/start、step/end、
 *     compaction/summary、assistant/attempt、llm/retry … —— renderEvent 里
 *     default:break，也就是传过去前端连分支都没有，纯白传 340~370KB
 *
 * 公网隧道下行约 700KB/s，1.7MB 光传输就 2.4 秒 —— 这才是"打开会话很慢"的主因
 * （dsh 本地生成只要 12~91ms，不是它慢）。
 *
 * ## 做法
 * 在代理层按"前端真正读的字段"重建 records，配合 WS 压缩把体积降到 1/7。
 * 每一处裁剪都对应前端某个具体读取点，删字段之前先确认前端不再读它。
 */

/** 是否启用。DSH_APP_TRIM=0 可整体关掉。 */
const TRIM_ENABLED = process.env.DSH_APP_TRIM !== "0";

/**
 * 前端 renderEvent 有分支的事件类型；不在表里的一律 default:break。
 * 新增前端能渲染的事件时，必须同步加到这里，否则历史里那种事件会消失。
 */
const KEEP_EVENT = new Set([
  "user/message",
  "assistant/message",
  "tool/call",
  "tool/result",
  "turn/start",
  "turn/end",
  "compaction/start",
  "compaction/end",
  "agent/inbox/spliced",
  // todo/write：整表替换的待办快照，前端 todo-bar 靠它实时刷新。
  // 它同时也是投影 todos 的来源，走 control 流也能拿到 —— 但那条流只在
  // 本端订阅着的会话上生效，follow 里带上这份才有"打开会话就有待办"的即时感。
  "todo/write",
  // llm/retry：网关抖动/provider 限流时的退避重试。不显示的话用户只看到"卡住了"，
  // 完全不知道后台在重试第几次、还要等多久。
  "llm/retry",
  "llm/retry-started",
]);

/**
 * 只留正文（reasoning/text）+ 图片引用。
 *
 * 图片块里**没有字节**，只有 {attachmentId, mediaType, width, height, bytes, name}
 * —— 前端拿到 id 后再走 session/attachment 单张换 base64（带缓存）。
 * 若在这里把图片块裁掉，前端就永远看不到历史里的图，所以必须原样透传这几个字段。
 */
function textParts(list) {
  const out = [];
  for (const p of list || []) {
    if (!p) continue;
    if (typeof p.text === "string" && p.text) {
      out.push({ type: p.type, text: p.text });
      continue;
    }
    if (p.type === "image" && p.attachment?.attachmentId) {
      const a = p.attachment;
      out.push({
        type: "image",
        attachment: {
          attachmentId: a.attachmentId,
          mediaType: a.mediaType,
          width: a.width,
          height: a.height,
          bytes: a.bytes,
          name: a.name,
        },
      });
    }
  }
  return out;
}

/** 只保留 renderEvent 里真正被读取的字段，逐类型白名单 */
function trimEventData(type, d) {
  d = d || {};
  switch (type) {
    case "user/message": {
      const kind = d.source?.kind;
      // 非用户消息（AGENTS.md / runtime context 注入）前端遇到就 break 不渲染，
      // 正文不必下发；但 source.kind 必须留着 —— 前端靠它判断"这不是我发的"，
      // 丢了会被当成用户发言渲染出来。
      if (kind && kind !== "user") return { source: { kind } };
      return {
        source: { kind, rpcId: d.source?.rpcId },
        content: textParts(d.content),
      };
    }
    case "assistant/message":
      // 前端只读 message.content 里的 reasoning / text（全量渲染，不能截断），
      // 以及 image（模型回图 / read_image 转述）。图片块留着，字节仍走 attachment 拉。
      return { message: { content: textParts(d.message?.content) } };
    case "tool/call":
      // toolText() 读 arguments（字符串或对象），toolNode 读 callId / name
      return { callId: d.callId, name: d.name, arguments: d.arguments };
    case "tool/result": {
      // 前端读 message.source.callId 找对应 chip，读 message.content 填结果正文；
      // 且正文最终会被 .slice(0, 4000) 截断 —— 这里直接截，省下的都是白流量。
      const texts = (d.message?.content || [])
        .flatMap((c) => c?.content ?? c) // 与原前端 flatMap 语义一致
        .map((c) => c?.text || "")
        .filter(Boolean)
        .join("\n")
        .slice(0, 4000);
      return {
        message: {
          source: { callId: d.message?.source?.callId },
          content: texts ? [{ text: texts }] : [],
        },
      };
    }
    case "turn/end":
      return { reason: { kind: d.reason?.kind } };
    case "todo/write":
      // TodoItem = { content: string, status: 'pending'|'in_progress'|'completed' }
      return {
        todos: Array.isArray(d.todos)
          ? d.todos.map((t) => ({ content: t?.content, status: t?.status }))
          : [],
      };
    case "llm/retry":
      // 只留前端文案要用的三个数：第几次 / 最多几次 / 等多久
      return { retry: d.retry, maxRetries: d.maxRetries, delayMs: d.delayMs };
    case "llm/retry-started":
      return { retry: d.retry };
    case "agent/inbox/spliced":
      return {
        target: d.target,
        inserted: (d.inserted || []).map((i) => ({ source: { kind: i?.source?.kind } })),
      };
    default:
      // turn/start、compaction/* 前端只用固定文案
      return {};
  }
}

/** 逐条重建 records：丢掉前端没有分支的事件类型，逐类型白名单留字段 */
function trimRecords(records) {
  const out = [];
  for (const rec of records || []) {
    const ev = rec?.event;
    if (!ev) continue;
    if (!KEEP_EVENT.has(ev.type)) continue; // 前端没有这个分支

    const data = trimEventData(ev.type, ev.data);
    // 正文全空的消息没有渲染价值，直接丢；但"非用户注入"标记要保留，
    // 前端靠 source.kind 避免把它冒充成用户发言。
    const injected =
      ev.type === "user/message" && ev.data?.source?.kind && ev.data.source.kind !== "user";
    const emptyBody = !data.message?.content?.length && !data.content?.length;
    if (emptyBody && !injected && (ev.type === "assistant/message" || ev.type === "user/message")) {
      continue;
    }
    out.push({ type: rec.type, event: { type: ev.type, seq: ev.seq, data } });
  }
  return out;
}

/**
 * 对 WS 下行帧做瘦身：只处理 session/follow 的 snapshot，其余帧原样透传。
 * 返回 Buffer 或字符串，调用方直接 send 即可。
 */
function maybeTrimFrame(buf) {
  if (!TRIM_ENABLED) return buf;

  // 快路径：绝大多数帧（live event、assistant-stream）不含 snapshot 字样，
  // 免去 JSON.parse 的开销 —— 这条路径每帧都会走，值得优化。
  if (buf.indexOf('"snapshot"') === -1) return buf;

  let m;
  try {
    m = JSON.parse(buf);
  } catch {
    return buf;
  }

  const v = m?.value;
  if (m?.type !== "item" || v?.type !== "snapshot" || !Array.isArray(v.records)) return buf;

  const before = v.records.length;
  const trimmed = trimRecords(v.records);
  v.records = trimmed;
  v.__trimmed = { from: before, to: trimmed.length };
  return JSON.stringify(m);
}

module.exports = {
  maybeTrimFrame,
  trimRecords,
  trimEventData,
  KEEP_EVENT,
  TRIM_ENABLED,
};
