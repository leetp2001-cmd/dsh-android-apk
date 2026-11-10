/**
 * 全局状态：唯一的状态容器。
 *
 * 为什么用一个扁平对象而不是分散的模块级变量：手机端所有渲染函数都要
 * 读同一份状态，分散必然导致"某个面板不知道某次变化"的 bug。
 *
 * 约定：**只在这里声明**，其他文件只读写不新增字段。
 * 新增状态字段时想清楚——它该不该是持久态（localStorage）或派生值。
 */

"use strict";

const $ = (id) => document.getElementById(id);
const state = {
  sessions: [], current: null, followCtl: null, stream: null,
  streamReady: false, pendingOpen: new Map(), nextStreamId: 1,
  controlStreamId: null, // session/control 长订阅的 streamId（投影实时增量）
  projSeq: null,         // 投影水位（asOfSeq / projection.seq），用来丢弃乱序旧帧
  toolChips: new Map(), sessionId: null, cursorSeq: -1,
  pendingRpcs: new Set(), // 已乐观回显、等待事件回确认的 prompt rpcId
  evClientId: null, // $events 流的 clientId
  pendingQuestions: new Map(), // eventId -> {eventId, questions}
  qDrafts: new Map(), // eventId -> 每题草稿 [{selected:[], custom:"", skipped:false}]
  qSteps: new Map(), // eventId -> 逐题展示当前第几题
  pendingApprovals: new Map(), // eventId -> {eventId, agent, callId, toolName, reason}
  todoOpen: false, // 待办面板展开态（跨刷新保留）
  ctxOpen: false, // 上下文面板展开态
  running: false, // 当前会话是否在执行中（中断键的唯一真源）
  runGuardAt: 0,  // 乐观置为运行中的时刻：给滞后的 session/list 一个宽限期
  draftImages: [], // 待发送的图片草稿 [{id, name, mediaType, dataUrl, bytes}]
};
