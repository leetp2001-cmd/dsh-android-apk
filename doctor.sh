#!/usr/bin/env bash
# =============================================================================
# dsh-app 自助诊断
# -----------------------------------------------------------------------------
# 把「能不能用」拆成 7 个可以单独回答的问题，逐个检查并给出结论。
#
# 用法：
#   ./doctor.sh              看当前状态
#   ./doctor.sh --fix-hint   额外打印每条的修复命令
#
# 这个脚本只读不写：不启停服务、不改配置、不删文件。放心随便跑。
# =============================================================================
set -uo pipefail
cd "$(dirname "$0")" || exit 1

VERBOSE="${1:-}"

# ---- 输出小工具 --------------------------------------------------------------
PASS=0; FAIL=0; WARN=0
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; PASS=$((PASS+1)); }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; FAIL=$((FAIL+1)); }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; WARN=$((WARN+1)); }
info() { printf '    \033[90m%s\033[0m\n' "$1"; }
sec()  { printf '\n\033[1m%s\033[0m\n' "$1"; }

# 端口是否在监听（不依赖 lsof 的具体输出格式）
listening() {
  local port="$1"
  (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null && { exec 3>&- 2>/dev/null; return 0; }
  return 1
}

APP_PORT="${DSH_APP_PORT:-8760}"
AUTHORITY="${DSH_AUTHORITY:-127.0.0.1:3080}"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"

printf '\033[1m dsh-app 自助诊断\033[0m  %s\n' "$(date '+%Y-%m-%d %H:%M:%S')"
info "本服务端口 $APP_PORT · 上游 $AUTHORITY · DSH_HOME $DSH_HOME"

# =============================================================================
sec "1. 运行环境"
# =============================================================================

NODE_BIN="$(command -v node 2>/dev/null || true)"
if [ -z "$NODE_BIN" ]; then
  for cand in "$HOME/.nvm/versions/node/"*/bin/node \
              "/opt/homebrew/bin/node" "/usr/local/bin/node" "/usr/bin/node"; do
    [ -x "$cand" ] && { NODE_BIN="$cand"; break; }
  done
fi
if [ -n "$NODE_BIN" ]; then
  NODE_VER="$("$NODE_BIN" -v 2>/dev/null)"
  NODE_MAJOR="$(printf '%s' "$NODE_VER" | sed 's/^v\([0-9]*\).*/\1/')"
  if [ "${NODE_MAJOR:-0}" -ge 18 ]; then
    ok "Node.js ${NODE_VER}（${NODE_BIN}）"
  else
    bad "Node.js $NODE_VER 太旧，需要 18+"
  fi
else
  bad "找不到 node"
fi

# =============================================================================
sec "2. dsh 本体"
# =============================================================================

UP_HOST="${AUTHORITY%:*}"
UP_PORT="${AUTHORITY##*:}"
if listening "$UP_PORT"; then
  ok "上游端口 $UP_PORT 有服务在听（$UP_HOST:${UP_PORT}）"
else
  bad "上游端口 $UP_PORT 没有服务在听 —— dsh web 没启动？"
  # 猜它是不是跑在别的常见端口上
  for p in 3080 8742 3000 8080 8000; do
    [ "$p" = "$UP_PORT" ] && continue
    if listening "$p"; then
      warn "检测到端口 $p 上有服务在听 —— 如果那就是 dsh，请用："
      info "DSH_AUTHORITY=127.0.0.1:$p ./start.sh"
      break
    fi
  done
fi

CRED="$DSH_HOME/.credentials.yaml"
if [ -f "$CRED" ]; then
  ok "凭据文件存在（${CRED}）"
  if grep -q 'secret:' "$CRED" 2>/dev/null; then
    ok "凭据里有 secret 字段"
  else
    bad "凭据文件里没有 secret 字段 —— 文件可能坏了，试着重启一次 dsh web"
  fi
else
  bad "找不到凭据文件 $CRED"
  info "通常意味着 DSH_HOME 指错了，或 dsh 从未跑过"
fi

# =============================================================================
sec "3. ws 依赖"
# =============================================================================

if [ -d "node_modules/ws" ]; then
  ok "仓库内已装 ws（node_modules/ws）"
else
  # 让解析器自己回答，跟运行时用的是同一套逻辑
  WS_FROM="$("$NODE_BIN" -e 'try{const w=require("./src/lib/ws.js");console.log(w.__resolvedFrom||"ok")}catch(e){process.exit(1)}' 2>/dev/null | tr -d '\n')"
  if [ -n "$WS_FROM" ] && [ "$WS_FROM" != "ok" ]; then
    ok "ws 可解析：$WS_FROM"
  elif [ "$WS_FROM" = "ok" ]; then
    ok "ws 可解析"
  else
    bad "找不到 ws —— 在仓库目录执行 npm install"
  fi
fi

# =============================================================================
sec "4. 本服务"
# =============================================================================

PID="$(lsof -tiTCP:"$APP_PORT" -sTCP:LISTEN 2>/dev/null | head -1)"
if [ -n "$PID" ]; then
  ok "服务在运行（PID ${PID}，端口 ${APP_PORT}）"
  if curl -s --max-time 3 "http://127.0.0.1:$APP_PORT/healthz" -o /tmp/.dsh-doctor-healthz 2>/dev/null; then
    HZ="$(cat /tmp/.dsh-doctor-healthz 2>/dev/null)"
    case "$HZ" in
      *'"dsh":"up"'*)   ok "healthz 报告 dsh:up" ;;
      *'"dsh":"down"'*) bad "healthz 报告 dsh:down —— 见上面第 2 节" ;;
      *unauthorized*)   ok "healthz 可达（返回未授权，属正常：健康检查也要口令）" ;;
      *) warn "healthz 返回了意料之外的内容：$(printf '%s' "$HZ" | head -c 100)" ;;
    esac
    rm -f /tmp/.dsh-doctor-healthz
  else
    warn "端口在听但 /healthz 无响应"
  fi
else
  warn "服务没在跑 —— ./start.sh 启动它"
fi

# =============================================================================
sec "5. 访问口令"
# =============================================================================

if [ -n "${DSH_APP_PASS:-}" ]; then
  ok "口令来自环境变量 DSH_APP_PASS"
elif [ -f ".passphrase" ]; then
  PW="$(cat .passphrase 2>/dev/null)"
  if [ -n "$PW" ]; then
    ok "口令文件存在（.passphrase，${#PW} 位）"
    PERM="$(stat -f '%Lp' .passphrase 2>/dev/null || stat -c '%a' .passphrase 2>/dev/null)"
    if [ "$PERM" = "600" ]; then
      ok "权限 600（仅本人可读）"
    else
      warn "权限是 ${PERM:-未知}，建议 chmod 600 .passphrase"
    fi
    info "口令：$PW"
  else
    bad ".passphrase 存在但是空的 —— 删掉它让服务重新生成"
  fi
else
  warn "还没有 .passphrase（首次启动会自动生成）"
fi

# =============================================================================
sec "6. 公网隧道（可选）"
# =============================================================================

HAS_TUNNEL=0
for f in .tunnel-url; do
  if [ -f "$f" ]; then
    HAS_TUNNEL=1
    URL="$(head -1 "$f" 2>/dev/null)"
    ok "记录中的公网地址：$URL"
    if curl -s --max-time 8 -o /dev/null -w '%{http_code}' "$URL" 2>/dev/null | grep -qE '^[23]'; then
      ok "该地址当前可达"
    else
      warn "该地址当前不可达（隧道可能已停：./tunnel-ngrok.sh status）"
    fi
  fi
done
if [ "$HAS_TUNNEL" = "0" ]; then
  info "未配置隧道 —— 只能同 Wi-Fi 访问。需要外网见 README「手机访问」一节"
fi

if pgrep -f "ngrok.*http" >/dev/null 2>&1; then
  ok "ngrok 进程在跑"
elif [ -f ".ngrok.pid" ] && kill -0 "$(cat .ngrok.pid 2>/dev/null)" 2>/dev/null; then
  ok "ngrok 进程在跑（PID $(cat .ngrok.pid)）"
else
  info "未检测到运行中的 ngrok（不是必须）"
fi

# =============================================================================
sec "7. 推送（可选）"
# =============================================================================

if [ -f ".push.json" ]; then
  if "$NODE_BIN" -e 'const c=require("./.push.json");const n=(c.channels||[]).filter(x=>x.enabled).length;process.exit(n>0?0:1)' 2>/dev/null; then
    CNT="$("$NODE_BIN" -e 'const c=require("./.push.json");console.log((c.channels||[]).filter(x=>x.enabled).length)' 2>/dev/null)"
    ok "推送已配置，$CNT 个渠道启用"
  else
    info "推送配置存在，但没有启用的渠道"
  fi
else
  info "未配置推送（不是必须）—— 在页面里点「通知」设置"
fi

# =============================================================================
printf '\n\033[1m结果：\033[0m \033[32m%d 项通过\033[0m' "$PASS"
[ "$WARN" -gt 0 ] && printf '，\033[33m%d 项提醒\033[0m' "$WARN"
[ "$FAIL" -gt 0 ] && printf '，\033[31m%d 项失败\033[0m' "$FAIL"
printf '\n'

if [ "$FAIL" -gt 0 ]; then
  printf '\n\033[33m先把上面标 ✗ 的修掉，它们会直接导致功能不可用。\033[0m\n'
  printf '多数情况就是这两个原因：\n'
  printf '  1. dsh web 没启动          → 另开终端跑 "dsh web"\n'
  printf '  2. 端口不一致              → DSH_AUTHORITY=127.0.0.1:<dsh的端口> ./start.sh\n'
  exit 1
elif [ "$WARN" -gt 0 ]; then
  printf '\n\033[32m核心链路正常\033[0m，标 ! 的不影响使用。\n'
  exit 0
else
  printf '\n\033[32m一切正常。\033[0m手机访问：http://127.0.0.1:%s\n' "$APP_PORT"
  exit 0
fi
