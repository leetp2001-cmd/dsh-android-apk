#!/usr/bin/env bash
# 启动 dsh 控制台（需 dsh web 已在 127.0.0.1:8742 运行）
# 默认绑定 :: （双栈：IPv4 + IPv6 同一端口），以便手机 / 局域网 / IPv6 直连访问
# 口令在 .passphrase 文件（首次启动自动生成）；
# 只想本机访问: DSH_APP_BIND=127.0.0.1 ./start.sh
cd "$(dirname "$0")" || exit 1

PORT="${DSH_APP_PORT:-8760}"
BIND="${DSH_APP_BIND:-::}"

if lsof -tiTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "[dsh-app] 端口 $PORT 已有实例在跑: http://127.0.0.1:$PORT"
  echo "          换端口:  DSH_APP_PORT=8761 ./start.sh"
  echo "          停旧的:  kill \$(lsof -tiTCP:$PORT -sTCP:LISTEN)"
  exit 0
fi

# 局域网信息：macOS 用 ipconfig/scutil，Linux 用 ip route/hostname
if command -v ipconfig >/dev/null 2>&1; then
  LAN_IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null)
  MDNS_HOST="$(scutil --get LocalHostName 2>/dev/null)"
else
  LAN_IP=$(ip route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") print $(i+1)}' | head -1)
  MDNS_HOST="$(hostname -s 2>/dev/null)"
fi

echo "[dsh-app] 本机访问: http://127.0.0.1:$PORT"
[ -n "$LAN_IP" ]    && echo "[dsh-app] 局域网 IP: http://$LAN_IP:$PORT  （口令见 .passphrase）"
[ -n "$MDNS_HOST" ] && echo "[dsh-app] 固定地址:   http://$MDNS_HOST.local:$PORT  （同 Wi-Fi 永不变）"

# 上游端口提示：dsh 默认 3080，改过端口的人最容易在这里卡住。
# 只做提醒，不阻断 —— 服务器可能随后才启动（launchd 里两个服务的启动顺序不保证）。
DSH_AUTHORITY="${DSH_AUTHORITY:-127.0.0.1:3080}"
UP_PORT="${DSH_AUTHORITY##*:}"
if ! (exec 3<>"/dev/tcp/127.0.0.1/$UP_PORT") 2>/dev/null; then
  echo "[dsh-app] 注意: 上游 $DSH_AUTHORITY 当前没有服务在听"
  echo "           如果 dsh 还没启动，先另开终端跑 \"dsh web\"；"
  echo "           如果 dsh 用的是别的端口: DSH_AUTHORITY=127.0.0.1:<端口> ./start.sh"
else
  exec 3>&- 2>/dev/null
fi

# node 解释器：先认 PATH，再按常见安装位置兜底
NODE_BIN="${NODE_BIN:-}"
if [ -z "$NODE_BIN" ]; then
  NODE_BIN="$(command -v node 2>/dev/null || true)"
fi
if [ -z "$NODE_BIN" ]; then
  for cand in "$HOME/.nvm/versions/node/"*/bin/node \
              "/opt/homebrew/bin/node" "/usr/local/bin/node" \
              "/usr/bin/node" "$HOME/.local/bin/node"; do
    if [ -x "$cand" ]; then NODE_BIN="$cand"; break; fi
  done
fi
if [ -z "$NODE_BIN" ]; then echo "[dsh-app] 找不到可用 node，请先安装 Node.js 18+" >&2; exit 1; fi
echo "[dsh-app] node: $NODE_BIN"

DSH_APP_BIND="$BIND" exec "$NODE_BIN" server.js
