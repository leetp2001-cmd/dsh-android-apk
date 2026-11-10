#!/bin/zsh
# =============================================================================
# ngrok 固定域名隧道（免费，域名重启不变）
# -----------------------------------------------------------------------------
# 与 tunnel.sh 的区别：
#   tunnel.sh      Cloudflare 快速隧道，免账号，但**地址每次重启都变**
#   本脚本         ngrok 免费版 dev domain，**同一个域名永久复用**，
#                  手机端存一次地址就不用再改——这才是「长期可用」的方案
#
# 用法:
#   ./tunnel-ngrok.sh              启动（自动用你账号的 dev domain）
#   ./tunnel-ngrok.sh stop         停止
#   ./tunnel-ngrok.sh check        校验 .tunnel-url 是否真的打到本机
#   ./tunnel-ngrok.sh status       打印当前域名与配置状态
#
# 首次使用需要注册并配置 authtoken，流程见 README「免费半永久隧道」一节，
# 本脚本会在缺 token 时直接把那几步打印出来。
# =============================================================================
cd "$(dirname "$0")"

PORT="${DSH_APP_PORT:-8760}"
URL_FILE=".tunnel-url"
PID_FILE=".ngrok.pid"
LOG=/tmp/dsh-app-ngrok.log

# dashboard 用独立端口，避开 ngrok 默认的 4040——
# 很多人的机器上另有一个 ngrok 在跑（比如给别的项目用），抢 4040 会启动失败。
# 注意：ngrok 3.x 已移除 --web-addr 命令行参数，只能靠叠加配置文件改。
DASH_PORT="${DSH_NGROK_DASH_PORT:-4041}"
DASH_CONF="/tmp/dsh-app-ngrok-dash.yml"

die() { echo "[ngrok] $*" >&2; exit 1; }

# ngrok 配置文件位置随平台和版本不同，别硬编码一个路径：
#   macOS   ~/Library/Application Support/ngrok/ngrok.yml
#   Linux   ~/.config/ngrok/ngrok.yml
# 所以直接问 ngrok 自己（config check 成功即有配置）。
has_ngrok_config() {
  [[ -n "$NGROK_AUTHTOKEN" ]] && return 0
  command -v ngrok >/dev/null 2>&1 || return 1
  ngrok config check >/dev/null 2>&1
}

# 只认自己起的那个进程。
# 不能用 pkill -f "ngrok http"：用户机器上可能还有别的 ngrok 在服务其他项目，
# 那样会把它一起杀掉——这类"顺手干掉别人"的行为绝对不能有。
running_pid() {
  [[ -f "$PID_FILE" ]] || return 1
  local pid
  pid=$(cat "$PID_FILE" 2>/dev/null)
  [[ -n "$pid" ]] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  echo "$pid"
}

stop_own() {
  local pid
  if pid=$(running_pid); then
    kill "$pid" 2>/dev/null
    # 给 2 秒优雅退出，不行再强杀
    for _ in {1..20}; do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.1
    done
    kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null
    rm -f "$PID_FILE"
    return 0
  fi
  rm -f "$PID_FILE"
  return 1
}

# ---------- 子命令 ----------
case "$1" in
  stop)
    if stop_own; then
      echo "[ngrok] 已停止"
    else
      echo "[ngrok] 本脚本没有在跑的隧道"
    fi
    # 提醒一下：别的 ngrok 不归本脚本管
    if pgrep -f "ngrok http" >/dev/null 2>&1; then
      echo "[ngrok] 注意：机器上还有别的 ngrok 进程在跑（不是本脚本起的，未动它）"
    fi
    exit 0
    ;;
  status)
    echo "[ngrok] 已安装: $(command -v ngrok || echo '否')"
    command -v ngrok >/dev/null 2>&1 && echo "[ngrok] 版本:   $(ngrok --version 2>/dev/null)"
    if has_ngrok_config; then
      echo "[ngrok] authtoken: 已配置"
    else
      echo "[ngrok] authtoken: ❌ 未配置（跑 ./tunnel-ngrok.sh 看申请步骤）"
    fi
    if pid=$(running_pid); then
      echo "[ngrok] 本脚本进程: 运行中 (PID $pid)"
    else
      echo "[ngrok] 本脚本进程: 未运行"
    fi
    echo "[ngrok] 当前域名: $(cat $URL_FILE 2>/dev/null || echo '(空)')"
    exit 0
    ;;
  check)
    URL=$(cat "$URL_FILE" 2>/dev/null)
    [[ -z "$URL" ]] && die ".tunnel-url 为空，先跑 ./tunnel-ngrok.sh"
    echo "[ngrok] 检查: $URL"
    # 状态码不可信：隧道挂了也可能返回 200 + 错误页，必须看 /healthz 的 JSON
    BODY=$(curl -s --noproxy '*' --max-time 15 \
           -H "ngrok-skip-browser-warning: 1" "$URL/healthz")
    if echo "$BODY" | grep -q '"app/unauthorized"'; then
      echo "[ngrok] ✅ 通到本机（未登录返回 app/unauthorized，属正常）"
      exit 0
    fi
    echo "[ngrok] ❌ 这个地址不通本机"
    echo "[ngrok]    实际返回: $(echo "$BODY" | head -c 160)"
    echo "[ngrok]    排查: 1) ./start.sh 是否在跑  2) 本脚本进程是否还在  3) 免费额度是否用完"
    exit 1
    ;;
esac

# ---------- 启动 ----------
command -v ngrok >/dev/null 2>&1 || cat <<'EOF'
[ngrok] 未安装 ngrok，任选一种：

  macOS   brew install ngrok/ngrok/ngrok
  Linux   https://ngrok.com/download 下载对应架构的二进制，解压后放进 PATH
  通用    见 https://ngrok.com/docs/getting-started/

EOF
command -v ngrok >/dev/null 2>&1 || exit 1

# authtoken 检查：没有就打印完整申请流程，别让人自己猜
if ! has_ngrok_config; then
  cat <<'EOF'
[ngrok] 还没有配置 authtoken。免费固定域名的申请流程：

  1. 注册账号（免费，不需要信用卡）
     https://dashboard.ngrok.com/signup

  2. 复制你的 authtoken
     登录后进 https://dashboard.ngrok.com/get-started/your-authtoken
     页面上那串 "Your Authtoken" 就是，点复制。

  3. 写进本机配置（一条命令搞定，token 不会进仓库）
     ngrok config add-authtoken <粘贴你的token>

  4. 回来看你的固定域名
     https://dashboard.ngrok.com/domains
     列表里那条形如 xxxx-xx-xx-xx-xx.ngrok-free.dev 的就是你的 dev domain。
     **它属于你的账号，永久不变**，重启、换网络、换电脑都不变。
     免费版只能有这一个，且不能改名（名字是 ngrok 随机分配的）。

  5. 重新执行 ./tunnel-ngrok.sh

注意：免费版每月 1GB 流量 / 2 万次请求，超出会暂停到下一个计费周期。
EOF
  exit 1
fi

if ! curl -s -o /dev/null --max-time 3 "http://127.0.0.1:$PORT/healthz"; then
  die "dsh 控制台没在跑（127.0.0.1:$PORT），先执行 ./start.sh"
fi

# 先看机器上有没有「别人起的、但已经把这个端口转发出去」的 ngrok。
# 典型场景：dsh 自己的启动脚本或另一个终端已经把 8760 挂到固定域名了。
# 这种情况不该报错，直接复用——免费版一个域名只能一个端点，
# 我们起第二个必然撞 ERR_NGROK_334，而用户要的结果（能访问）其实已经有了。
find_existing_tunnel() {
  local dport addr pub
  for dport in 4040 4041; do
    curl -s --max-time 2 "http://127.0.0.1:$dport/api/tunnels" 2>/dev/null \
      | python3 -c "
import json,sys
port='$PORT'
try: d=json.load(sys.stdin)
except Exception: sys.exit(0)
for t in d.get('tunnels',[]):
    addr=(t.get('config') or {}).get('addr') or ''
    pub=t.get('public_url') or ''
    if pub.startswith('https://') and addr.rstrip('/').endswith(':'+port):
        print(pub); break
" 2>/dev/null && return 0
  done
  return 1
}

if EXISTING=$(find_existing_tunnel) && [[ -n "$EXISTING" ]]; then
  echo "$EXISTING" > "$URL_FILE"
  echo "[ngrok] 检测到已有隧道在转发本端口，直接复用："
  echo ""
  echo "  ┌─────────────────────────────────────────────────────────"
  echo "  │ 公网地址: $EXISTING"
  echo "  │ 已写入 .tunnel-url"
  echo "  │ 访问口令: $(cat .passphrase 2>/dev/null || echo '(见 .passphrase)')"
  echo "  └─────────────────────────────────────────────────────────"
  echo ""
  echo "  这个隧道不是本脚本起的，所以 ./tunnel-ngrok.sh stop 不会停它。"
  echo "  要停它得找到对应进程；不想共用就把那个停掉再跑本脚本接管。"
  echo "  校验连通性: ./tunnel-ngrok.sh check"
  exit 0
fi

# 已经有自己起的实例在跑，就别重复起（免费版只有 3 个端点额度）
if pid=$(running_pid); then
  echo "[ngrok] 本脚本的隧道已在运行 (PID $pid): $(cat $URL_FILE 2>/dev/null)"
  echo "[ngrok] 要重启先执行 ./tunnel-ngrok.sh stop"
  exit 0
fi

: > "$LOG"

# dashboard 端口通过叠加一份临时配置来设（ngrok 3.x 无 --web-addr 参数）。
# 用 --config 把用户自己的配置一起带上，否则 authtoken 会丢。
USER_CONF=""
for cand in "$HOME/Library/Application Support/ngrok/ngrok.yml" \
            "$HOME/.config/ngrok/ngrok.yml" \
            "$HOME/.ngrok2/ngrok.yml"; do
  [[ -f "$cand" ]] && { USER_CONF="$cand"; break; }
done

printf 'version: "3"\nagent:\n  web_addr: 127.0.0.1:%s\n' "$DASH_PORT" > "$DASH_CONF"

NGROK_ARGS=(http "$PORT" --log=stdout --log-format=logfmt)
# 同一 dev domain 上如果有多个端点，必须全部带 --pooling-enabled 才能共存
[[ "${DSH_NGROK_POOLING:-0}" == "1" ]] && NGROK_ARGS+=(--pooling-enabled)
[[ -n "$USER_CONF" ]] && NGROK_ARGS+=(--config "$USER_CONF")
NGROK_ARGS+=(--config "$DASH_CONF")

# 不传 --url 时 ngrok 自动把端点挂到账号的 dev domain 上（免费版的行为），
# 所以这里不需要知道域名——启动后从本地 API 读回来即可。
ngrok "${NGROK_ARGS[@]}" > "$LOG" 2>&1 &
NGROK_PID=$!
echo "$NGROK_PID" > "$PID_FILE"

echo "[ngrok] 启动中（约 3-6 秒）…"
URL=""
for i in {1..25}; do
  sleep 1
  kill -0 "$NGROK_PID" 2>/dev/null || break   # 进程已退出，别再傻等
  # 优先问本地 agent API，比 grep 日志稳（日志格式随版本变）
  URL=$(curl -s --max-time 2 "http://127.0.0.1:$DASH_PORT/api/tunnels" 2>/dev/null \
        | grep -oE 'https://[a-z0-9.-]+\.ngrok[a-z.-]*' | head -1)
  [[ -n "$URL" ]] && break
  # 兜底：从日志里捞
  URL=$(grep -oE 'https://[a-z0-9.-]+\.ngrok[a-z.-]*' "$LOG" 2>/dev/null | head -1)
  [[ -n "$URL" ]] && break
done

if [[ -z "$URL" ]]; then
  echo "[ngrok] 未拿到地址，日志如下："
  tail -15 "$LOG"
  stop_own >/dev/null

  # ERR_NGROK_334 是免费版最常见的坑：一个账号只有一个 dev domain，
  # 同域名只能有一个在线端点。常见于「机器上已经有一个 ngrok 在服务别的项目」。
  if grep -q "ERR_NGROK_334" "$LOG" 2>/dev/null; then
    cat <<'EOF'

诊断：你的 dev domain 已经有另一个在线端点在用（ERR_NGROK_334）。

免费版一个账号只有一个固定域名，同一域名同时只能挂一个端点。所以要么：

  1. 找出那个已有的 ngrok 并停掉它（先看清是哪个，别误杀别人的项目）
     lsof -nP -iTCP -sTCP:LISTEN | grep ngrok     # 或：ps aux | grep "[n]grok http"

  2. 或者让它和本脚本负载均衡（两个端点共享同一域名）
     先把已有那个停掉，然后重新执行本脚本加 pooling：
     DSH_NGROK_POOLING=1 ./tunnel-ngrok.sh

  3. 或者干脆只保留一个：用本脚本接管，别的地方不再起 ngrok

EOF
    exit 1
  fi

  cat <<'EOF'

常见原因：
  · authtoken 无效 → 重新执行 ngrok config add-authtoken <token>
  · 免费额度用完 → https://dashboard.ngrok.com/usage 看用量
  · 已有 3 个在线端点（免费版上限）→ 先停掉别的 ngrok 进程

EOF
  exit 1
fi

echo "$URL" > "$URL_FILE"

echo ""
echo "  ┌─────────────────────────────────────────────────────────"
echo "  │ 公网地址: $URL"
echo "  │ 已写入 .tunnel-url（手机端填这个，以后不用再改）"
echo "  │ 访问口令: $(cat .passphrase 2>/dev/null || echo '(见 .passphrase)')"
echo "  └─────────────────────────────────────────────────────────"
echo ""
echo "  ⚠️ 免费版会在浏览器首次访问时插一个 ngrok 提示页，点一次 Visit 后"
echo "     7 天内不再出现。APP 端已自动带跳过头，通常看不到这个页面。"
echo ""
echo "  停止: ./tunnel-ngrok.sh stop"
echo "  校验: ./tunnel-ngrok.sh check"
echo "  域名永久不变，手机端只需填这一次。"
