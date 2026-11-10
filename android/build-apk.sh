#!/bin/bash
# =============================================================================
# dsh 控制台 APK 构建脚本
# -----------------------------------------------------------------------------
# 用途：打包安卓 WebView 壳（com.dsh.console）
# 输出：<仓库根>/public/dsh-console.apk
#
# 前置条件：
#   · Android SDK（build-tools 34.0.0 + platforms/android-34）
#   · JDK 17（javac）与 JDK 21（d8）
#   · 一个签名 keystore —— 仓库自带 demo.keystore（口令公开，见 README），
#     想正式发布就自己生成一个：
#       keytool -genkeypair -v -keystore my.keystore -alias dshconsole \
#               -keyalg RSA -keysize 2048 -validity 10000
#
# 用法：
#   ./build-apk.sh                                 # 用演示签名 + 源码里已填的 TUNNEL_URL
#   ./build-apk.sh https://my-tunnel.example.com    # 指定地址并写回源码
#
# 签名参数走环境变量，不写死在脚本里：
#   KS_PATH=~/my.keystore KS_PASS=xxx KS_ALIAS=dshconsole ./build-apk.sh
#
# 换地址时签名保持不变即可覆盖安装；换了 keystore 则必须先卸载旧 APP。
# =============================================================================
set -euo pipefail

SDK="${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}"
BT="$SDK/build-tools/34.0.0"
ANDROID_JAR="$SDK/platforms/android-34/android.jar"

# JDK 探测：允许用 JAVA_HOME_21 / JAVA_HOME_17 覆盖
JDK21="${JAVA_HOME_21:-}"
JDK17="${JAVA_HOME_17:-}"
if [ -z "$JDK21" ]; then
  for c in "$HOME/Library/Java/JavaVirtualMachines"/*21*/Contents/Home \
           /opt/homebrew/opt/openjdk@21 /usr/local/opt/openjdk@21; do
    [ -x "$c/bin/java" ] && { JDK21="$c"; break; }
  done
fi
if [ -z "$JDK17" ]; then
  for c in "$HOME/Library/Java/JavaVirtualMachines"/*17*/Contents/Home \
           /opt/homebrew/opt/openjdk@17 /usr/local/opt/openjdk@17; do
    [ -x "$c/bin/javac" ] && { JDK17="$c"; break; }
  done
fi

SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SRC_DIR/.." && pwd)"
BUILD="$SRC_DIR/.build"
JAVA_SRC="$SRC_DIR/src/com/dsh/console/MainActivity.java"

# 签名配置：全部可用环境变量覆盖。
#
# 默认用仓库里带的 demo.keystore（演示签名，口令公开在 README 里）。
# 想用你自己的密钥就设 KS_PATH —— 相对路径会按「当前目录 → 仓库根」两处找，
# 因为下面会 cd 来 cd 去，不先定成绝对路径的话 ./xxx.keystore 会在中途失配。
if [ -n "${KS_PATH:-}" ]; then
  case "$KS_PATH" in
    /*) KS="$KS_PATH" ;;                                  # 已经是绝对路径
    *)  if [ -e "$PWD/$KS_PATH" ]; then                   # 相对当前调用目录
          KS="$PWD/$KS_PATH"
        else
          KS="$REPO_DIR/$KS_PATH"                         # 相对仓库根
        fi ;;
  esac
else
  # 没指定就挑一个存在的：先看私有密钥，再退回演示密钥
  if [ -e "$REPO_DIR/dshapp.keystore" ]; then
    KS="$REPO_DIR/dshapp.keystore"
  else
    KS="$REPO_DIR/demo.keystore"
  fi
fi

# 演示密钥的口令是公开的（README「装成 APP」一节），没设 KS_PASS 时自动用它，
# 免得新人只是想把 APP 跑起来却被一个口令卡住。
if [ -z "${KS_PASS:-}" ] && [ "$(basename "$KS")" = "demo.keystore" ]; then
  KS_PASS="dshconsole-demo"
  echo "    · 使用演示签名 demo.keystore（口令内置），正式发布请自建密钥"
fi
KS_PASS="${KS_PASS:-}"
KS_ALIAS="${KS_ALIAS:-dshconsole}"

NEW_URL="${1:-}"

echo "==> 环境检查"
for f in "$BT/aapt2" "$BT/zipalign" "$BT/apksigner" "$ANDROID_JAR"; do
  [ -e "$f" ] || { echo "✗ 缺少: $f"; echo "  装了 Android SDK 但路径不同？设 ANDROID_SDK_ROOT=/你的/sdk"; exit 1; }
done
[ -e "$KS" ] || {
  echo "✗ 找不到签名密钥: $KS"
  echo "  用仓库自带的演示密钥:  ./build-apk.sh            （无需额外参数）"
  echo "  用自己的密钥:          KS_PATH=~/my.keystore KS_PASS=口令 ./build-apk.sh"
  echo "  还没生成?             keytool -genkeypair -v -keystore my.keystore \\"
  echo "                          -alias dshconsole -keyalg RSA -keysize 2048 -validity 10000"
  exit 1
}
[ -n "$JDK21" ] && [ -x "$JDK21/bin/java" ] || { echo "✗ 未找到 JDK21（设 JAVA_HOME_21 指过去）"; exit 1; }
[ -n "$JDK17" ] && [ -x "$JDK17/bin/javac" ] || { echo "✗ 未找到 JDK17（设 JAVA_HOME_17 指过去）"; exit 1; }
[ -n "$KS_PASS" ] || { echo "✗ 未设置 KS_PASS（你用的 $KS 需要口令）"; exit 1; }
echo "    ✓ 工具链齐全（密钥: $(basename "$KS")）"

# 可选：替换默认域名
# 注意：地址常量名是 TUNNEL_URL（DEFAULT_URL = TUNNEL_URL），
# 这里必须替换 TUNNEL_URL，否则正则匹配不到会静默不生效。
if [ -n "$NEW_URL" ]; then
  echo "==> 更新隧道域名为 $NEW_URL"
  python3 - "$JAVA_SRC" "$NEW_URL" <<'PY'
import re, sys
p, url = sys.argv[1], sys.argv[2].rstrip('/')
s = open(p, encoding='utf-8').read()
s2 = re.sub(r'(static final String TUNNEL_URL = ")[^"]*(";)', r'\g<1>%s\g<2>' % url, s)
assert s2 != s, "TUNNEL_URL 替换失败（常量名可能又改了）"
open(p, 'w', encoding='utf-8').write(s2)
print("    TUNNEL_URL =", url)
PY
fi

rm -rf "$BUILD"
mkdir -p "$BUILD/classes" "$BUILD/compiled" "$BUILD/pkg"

echo "==> 编译 Java"
"$JDK17/bin/javac" -source 8 -target 8 -bootclasspath "$ANDROID_JAR" -nowarn \
  -d "$BUILD/classes" "$JAVA_SRC" 2>&1 \
  | grep -vE "^警告|warning:|^注:" || true

echo "==> 生成 dex"
"$JDK21/bin/java" -cp "$BT/lib/d8.jar" com.android.tools.r8.D8 \
  --release --min-api 24 --lib "$ANDROID_JAR" --output "$BUILD" \
  $(find "$BUILD/classes" -name "*.class")

echo "==> 编译资源"
"$BT/aapt2" compile --dir "$SRC_DIR/res" -o "$BUILD/compiled/"

echo "==> 链接 APK"
"$BT/aapt2" link -o "$BUILD/base.apk" \
  -I "$ANDROID_JAR" \
  --manifest "$SRC_DIR/AndroidManifest.xml" \
  -R "$BUILD"/compiled/*.flat \
  --min-sdk-version 24 --target-sdk-version 34 --auto-add-overlay

echo "==> 组装 dex"
# 注意：不能 unzip 后重新 zip，那样会把 resources.arsc 压成 deflate，
# Android 11+ 会拒装（"resources.arsc ... stored uncompressed and aligned"）。
# 正确做法：直接往 aapt2 产出的 base.apk 里追加 classes.dex，保留原有 entry 存储方式。
cd "$BUILD"
cp base.apk unsigned.apk
zip -q -X -0 unsigned.apk classes.dex
cd "$SRC_DIR"

echo "==> 对齐 + 签名"
"$BT/zipalign" -f -p 4 "$BUILD/unsigned.apk" "$BUILD/aligned.apk"
"$BT/apksigner" sign \
  --ks "$KS" --ks-key-alias "$KS_ALIAS" \
  --ks-pass "pass:$KS_PASS" --key-pass "pass:$KS_PASS" \
  --v1-signing-enabled true --v2-signing-enabled true \
  --out "$BUILD/dsh-console.apk" "$BUILD/aligned.apk"

echo "==> 校验"
"$BT/apksigner" verify --print-certs "$BUILD/dsh-console.apk" | grep -E "DN|SHA-256"

# 部署：把产物放到仓库 public/ 下，随 web 服务一起分发
if [ -d "$REPO_DIR/public" ]; then
  DEST="$REPO_DIR/public/dsh-console.apk"
  [ -f "$DEST" ] && cp "$DEST" "$DEST.bak-$(date +%Y%m%d-%H%M%S)"
  cp "$BUILD/dsh-console.apk" "$DEST"
  echo "==> 已部署到 $DEST"
fi

echo ""
echo "✅ 完成: $BUILD/dsh-console.apk"
"$BT/aapt2" dump badging "$BUILD/dsh-console.apk" 2>/dev/null | head -1
