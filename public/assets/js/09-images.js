/**
 * 图片：下行看图 + 上行发图。
 *
 * 两个方向走的是完全不同的通道：
 *
 *   看历史（下行）：session/follow 里图片是 {type:"image", attachment:{attachmentId,…}}，
 *     只有 id 没有字节。必须再调 session/attachment（参数要包一层 request）
 *     换回 base64 —— 每张图一次 RPC，所以必须缓存，否则滚动重绘会反复拉。
 *     缓存键用 attachmentId：它是 sha256 内容寻址，同图永远同 id，天然去重。
 *
 *   发消息（上行）：session/prompt 的 content 里直接塞 {type:"image", mediaType,
 *     data:base64}，dsh 侧校验后落盘并返回 durable 引用。限额从会话投影
 *     imageLimits 读：单图 20MB / 单条 20 张 / 8192px 边 / png jpeg webp gif。
 */

"use strict";

// ==========================================================================
// 图片
// --------------------------------------------------------------------------
// 两个方向，走的是完全不同的通道：
//
//   看历史（下行）：session/follow 里图片是 {type:"image", attachment:{attachmentId,…}}，
//     只有 id 没有字节。必须再调 session/attachment（参数要包一层 request）
//     换回 base64 —— 每张图一次 RPC，所以必须缓存，否则滚动重绘会反复拉。
//     缓存键用 attachmentId：它是 sha256 内容寻址，同图永远同 id，天然去重。
//
//   发消息（上行）：session/prompt 的 content 里直接塞 {type:"image", mediaType,
//     data:base64}，dsh 侧校验后落盘并返回 durable 引用。限额从会话投影
//     imageLimits 读：单图 20MB / 单条 20 张 / 8192px 边 / png jpeg webp gif。
// ==========================================================================

const IMG_LIMITS_FALLBACK = {
  maxImageBytes: 20971520, maxImagesPerMessage: 20, maxImageDimension: 8192,
  mediaTypes: ["image/png", "image/jpeg", "image/webp", "image/gif"],
};
function imgLimits() {
  const pv = state.projVals || {};
  const s = state.sessions.find((x) => x.sessionId === state.sessionId);
  const v = pv.imageLimits || s?.projections?.values?.imageLimits;
  return { ...IMG_LIMITS_FALLBACK, ...(v && typeof v === "object" ? v : {}) };
}
function fmtBytes(n) {
  if (typeof n !== "number" || !isFinite(n) || n <= 0) return "0";
  if (n < 1024) return n + " B";
  if (n < 1048576) return (n / 1024).toFixed(0) + " KB";
  return (n / 1048576).toFixed(1) + " MB";
}

// 内存缓存：attachmentId -> dataURL。会话内翻上翻下都命中，切会话不清
// （同图跨会话共享，正是内容寻址的好处）。
const imgCache = new Map();
const imgInflight = new Map(); // 并发去重：同一张图被同时请求只发一次 RPC

// 拉一张图。sessionId 参与寻址（attachment 按会话鉴权），但缓存按 id，
// 所以同一张图在别的会话命中缓存时不用再鉴权一次。
async function loadImage(sessionId, attachmentId) {
  if (imgCache.has(attachmentId)) return imgCache.get(attachmentId);
  if (imgInflight.has(attachmentId)) return imgInflight.get(attachmentId);
  const p = (async () => {
    try {
      const v = await rpc("session/attachment", { request: { sessionId, attachmentId } });
      const mt = v?.attachment?.mediaType || "image/png";
      const url = `data:${mt};base64,${v.data}`;
      imgCache.set(attachmentId, url);
      // 内存缓存上限：手机 WebView 里 dataURL 很吃内存，超了就从最早的开始丢
      if (imgCache.size > 120) {
        const k = imgCache.keys().next().value;
        imgCache.delete(k);
      }
      return url;
    } finally {
      imgInflight.delete(attachmentId);
    }
  })();
  imgInflight.set(attachmentId, p);
  return p;
}

// 把一组图片块渲染成一个 .mimg 容器（异步填图，先出占位）
// blocks: [{attachment:{attachmentId, width, height, name}}]
function renderImages(blocks, sessionId) {
  const wrap = document.createElement("div");
  wrap.className = "mimg";
  for (const blk of blocks) {
    const att = blk?.attachment || {};
    const id = att.attachmentId;
    if (!id) continue;
    const cell = document.createElement("div");
    cell.className = "mimg-cell";
    cell.innerHTML = `<span class="mimg-ph">图片加载中…</span>`;
    wrap.appendChild(cell);
    const sid = sessionId || state.sessionId;
    loadImage(sid, id).then((url) => {
      if (!cell.isConnected) return;
      const im = document.createElement("img");
      im.src = url;
      im.alt = att.name || "图片";
      im.loading = "lazy";
      // 按原始宽高比给个瞬时尺寸，避免图解码完成时整段消息跳一下
      if (att.width && att.height) {
        im.width = att.width;
        im.height = att.height;
      }
      cell.innerHTML = "";
      cell.appendChild(im);
      cell.onclick = () => openLightbox(url);
    }).catch((e) => {
      if (!cell.isConnected) return;
      cell.classList.add("failed");
      cell.innerHTML = `<span class="mimg-ph">图片加载失败<br>点击重试</span>`;
      cell.onclick = () => {
        cell.classList.remove("failed");
        cell.innerHTML = `<span class="mimg-ph">图片加载中…</span>`;
        cell.onclick = null;
        loadImage(sid, id).then((url) => {
          const im = document.createElement("img");
          im.src = url;
          cell.innerHTML = "";
          cell.appendChild(im);
          cell.onclick = () => openLightbox(url);
        }).catch(() => {
          cell.classList.add("failed");
          cell.innerHTML = `<span class="mimg-ph">仍然失败</span>`;
        });
      };
    });
  }
  return wrap;
}

function openLightbox(url) {
  $("lightbox").querySelector("img").src = url;
  $("lightbox").classList.add("show");
}
$("lightbox").onclick = () => { $("lightbox").classList.remove("show"); $("lightbox").querySelector("img").src = ""; };

// ---------- 选图（草稿） ----------
// 选图时不读字节、不上传：等按下发送才读。理由是手机上选 20 张 4K 照片
// 一次性读进内存会直接 OOM 闪退，而且用户经常选了又删。
function fileToDataUrl(file) {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(String(fr.result || ""));
    fr.onerror = () => rej(new Error("读取文件失败"));
    fr.readAsDataURL(file);
  });
}

// ---------- 发送前压缩 ----------
// 为什么必须压：手机随手一张照片 3~5MB，base64 后 ×1.37 ≈ 6MB，走公网隧道
// （~40KB/s 上行）要 2~3 分钟，实际等于发不出去。dsh 侧限额是 20MB/张，
// 所以不压也"合法"，但体验上完全不可用。
//
// 策略（宁可保守，别把图压烂）：
//   · GIF 一律不碰 —— canvas 会把动图拍成首帧，这是不可逆的损失。
//   · 已经够小（≤900KB 且边长 ≤2048）就不压，省一次 canvas 往返。
//   · 只降边长、不改画质取向：长边收到 2048，绝大多数模型视觉输入
//     （含 OCR 场景）在这个尺寸下已经饱和，再大纯属浪费带宽。
//   · JPEG q=0.85：文字截图在 .85 下仍清晰可读，照片肉眼看不出差别。
//   · 压完反而更大就退回原图（小 PNG 转 JPEG 有时会变大，不能盲目替换）。
const COMPRESS = { maxBytes: 900 * 1024, maxSide: 2048, quality: 0.85, skipTypes: ["image/gif"] };

function compressImage(file) {
  const mt = (file.type || "").toLowerCase();
  const passthrough = { blob: file, mediaType: mt, name: file.name || "image", bytes: file.size, compressed: false };
  if (COMPRESS.skipTypes.includes(mt)) return Promise.resolve(passthrough);

  return probeImageSize(file).then(({ w, h }) => {
    const side = Math.max(w, h);
    if (file.size <= COMPRESS.maxBytes && side <= COMPRESS.maxSide) return passthrough;

    const scale = Math.min(1, COMPRESS.maxSide / side);
    const tw = Math.max(1, Math.round(w * scale));
    const th = Math.max(1, Math.round(h * scale));
    return new Promise((res) => {
      const url = URL.createObjectURL(file);
      const im = new Image();
      const done = (v) => { URL.revokeObjectURL(url); res(v); };
      im.onload = () => {
        try {
          const cv = document.createElement("canvas");
          cv.width = tw; cv.height = th;
          const g = cv.getContext("2d");
          // 透明 PNG 转 JPEG 会变黑底，先铺白
          g.fillStyle = "#fff";
          g.fillRect(0, 0, tw, th);
          g.drawImage(im, 0, 0, tw, th);
          cv.toBlob((blob) => {
            if (!blob || blob.size >= file.size) return done(passthrough);
            // 文件名后缀要跟着改，否则 dsh 侧按名推断类型会错
            const base = (file.name || "image").replace(/\.[^.]+$/, "");
            done({ blob, mediaType: "image/jpeg", name: base + ".jpg", bytes: blob.size, compressed: true });
          }, "image/jpeg", COMPRESS.quality);
        } catch { done(passthrough); }
      };
      im.onerror = () => done(passthrough); // 解不开就原样发，让 dsh 侧去报错
      im.src = url;
    });
  }).catch(() => passthrough);
}

function renderAttachBar() {
  const bar = $("attach-bar");
  const list = state.draftImages;
  if (!list.length) { bar.classList.remove("show"); bar.innerHTML = ""; return; }
  bar.classList.add("show");
  bar.innerHTML = "";
  list.forEach((it) => {
    const d = document.createElement("div");
    d.className = "athumb" + (it.busy ? " busy" : "");
    d.innerHTML = `<img src="${it.previewUrl}" alt=""><button class="ax" title="移除">✕</button>`;
    d.querySelector(".ax").onclick = (e) => {
      e.stopPropagation();
      state.draftImages = state.draftImages.filter((x) => x.id !== it.id);
      renderAttachBar();
      syncComposer();
    };
    bar.appendChild(d);
  });
  syncComposer();
}

async function addImages(files) {
  const lim = imgLimits();
  const arr = Array.from(files || []);
  if (!arr.length) return;
  const room = lim.maxImagesPerMessage - state.draftImages.length;
  if (room <= 0) { toast(`一条消息最多 ${lim.maxImagesPerMessage} 张图`); return; }
  const take = arr.slice(0, room);
  if (arr.length > room) toast(`最多 ${lim.maxImagesPerMessage} 张，已忽略多余的`);

  let rejected = 0;
  for (const f of take) {
    const mt = (f.type || "").toLowerCase();
    if (!lim.mediaTypes.includes(mt)) { rejected++; continue; }
    if (f.size > lim.maxImageBytes) { rejected++; continue; }
    const id = "d" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    state.draftImages.push({ id, name: f.name || "image", mediaType: mt, file: f, previewUrl: URL.createObjectURL(f), bytes: f.size });
  }
  // 逐张检查像素边长（超过 maxImageDimension 的 dsh 会整条拒掉，先自己拦）
  const dim = lim.maxImageDimension;
  await Promise.all(state.draftImages.filter((x) => x.file && !x.checked).map(async (it) => {
    it.checked = true;
    try {
      const probe = await probeImageSize(it.file);
      if (probe.w > dim || probe.h > dim) {
        it.tooBig = `${probe.w}×${probe.h}`;
        rejected++;
        state.draftImages = state.draftImages.filter((x) => x.id !== it.id);
      }
    } catch {}
  }));
  if (rejected) toast(`有 ${rejected} 张不符合要求（格式/大小/${dim}px 边）`);
  renderAttachBar();
}

function probeImageSize(file) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file);
    const im = new Image();
    im.onload = () => { res({ w: im.naturalWidth, h: im.naturalHeight }); URL.revokeObjectURL(url); };
    im.onerror = () => { rej(new Error("无法解析图片")); URL.revokeObjectURL(url); };
    im.src = url;
  });
}

// 输入区可用性集中判定：有文字**或**有图就能发
function syncComposer() {
  const hasText = !!$("prompt").value.trim();
  const hasImg = state.draftImages.length > 0;
  const ready = !!state.sessionId;
  $("send").disabled = !ready || (!hasText && !hasImg);
  $("btn-pick").disabled = !ready;
}

$("btn-pick").onclick = () => {
  if (!state.sessionId) return toast("先选一个会话");
  $("file-img").value = ""; // 允许重复选同一张
  $("file-img").click();
};
$("file-img").onchange = (e) => { addImages(e.target.files); e.target.value = ""; };
// 桌面浏览器：直接把图拖进聊天区，也算选图
$("chat").addEventListener("dragover", (e) => {
  if (!e.dataTransfer?.types?.includes("Files")) return;
  e.preventDefault();
});
$("chat").addEventListener("drop", (e) => {
  if (!e.dataTransfer?.files?.length) return;
  e.preventDefault();
  if (!state.sessionId) return toast("先选一个会话");
  addImages(e.dataTransfer.files);
});
// 粘贴板里的图（桌面截图后 Ctrl+V）
$("prompt").addEventListener("paste", (e) => {
  const items = e.clipboardData?.items || [];
  const files = [];
  for (const it of items) if (it.kind === "file" && it.type.startsWith("image/")) {
    const f = it.getAsFile();
    if (f) files.push(f);
  }
  if (files.length) { e.preventDefault(); addImages(files); }
});
