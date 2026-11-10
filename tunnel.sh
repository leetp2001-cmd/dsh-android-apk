#!/bin/zsh
# 启动 Cloudflare 快速隧道（无需账号），把本机 dsh 控制台暴露到公网 HTTPS
# 用法: ./tunnel.sh        启动并打印公网地址
#       ./tunnel.sh stop   停止隧道
# ⚠️ 公网暴露：口令(.passphrase)是唯一防线，用完请 stop
cd "$(dirname "$0")"

if [[ "$1" == "stop" ]]; then
  pkill -f "cloudflared tunnel --url" 2>/dev/null && echo "[tunnel] 已停止" || echo "[tunnel] 没有在跑的隧道"
  exit 0
fi

# 校验 .tunnel-url 是否真的打到本机服务。
# 注意：失效的快速隧道域名仍会返回 http 200，但正文是 Cloudflare 错误页，
# 所以必须看 /healthz 的 JSON，状态码不可信。
if [[ "$1" == "check" ]]; then
  URL=$(cat .tunnel-url 2>/dev/null)
  [[ -z "$URL" ]] && { echo "[tunnel] .tunnel-url 为空，先跑 ./tunnel.sh"; exit 1; }
  echo "[tunnel] 检查: $URL"
  BODY=$(curl -s --noproxy '*' --max-time 12 "$URL/healthz")
  if echo "$BODY" | grep -q '"app/unauthorized"'; then
    echo "[tunnel] ✅ 通到本机（未登录返回 app/unauthorized，属正常）"
    exit 0
  fi
  LIVE=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' /tmp/dsh-app-tunnel.log 2>/dev/null | head -1)
  echo "[tunnel] ❌ 这个地址已失效（不是本机服务）"
  echo "[tunnel]    实际返回: $(echo "$BODY" | head -c 120)"
  [[ -n "$LIVE" && "$LIVE" != "$URL" ]] && echo "[tunnel]    当前隧道进程的真实地址是: $LIVE"
  echo "[tunnel]    修复: ./tunnel.sh，或 echo '$LIVE' > .tunnel-url"
  exit 1
fi

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "[tunnel] cloudflared 未安装: brew install cloudflared"
  exit 1
fi

if ! curl -s -o /dev/null http://127.0.0.1:8760/healthz; then
  echo "[tunnel] dsh-app 没在跑，先执行 ./start.sh"
  exit 1
fi

LOG=/tmp/dsh-app-tunnel.log
pkill -f "cloudflared tunnel --url" 2>/dev/null
sleep 0.5
: > "$LOG"
cloudflared tunnel --url http://127.0.0.1:8760 --no-autoupdate > "$LOG" 2>&1 &

echo "[tunnel] 启动中（约 3-5 秒）…"
for i in {1..20}; do
  sleep 1
  URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG" | head -1)
  if [ -n "$URL" ]; then
    # 必须写回，否则 .tunnel-url 会停留在旧地址（旧地址返回 Cloudflare 错误页，
    # 表面 http=200 但内容是 1033/530 错误页，极难发现）
    echo "$URL" > .tunnel-url
    echo "[tunnel] 公网地址: $URL"
    echo "[tunnel] 已写入 .tunnel-url"
    echo "[tunnel] 口令: $(cat .passphrase)"
    echo "[tunnel] 停止: ./tunnel.sh stop"
    exit 0
  fi
done
echo "[tunnel] 未拿到地址，日志如下："
tail -20 "$LOG"
