#!/bin/zsh
# =============================================================================
# dsh-app 命名隧道一键配置
# -----------------------------------------------------------------------------
# 前提（必须先在浏览器里做完，脚本无法代替）：
#   1. 有一个域名，且 NS 已改到 Cloudflare（CF 后台站点状态 = Active）
#   2. cloudflared 已安装（brew install cloudflared）
#
# 用法：
#   ./tunnel-setup.sh dsh.example.com      首次配置
#   ./tunnel-setup.sh --status             查看当前状态
#   ./tunnel-setup.sh --rollback           回退到快速隧道（删除命名隧道配置）
#
# 脚本做的事：
#   cloudflared tunnel login      → 浏览器授权，落 cert.pem
#   cloudflared tunnel create     → 建命名隧道，落 <UUID>.json 凭证
#   ~/.cloudflared/config.yml     → 写 ingress（指向 127.0.0.1:8760）
#   cloudflared tunnel route dns  → 建 CNAME 记录
#   重启 com.dsh.console（或你设的 DSH_APP_LABEL） → 生效
#
# ⚠️ 免口令还需要一步在 CF 后台做（脚本会打印出来，无法用 CLI 自动化因为
#    需要 API Token；手工点三下即可）：Request Header Transform Rule 注入
#    X-DSH-Edge = <本机 .edge-secret 的内容>
# =============================================================================
set -uo pipefail

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
CF_DIR="$HOME/.cloudflared"
CF_CONFIG="$CF_DIR/config.yml"
SECRET_FILE="$APP_DIR/.edge-secret"
APP_PORT=8760

c_ok()   { printf "\033[32m%s\033[0m\n" "$*"; }
c_warn() { printf "\033[33m%s\033[0m\n" "$*"; }
c_err()  { printf "\033[31m%s\033[0m\n" "$*"; }
c_dim()  { printf "\033[2m%s\033[0m\n" "$*"; }

# ---------- --status ----------
if [[ "${1:-}" == "--status" ]]; then
  echo "=== 命名隧道状态 ==="
  if [[ -f "$CF_CONFIG" ]]; then
    c_ok "config.yml 存在: $CF_CONFIG"
    grep -E 'hostname|service|tunnel:' "$CF_CONFIG" | sed 's/^/  /'
  else
    c_warn "config.yml 不存在（当前走快速隧道，地址会变）"
  fi
  echo
  echo "=== 凭证 ==="
  # zsh 下无匹配的 glob 会直接报错退出（nomatch），必须用 setopt 临时关闭或用 find
  if [[ -n "$(find "$CF_DIR" -maxdepth 1 -name '*.json' -print -quit 2>/dev/null)" ]]; then
    find "$CF_DIR" -maxdepth 1 -name '*.json' -exec basename {} \; | sed 's/^/  /'
  else
    c_warn "  无凭证 json"
  fi
  echo
  echo "=== 边缘密钥 ==="
  if [[ -f "$SECRET_FILE" ]]; then
    c_ok "  .edge-secret 已存在（免口令已启用）"
  else
    c_warn "  .edge-secret 不存在（仍需口令）"
  fi
  echo
  echo "=== 进程 ==="
  pgrep -fl "cloudflared tunnel" | sed 's/^/  /' || echo "  无 cloudflared 进程"
  echo
  echo "=== 本地服务 ==="
  curl -s -o /dev/null -w "  127.0.0.1:$APP_PORT/healthz → %{http_code}\n" --max-time 3 \
    "http://127.0.0.1:$APP_PORT/healthz" 2>/dev/null || echo "  不可达"
  exit 0
fi

# ---------- --rollback ----------
if [[ "${1:-}" == "--rollback" ]]; then
  c_warn "回退到快速隧道…"
  [[ -f "$CF_CONFIG" ]] && mv "$CF_CONFIG" "$CF_CONFIG.bak-$(date +%Y%m%d-%H%M%S)" && c_ok "已移走 config.yml"
  launchctl kickstart -k "gui/$(id -u)/${DSH_APP_LABEL:-com.dsh.console}" 2>/dev/null \
    && c_ok "服务已重启（回到快速隧道，地址会变）" \
    || c_warn "重启失败，手工执行: launchctl kickstart -k gui/$(id -u)/${DSH_APP_LABEL:-com.dsh.console}"
  exit 0
fi

# ---------- 参数校验 ----------
HOSTNAME_ARG="${1:-}"
if [[ -z "$HOSTNAME_ARG" ]]; then
  echo "用法: $0 <你的域名>       例: $0 dsh.mydomain.com"
  echo "      $0 --status"
  echo "      $0 --rollback"
  exit 1
fi
if [[ "$HOSTNAME_ARG" != *.* ]]; then
  c_err "域名格式不对: $HOSTNAME_ARG"
  exit 1
fi

command -v cloudflared >/dev/null 2>&1 || { c_err "未安装 cloudflared: brew install cloudflared"; exit 1; }
command -v node >/dev/null 2>&1 || { c_err "未找到 node"; exit 1; }
[[ -f "$APP_DIR/server.js" ]] || { c_err "找不到 $APP_DIR/server.js"; exit 1; }

mkdir -p "$CF_DIR"

# ---------- 1. 边缘密钥 ----------
if [[ -f "$SECRET_FILE" ]]; then
  c_dim "复用已有 .edge-secret"
else
  # 32 字节随机 → 64 位 hex，足够抗猜
  node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))' > "$SECRET_FILE"
  chmod 600 "$SECRET_FILE"
  c_ok "已生成边缘密钥: $SECRET_FILE"
fi
EDGE_SECRET="$(cat "$SECRET_FILE")"

# ---------- 2. cloudflared 登录 ----------
if [[ -f "$CF_DIR/cert.pem" ]]; then
  c_dim "已有 cert.pem，跳过登录"
else
  c_warn "即将打开浏览器授权，请选择你要用的域名（$HOSTNAME_ARG 所在的那个）"
  cloudflared tunnel login || { c_err "登录失败"; exit 1; }
fi

# ---------- 3. 建命名隧道 ----------
TUNNEL_NAME="dsh-app"
TUNNEL_ID=""
# 已存在同名隧道则复用，避免重复创建
if list_out="$(cloudflared tunnel list --output json 2>/dev/null)"; then
  TUNNEL_ID="$(printf '%s' "$list_out" | node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
      try{const a=JSON.parse(s);const t=a.find(x=>x.name==="dsh-app");if(t)process.stdout.write(t.id)}catch{}
    });' 2>/dev/null)"
fi

if [[ -n "$TUNNEL_ID" ]]; then
  c_dim "复用已有隧道 $TUNNEL_NAME ($TUNNEL_ID)"
else
  create_out="$(cloudflared tunnel create "$TUNNEL_NAME" 2>&1)"
  echo "$create_out" | sed 's/^/  /'
  TUNNEL_ID="$(printf '%s' "$create_out" | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1)"
  [[ -n "$TUNNEL_ID" ]] || { c_err "创建隧道失败，未解析到 UUID"; exit 1; }
  c_ok "已创建隧道 $TUNNEL_NAME ($TUNNEL_ID)"
fi

CRED_FILE="$CF_DIR/$TUNNEL_ID.json"
[[ -f "$CRED_FILE" ]] || { c_err "找不到凭证文件: $CRED_FILE"; exit 1; }

# ---------- 4. 写 config.yml ----------
if [[ -f "$CF_CONFIG" ]]; then
  cp "$CF_CONFIG" "$CF_CONFIG.bak-$(date +%Y%m%d-%H%M%S)"
  c_dim "已备份旧 config.yml"
fi
cat > "$CF_CONFIG" <<YAML
# 由 tunnel-setup.sh 生成于 $(date '+%F %T')
# 命名隧道：地址永久固定，不再随机变化
tunnel: $TUNNEL_ID
credentials-file: $CRED_FILE

ingress:
  - hostname: $HOSTNAME_ARG
    service: http://127.0.0.1:$APP_PORT
  - service: http_status:404
YAML
chmod 600 "$CF_CONFIG"
c_ok "已写入 $CF_CONFIG"

# ---------- 5. DNS 路由 ----------
route_out="$(cloudflared tunnel route dns "$TUNNEL_ID" "$HOSTNAME_ARG" 2>&1)"
if echo "$route_out" | grep -qiE "already exists|已经存在"; then
  c_dim "DNS 记录已存在，跳过"
else
  echo "$route_out" | sed 's/^/  /'
fi

# ---------- 6. 重启服务 ----------
c_warn "重启 dsh-app 使命名隧道生效…"
launchctl kickstart -k "gui/$(id -u)/${DSH_APP_LABEL:-com.dsh.console}" 2>/dev/null \
  && c_ok "已重启" \
  || c_warn "自动重启失败，请手工执行: launchctl kickstart -k gui/$(id -u)/${DSH_APP_LABEL:-com.dsh.console}"

# ---------- 7. 等就绪 ----------
echo
c_warn "等待隧道就绪（最多 60s）…"
OK=""
for i in $(seq 1 60); do
  CODE=$(curl -s -o /dev/null -w '%{http_code}' --noproxy '*' --max-time 8 "https://$HOSTNAME_ARG/healthz" 2>/dev/null)
  if [[ -n "$CODE" && "$CODE" != "000" && "$CODE" != "530" && "$CODE" != "502" ]]; then
    OK=1; break
  fi
  sleep 1
done

echo
echo "════════════════════════════════════════════════════════════"
if [[ -n "$OK" ]]; then
  c_ok "隧道已通: https://$HOSTNAME_ARG"
else
  c_warn "60s 内未验活。可能 DNS 还在传播，稍后重试；排查："
  echo "  ./tunnel-setup.sh --status"
  echo "  tail -50 ~/.dsh/logs/dsh-app.err.log"
fi
echo "════════════════════════════════════════════════════════════"
echo
c_warn "【还差最后一步：去 Cloudflare 后台开免口令】"
c_dim "  路径: 你的域名 → Rules → Transform Rules → Modify Request Header → Create rule"
c_dim "  规则名: dsh-edge"
c_dim "  匹配:  Custom filter expression → http.host eq \"$HOSTNAME_ARG\""
c_dim "  操作:  Set static →  Header name: X-DSH-Edge"
echo
c_dim "  Header value（整行复制，这是一次性密钥，别外传）:"
echo
printf '\033[36m%s\033[0m\n' "$EDGE_SECRET"
echo
c_dim "  保存后立刻生效，无需重启。验证：手机浏览器直接打开上面地址，应进入界面而不要口令。"
echo
