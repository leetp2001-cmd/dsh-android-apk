# dsh-android-apk 技术方案：手机端操控本地 dsh

> 版本：2026-10-08 · 代码位置：仓库根目录
> 总代码量：后端 `src/` 2628 行（26 个文件）+ 前端 10 层样式 856 行 + 19 个脚本 2785 行
> + MainActivity.java 396 行。单进程、零构建依赖，`node server.js` 直接跑。
>
> 分层目标：`server.js` 只做装配与生命周期（52 行），`public/index.html` 只剩 markup 骨架
> （160 行）。逻辑与视图彻底分开，目录名即职责。

---

## 1. 目标与约束

**目标**：在手机上（任意网络）查看 dsh 会话、发消息、收流式回复、回答 agent 提问、中断任务——体验对齐 dsh 原生 Web。

**约束**（这些约束决定了整套设计的形状）：

| 约束 | 来源 | 应对 |
|---|---|---|
| dsh 本体只监听 `127.0.0.1:8742` | 安全设计，不能改 | 本地代理层桥接 |
| dsh API 无公开文档，鉴权是签名 cookie | 需逆向 | 代理侧本地铸 cookie |
| 手机与电脑常常不在同一 WiFi | 现实网络环境 | Cloudflare 隧道穿透 |
| 用户要"原生 APP"，不要打开浏览器 | 需求 | PWA + WebView APK 双形态 |
| 公网暴露面必须可控 | 安全 | 独立口令层，dsh 密钥不出本机 |

## 2. 总体架构（四层）

```
┌─ 手机端 ────────────┐   ┌────────────── 电脑端 ──────────────────┐
│ PWA / WebView APK   │   │  Cloudflare 隧道（跨 WiFi）            │
│ index.html + assets │◄──┼─► 本地代理 server.js (0.0.0.0:8760)    │
└─────────────────────┘LAN│    ├─ 口令鉴权 → dshapp-token cookie   │
                          │    ├─ 铸 dsh 签名 cookie（HMAC）       │
                          │    ├─ /rpc/<ep>  unary 转发            │
                          │    └─ /stream    WS 双向管道           │
                          │         │                              │
                          │         ▼                              │
                          │    dsh 本体 (127.0.0.1:8742)           │
                          │    凭据: ~/.dsh/.credentials.yaml      │
                          └────────────────────────────────────────┘
```

分层职责：

1. **展示层**（手机）：`public/` 下的页面骨架 + 10 层样式 + 19 个脚本模块，负责会话列表、聊天渲染、流式打字机、问答横幅。
2. **穿透层**：`cloudflared` 快速隧道，把 8760 暴露为公网 HTTPS；同 WiFi 时可直连局域网 IP。
3. **代理层**（`src/`，核心）：鉴权 + 协议桥接 + 安全隔离。`server.js` 只是入口，实际分层见下节。
4. **上游**：dsh 本体，零改动。

## 3. 核心逆向结论：dsh 私有协议

这是整个方案的基石（`probe.js` 探测得出），换任何上游版本需重新核对：

### 3.1 鉴权：签名 cookie 铸造

dsh 的鉴权不是固定 token，而是**按 authority 地址派生 cookie 名 + HMAC 签名**：

- 密钥：`~/.dsh/.credentials.yaml` 中的 `secret` 字段（base64url）。
- cookie 名：`dsh-auth-<base64url(sha256("127.0.0.1:8742"))>`
- cookie 值：`v1.<base64url(payload)>.<base64url(HMAC-SHA256(secret, payload))>`
- payload：`{version:1, authority, issuedAt, expiresAt}`（有效期给 30 天）

代理启动时读取密钥、铸造一次并缓存。**密钥永远不出本机**——手机端只见代理，不碰 dsh 凭据。

### 3.2 Unary RPC（请求-响应）

```
POST /api/<endpoint>
{ "type":"client-request", "rpcId":"<uuid>", "method":"<endpoint>",
  "payload": { "args": { "request": { ... } } } }     ← 注意 args 里还包一层 request
```

响应：`{type:"server-response", result:{ok:true, value}}`。常用端点：

| 端点 | args | 用途 |
|---|---|---|
| `session/list` | `{}` | 会话列表 |
| `session/follow` | `{request:{sessionId}}` | 快照 records 回放 + 订阅实时事件 |
| `session/prompt` | `{request:{sessionId,text,mode:"queue"}}` | 发消息（mode 必须为 queue） |
| `session/cancel` | `{request:{sessionId}}` | 中断（keepInbox:true 保留排队消息） |
| `session/page` | `{request:{sessionId,cursor}}` | 翻页历史 |

### 3.3 流式 RPC（WebSocket mux）

单条 WS 连接 `ws://…/api/remote.mux` 复用多个流：

- 客户端开流：`{type:"open", streamId, endpoint, payload}`
- 服务端帧：`upstream-open` / `item`（数据）/ `end` / `error`
- 流式 chunk 的真实类型是 **`reasoning-delta` / `text-delta` / `block-start` / `block-end`**（不是 "reasoning"，踩过的坑）

### 3.4 问答协议（$events 流）

agent `ask_user_question` 走独立事件流：

1. WS mux 首帧发 `{type:"ready", clientId}`；
2. 收 `{type:"waterfall", event:"user-questions/request", eventId, request:{questions}}`；
3. 作答 `POST /api/$events/result`：`{args:{clientId, eventId, outcome:{kind:"result", value:{answers:[{id, selected:[label]}]}}}}`，跳过用 `selected:[]`。

### 3.5 快照与实时的双通道渲染

`session/follow` 返回**已持久化的事件记录**（快照回放），同一内容又会以**实时帧**到达。两侧必须去重，否则推理显示两遍（已修，见 §7.6）。

## 4. 代理层设计（src/ 分层）

零框架，Node 22 内置 http + crypto，唯一外部依赖 `ws`（直接 require dsh 自带的 node_modules，不引入新的包管理）。

### 4.0 模块分层

原来的 865 行 `server.js` 按职责切成 8 层，依赖方向单向（`app.js` → 业务层 → `lib/`），
没有反向 require，每层可以单独读懂：

```
server.js (52)   入口：装配 → 监听 → 优雅退出
  └── src/app.js (119)   装配层：唯一知道全貌的地方，也是唯一读 config 的胶水
        ├── src/config.js (41)    环境变量与路径的唯一来源
        ├── src/auth/ (271/4)     口令 cookie · 边缘认证 · dsh 会话凭据
        ├── src/dsh/  (461/3)     RPC 代理 · 列表瘦身 · 快照瘦身
        ├── src/push/ (814/5)     配置 · 事件探测 · 通知编排 · 渠道投递
        ├── src/http/ (337/3)     请求分发 · 静态资源 · 各路由
        ├── src/ws/   (142/1)     WebSocket 双向管道
        ├── src/views/(101/1)     服务端渲染页面（登录页）
        └── src/lib/  (147/3)     无业务含义的基础件（编码、ws 解析）
```

拆分时守住的几条纪律：

- **`config.js` 是 `process.env` 的唯一读者**，其他模块只 import 常量。这样"服务到底受哪些环境变量影响"一眼可查。
- **每条路由是工厂函数**，返回 `(ctx) => Promise<boolean>`（是否已认领请求）。路由器只负责按固定顺序问一遍，不理解业务。
- **`lib/` 不允许 require 业务层**。`lib/` 是叶子。
- **原有注释一律保留**。那些注释记的是踩过的坑（ntfy 必须用 JSON 发布格式、爆破失败要退避、列表不能按时间裁……），比代码本身更值钱。

### 4.1 双层鉴权

```
手机 ──口令──► [代理：校验 passphrase → 签发 dshapp-token cookie]
                        │
                        ▼ 代理内部持 dsh cookie 转发
                    [dsh：只见合法签名 cookie]
```

- 口令：`DSH_APP_PASS` 环境变量 > `.passphrase` 文件 > 自动生成（600 权限）。
- 校验用 `crypto.timingSafeEqual` 防时序侧信道；登录接口限 POST，错误明文提示。
- app cookie：`dshapp-token = sha256("dshapp:<passphrase>")`，HttpOnly + SameSite=Strict，30 天。
- 所有路由（除 PWA 静态白名单和 `/auth`）都要求 app cookie；WS upgrade 同样校验。

### 4.2 两条转发通道

- **unary**：`POST /rpc/<endpoint>` → `forwardRpc()`，包装成 dsh 的 client-request 格式，透传 result 或映射 502。
- **streaming**：`/stream` 是一条纯 WS 管道——每个客户端连接对应一条上游 `remote.mux` 连接，消息双向透传；上游未就绪时缓冲最多 256 帧（backlog），上游断开则下发 1011 关闭帧。不在代理层解析任何流帧，保持协议中立。

### 4.3 静态资源与安全白名单

- PWA 图标/manifest/SW/APK 以**无 cookie 方式**被浏览器拉取，故设显式白名单放行；这些文件均无敏感信息。
- APK 响应加 `Content-Disposition: attachment` 便于手机直接下载安装。
- 静态文件路径做了 `path.normalize` + 前缀校验，防目录穿越。
- **安全边界**：代理持 dsh 全权 cookie，等价于本机 dsh 权限，因此口令是唯一防线——绑定 0.0.0.0 只在需要局域网时开启；走公网隧道时传输层是 TLS，口令不裸奔。

## 5. 前端设计（骨架 + 样式分层 + 脚本模块）

`public/index.html` 从 3507 行降到 160 行，只剩 markup 骨架与资源引用；
剩下的是 10 层样式（856 行）和 19 个脚本模块（2785 行）。

### 5.0 文件组织与加载顺序

```
public/
├── index.html            骨架：只有 markup，零内联 style/script
└── assets/
    ├── styles/           01-tokens → 02..09 组件 → 10-responsive（必须最后）
    └── js/               01-state → 02-utils → … → 18-preferences → 19-main
```

**样式分成 10 层而不是 1 个文件**：`01-tokens.css` 是设计令牌 + 全局重置，
`02`~`09` 是各组件（侧栏 / 聊天 / 媒体 / 推送 / 排队 / 卡片 / 面板 / Markdown），
`10-responsive.css` 是断点。响应式**必须最后加载**——它和组件规则特异性相同，
放前面会被覆盖，这是拆分时踩到的第一个坑。

**脚本是经典脚本，不是 ES module**。这是一条硬约束：模块之间靠全局符号通信，
而 `test/` 下的回归脚本用 `page.evaluate(() => state.xxx)` 直接读这些符号。
换成 module 会让所有测试立刻失效，所以 `<script src>` 按依赖顺序排列，
每个文件顶部注明「依赖谁、被谁依赖、为什么在这个位置」。

拆分纪律：

- **零行为变更**。拆分前后脚本按"去注释去空白"归一化后是**逐字节相同**的 68923 个字符，
  顶层符号 114 个不多不少。
- **`19-main.js` 是唯一的启动序列**，其他模块只声明函数、绑事件。启动顺序写在它头部注释里。
- **文件头注释写设计意图，不复述代码**。比如 `09-images.js` 说明图片上下行走的是两条
  完全不同的通道，`11-events.js` 强调它的 `KEEP_EVENT` 白名单与后端
  `src/dsh/trim-follow.js` 是**成对契约**——改一边必须改另一边。

### 5.1 状态与连接

```
const state = { sessionId, pendingRpcs, evClientId, pendingQuestions, qDrafts, ... }
```

- `rpc(endpoint, args)`：unary 封装，自动带 cookie，失败 toast。
- `connectStream()`：连接 `/stream`，断线指数退避重连；连接状态映射到顶部绿/红指示灯。
- `streamOpen(endpoint, payload, handlers)`：三参数分离（endpoint、payload、handlers）——早期把 handlers 塞进 payload 导致快照帧静默丢弃（bug #1）。

### 5.2 消息渲染管线

- `openSession(s)` → `session/follow`：先回放快照（`renderEvent` 逐条），再 `streamOpen` 订阅实时帧。
- `liveFrame(frame)`：按 chunk 类型分流——`text-delta` 追加正文气泡、`reasoning-delta` 追加可折叠推理块，临时节点标记 `.live` class。
- `renderEvent` 收到持久化 `assistant/message` 时**先移除所有 `.live` 节点再渲染**，实现实时/持久化双通道去重。
- `applyQuiet()` 降噪模式：手机端默认折叠推理过程和工具卡，配"回到底部"悬浮键——解决"思考混正文、往前滑半天"的问题。

### 5.3 交互适配

- **排队消息**：`session/prompt` 用 `mode:"queue"`，前端乐观回显 + "排队中"提示，监听 `agent/inbox/spliced` 事件刷新。
- **问答横幅**：`renderQuestionBanner` 按 eventId 聚合多问题为单卡片，草稿态（`qDrafts`）逐个选择，全部作答（或跳过）后才 `submitEventAnswers` 批量提交——修掉"点一个选项全提交"的 bug。
- **中断按钮**：两段式确认（第一次点变"⚠ 再点一次确认"，4 秒超时复位）——因为安卓 WebView 未设 WebChromeClient，`confirm()` 静默返回 false，原生弹窗路线不可用。

## 6. 移动端交付形态

### 6.1 PWA（主形态）

- `manifest.webmanifest`：名称、图标、standalone 显示模式、主题色 `#14171c`。
- `sw.js`（26 行）：网络优先策略，GET 静态资源成功后写入缓存、失败时回源缓存；`/rpc`、`/auth`、`/stream` 一律不拦截——保证动态数据永远直连最新。
- 安卓 Chrome 添加到主屏幕后即获得全屏图标体验。

### 6.2 WebView APK（补形态）

用户明确要安装包，故用纯命令行构建（无 Gradle/Android Studio）：

```
aapt2 link → javac → dx → zipalign → apksigner
```

- 包名 `com.dsh.console`，MainActivity 就是一个 WebView，加载当前隧道地址。
- 登录页内嵌 `/dsh-console.apk` 下载链接，手机浏览器可自助安装。
- 已知取舍：未设 WebChromeClient（`confirm()` 失效 → 前端已改两段式按钮绕开）；构建工具链在 /tmp，重打需重下 build-tools/platform-30。

## 7. 踩坑记录（协议契约，复用价值最高）

| # | 现象 | 根因 | 修复 |
|---|---|---|---|
| 1 | 历史记录不渲染 | `streamOpen` 三参数被错塞进 payload 对象，快照帧静默丢弃 | 参数分离 + 回归测试 |
| 2 | 发的消息不显示 | `agent/inbox/spliced` 事件无处理分支 | 乐观回显 + 排队提示 |
| 3 | 思考混进正文 | chunk 类型写成 `"reasoning"`，真实是 `reasoning-delta` | 修正分流 + 降噪模式 |
| 4 | 多问题被连带提交 | 点击单选项即 submit 整个事件 | 按 eventId 聚合 + 草稿态批量提交 |
| 5 | 手机中断无效 | WebView 无 WebChromeClient，`confirm()` 返回 false | 两段式按钮 |
| 6 | 推理显示两遍 | 快照回放与实时帧各渲染一次 | `.live` 节点标记 + 到达持久化事件时移除 |
| 7 | 图片永远到不了前端 | `textParts()` 只保留 `p.text`，image 块被整段裁掉 | 放行 `{type:"image",attachment:{…}}`，仍不下发字节 |
| 8 | 发图后前端卡死/超时 | 手机照片 3~5MB，base64 后 6MB 走隧道要几分钟 | 发送前 canvas 压到长边 2048 / <1MB |
| 9 | 推送推到了别的会话 / 短任务漏推 | ① 另一会话确实在跑 ② 5s 轮询漏掉短任务 | ① 校验 click 里 sessionId 与标题一致 ② `POLL_MS` 5000→2500 |
| 10 | 误推历史 `turn/end` | follow 打开时 snapshot 会回放事件 | `entry.ready` 标志，`snapshot` 帧只置位不推送 |
| 11 | 静音时段跨午夜失效 | 简单区间比较 `a<=cur<b` 在 23:30–07:30 永远为假 | 跨午夜走 `cur>=a || cur<b` |
| 12 | 读不到历史消息 | `session/page` 不接受 `maxMessages`；`throughSeq` 超游标直接报错 | 参数只留 `{address,throughSeq}`；超界从报错 `past cursor N` 反查真实游标 |

**方法论**：所有协议结论来自 `probe.js` 主动探测（铸 cookie → 试端点 → 抓帧），不猜；所有修复用 playwright-core 无头 Chrome 手机模拟回归。

## 8. 运维脚本

| 脚本 | 作用 | 备注 |
|---|---|---|
| `start.sh` | 起 8760 代理，默认绑 0.0.0.0，打印局域网地址 | 幂等：已有实例直接退出 |
| `tunnel.sh` | 起 Cloudflare 快速隧道，轮询日志拿公网地址 | `stop` 子命令关闭 |

**已知运维缺陷**（当前实际发生的两次"连不上"均源于此）：
1. 快速隧道地址**每次重启都变**，手机端要重填；
2. 代理与隧道都是裸 nohup 进程，**电脑重启后不会自愈**。

## 9. 演进路线

**已完成**：

1. ~~**LaunchAgent 常驻**~~：`com.dsh.console`（KeepAlive）已接管 8760 代理，`launchctl kickstart -k` 即可重启。
2. ~~**固定域名隧道**~~：已切到命名隧道（固定域名），地址不再每次都变。
3. ~~**推送通知**~~：`src/push/` + `.push.json`，轮询 `running` 边沿 + 单会话 follow 取 `turn/end`，
   `$events` 取审批/提问；Bark / ntfy / Server酱三渠道，支持静音时段与点击回跳。
4. ~~**消息里的图片**~~：下行 `session/attachment` 按 `attachmentId` 拉字节（内容寻址天然去重），
   上行 `session/prompt` 内联 base64 并在前端压缩到长边 2048 / <1MB。
5. ~~**代码分层**~~：后端 `server.js` 865 行 → 8 层 26 个模块；前端 `index.html` 3507 行 →
   160 行骨架 + 10 层样式 + 19 个脚本模块。行为零变更（脚本归一化后逐字节相同）。

**待做**：

1. **APK 通知点开直达会话**：`MainActivity` 加 `?s=` 参数透传，否则点通知会打开外部浏览器。
2. **图片缓存迁 IndexedDB**：现在刷新后要重拉，历史消息多时流量略浪费。
3. **推送渠道扩展到企微/钉钉**：目前够用，等有需求再说。

---

*附：本方案所有结论均有对应代码与回归验证支撑；dsh 协议若升级（cookie 格式、事件类型），先跑 probe.js 核对 §3 再动手。*
