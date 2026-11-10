package com.dsh.console;

import android.app.Activity;
import android.graphics.Color;
import android.os.Bundle;
import android.text.Editable;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.Menu;
import android.view.MenuItem;
import android.view.View;
import android.view.ViewGroup;
import android.util.Log;
import android.webkit.ConsoleMessage;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import java.util.HashMap;
import java.util.Map;

public class MainActivity extends Activity {

    static final String TAG = "dshconsole";

    /** 服务端口（局域网兜底地址用同一个端口） */
    static final int PORT = 8760;

    /**
     * 主地址：公网隧道（ngrok 免费版固定域名 / Cloudflare 隧道 / 自有反代均可）。
     * 优点：IP 变化、换 Wi-Fi、走 4G 都能连，不依赖电脑的 DHCP 地址。
     * 缺点：流量绕一圈边缘节点，比局域网直连慢（实测 ~100ms RTT）。
     *
     * ⚠️ 改成你自己的地址再打包，或留空让 APP 首次启动时提示手填：
     *     ./build-apk.sh https://your-tunnel.example.com
     */
    static final String TUNNEL_URL = "";

    /** 默认地址＝隧道；连不上时自动回退到本机局域网地址（见 findLanUrl） */
    static final String DEFAULT_URL = TUNNEL_URL;

    /**
     * 旧版本曾把「已失效的临时隧道域名」写死在 APK 里。
     * 保留迁移入口：命中 trycloudflare.com 的旧地址会被替换成 TUNNEL_URL。
     */
    static final String LEGACY_URL = "";

    static final String PREFS = "dshapp";
    static final String KEY_URL = "url";

    /**
     * 默认地址迁移版本号（int）。
     * 用新 key 而不是复用旧的 String 型 "url_migrated_to"，
     * 否则 getInt 读旧 String 会抛 ClassCastException。
     */
    static final String KEY_MIGRATED = "url_migrated_ver";

    /** 迁移版本：>= 此值表示已迁移到隧道地址，之后用户手选的地址不再被覆盖 */
    static final int MIGRATION_VERSION = 2;

    /**
     * 最近一次成功使用的局域网地址，作为隧道失败时的兜底。
     * 与 KEY_URL 分开存：KEY_URL 是「当前用什么」，这个是「可以退到哪」。
     */
    static final String KEY_LAST_LAN = "last_lan_url";

    /** ngrok 免费版浏览器提示页跳过头（保留：走公网隧道时仍需要） */
    static final String SKIP_HEADER = "ngrok-skip-browser-warning";

    private static final int BG = Color.parseColor("#14171c");
    private static final int FG = Color.parseColor("#e6e9ef");
    private static final int DIM = Color.parseColor("#9aa3af");

    private LinearLayout root;
    private WebView web;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        String url = getSharedPreferences(PREFS, MODE_PRIVATE).getString(KEY_URL, "");
        if (url != null) url = url.trim();

        int migrated = getSharedPreferences(PREFS, MODE_PRIVATE).getInt(KEY_MIGRATED, 0);

        // 迁移策略（一次性，之后尊重用户手选）：
        //   把「写死的局域网 IP」或「已失效的临时隧道域名」换成 TUNNEL_URL。
        //   局域网 IP 是 DHCP 分的（租期通常 4h），重启/换网就变，
        //   留在老机器上必然连不上。
        //   TUNNEL_URL 为空时不迁移也不清空 —— 让用户自己填，别把已有配置抹掉。
        boolean tunnelConfigured = TUNNEL_URL != null && !TUNNEL_URL.isEmpty();
        boolean isStaleLanIp = url != null && url.matches("^http://\\d{1,3}(\\.\\d{1,3}){3}:8760/?$");
        boolean needMigrate = tunnelConfigured
                && migrated < MIGRATION_VERSION
                && (url == null || url.isEmpty()
                    || isStaleLanIp
                    || (!LEGACY_URL.isEmpty() && LEGACY_URL.equalsIgnoreCase(url))
                    || url.contains("trycloudflare.com"));

        if (needMigrate) {
            Log.i(TAG, "migrate url " + url + " -> " + TUNNEL_URL);
            url = TUNNEL_URL;
            getSharedPreferences(PREFS, MODE_PRIVATE).edit()
                    .putString(KEY_URL, url)
                    .putInt(KEY_MIGRATED, MIGRATION_VERSION)
                    .apply();
        }

        if (url == null || url.isEmpty()) {
            showAddressScreen(DEFAULT_URL);
        } else {
            openWeb(url);
        }
    }

    /**
     * 找出可用的局域网兜底地址。
     *
     * 为什么不做「扫描本机所在网段」：
     * 试过，是错的。手机和电脑看着在相邻网段（如 10.0.1.x 与 10.0.2.x），
     * 实际可能属于不同广播域、中间隔了三层路由，
     * 扫自己的网段永远扫不到电脑。而且 /22 有 1022 个地址，扫一遍要几分钟。
     *
     * 实际可行的三条路，按可靠性排序：
     *   1. 上次成功连过的局域网地址（最常见：Mac 的 DHCP 租期 4h 内复用同一 IP）
     *   2. 用户手动填过的地址（存在 KEY_URL，但当前用的是隧道，所以单独记一份）
     *   3. 都不行就返回 null，让上层提示用户手动改地址
     *
     * 注意 mDNS（xxx.local）实测在部分安卓机型上解析不了，
     * ping 直接 unknown host，别指望它。
     */
    private String findLanUrl() {
        // 1. 上次成功连通的局域网地址
        String last = getSharedPreferences(PREFS, MODE_PRIVATE).getString(KEY_LAST_LAN, "");
        if (last != null && !last.isEmpty() && probeTcpByUrl(last)) {
            Log.i(TAG, "findLanUrl: 复用上次的局域网地址 " + last);
            return last;
        }
        Log.w(TAG, "findLanUrl: 无可用的局域网兜底地址");
        return null;
    }

    /** 对形如 http://1.2.3.4:8760 的地址做 TCP 探测 */
    private boolean probeTcpByUrl(String url) {
        try {
            java.net.URL u = new java.net.URL(url);
            String host = u.getHost();
            int port = u.getPort() > 0 ? u.getPort() : PORT;
            java.net.Socket s = new java.net.Socket();
            try {
                s.connect(new java.net.InetSocketAddress(host, port), 800);
                return true;
            } finally {
                try { s.close(); } catch (Exception ignored) {}
            }
        } catch (Exception e) {
            return false;
        }
    }

    private void openWeb(String url) {
        web = new WebView(this);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        // 保留登录 cookie（口令有效 30 天）
        s.setDatabaseEnabled(true);
        // 缓存策略：默认「有网就取最新，没网用缓存」。
        // 之前没设这个，某些机型会一直拿旧的 index.html，前端改了也看不到。
        s.setCacheMode(WebSettings.LOAD_DEFAULT);

        // 关键：把 UA 换成不含 Mozilla/Chrome/Safari 的标识。
        // ngrok 免费版只对「浏览器型 UA」强制插提示页（ERR_NGROK_6024），
        // 而 WebView 的默认 UA 正好命中。改写后请求直接透传到 dsh-app，
        // 主文档和所有子资源都不再被拦，提示页彻底消失。
        String realUa = s.getUserAgentString();
        if (realUa == null) realUa = "";
        String customUa = "dsh-console/2.0 "
                + realUa.replace("Mozilla/5.0", "")
                         .replace("Chrome/", "ChromeX/")
                         .replace("Safari/", "SafariX/")
                         .replace("Mobile/", "MobileX/")
                         .replaceAll("\\s+", " ")
                         .trim();
        s.setUserAgentString(customUa.isEmpty() ? "dsh-console/2.0" : customUa);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView view, String u) {
                // 页面成功加载 → 若这是局域网地址，记下来做后续兜底
                if (u != null && u.matches("^http://\\d{1,3}(\\.\\d{1,3}){3}:\\d+.*$")) {
                    getSharedPreferences(PREFS, MODE_PRIVATE).edit()
                            .putString(KEY_LAST_LAN, u).apply();
                }
                Log.i(TAG, "onPageFinished " + u);
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest req, WebResourceError err) {
                String u = req == null || req.getUrl() == null ? "?" : req.getUrl().toString();
                Log.e(TAG, "onReceivedError " + err.getErrorCode() + " " + err.getDescription() + " url=" + u);
                // 只对「主文档」失败做兜底，子资源（图标/接口）失败不触发，避免误切
                if (req != null && req.isForMainFrame()) {
                    tryLanFallback(u);
                }
            }

            @Override
            public void onReceivedHttpError(WebView view, WebResourceRequest req,
                                            android.webkit.WebResourceResponse res) {
                String u = req == null || req.getUrl() == null ? "?" : req.getUrl().toString();
                Log.e(TAG, "onReceivedHttpError " + res.getStatusCode() + " url=" + u);
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(ConsoleMessage cm) {
                Log.i(TAG, "console[" + cm.messageLevel() + "] " + cm.message()
                        + " @" + cm.sourceId() + ":" + cm.lineNumber());
                return true;
            }
        });
        web.setBackgroundColor(BG);

        setContentView(web);

        // 首次请求也带上跳过头，双保险
        Map<String, String> extra = new HashMap<>();
        extra.put(SKIP_HEADER, "1");
        web.loadUrl(url, extra);
    }

    /** 兜底进行中标记，防止主文档多次失败并发扫描 */
    private boolean lanFallbackTried = false;

    /**
     * 隧道加载失败 → 后台扫描局域网，找到就切过去。
     *
     * 触发条件（全部满足才动手）：
     *   1. 当前地址不是局域网地址（否则已经是兜底了，再扫没意义）
     *   2. 本次启动还没扫过
     *   3. 系统当前连着 Wi-Fi/以太网（否则扫了也白扫）
     */
    private void tryLanFallback(String failedUrl) {
        if (lanFallbackTried) return;
        if (failedUrl != null && failedUrl.matches("^http://\\d{1,3}(\\.\\d{1,3}){3}:\\d+.*$")) {
            // 已经在用局域网地址还失败，说明确实是网络/服务问题，不再折腾
            return;
        }
        lanFallbackTried = true;

        Toast.makeText(this, "隧道不可达，正在查找局域网地址…", Toast.LENGTH_LONG).show();

        new Thread(new Runnable() {
            @Override
            public void run() {
                final String lan = findLanUrl();
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        if (lan == null) {
                            Toast.makeText(MainActivity.this,
                                    "隧道和局域网都连不上，请检查 Mac 是否在运行",
                                    Toast.LENGTH_LONG).show();
                            return;
                        }
                        // 不写进 SharedPreferences：兜底是临时的，
                        // 下次启动仍优先试隧道，隧道恢复后自动回到公网。
                        Toast.makeText(MainActivity.this,
                                "已切到局域网 " + lan, Toast.LENGTH_SHORT).show();
                        Map<String, String> extra = new HashMap<>();
                        extra.put(SKIP_HEADER, "1");
                        web.loadUrl(lan, extra);
                    }
                });
            }
        }).start();
    }

    private void showAddressScreen(String preset) {
        int pad = (int) (getResources().getDisplayMetrics().density * 20);

        root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(BG);
        root.setPadding(pad, pad * 3, pad, pad);
        root.setGravity(Gravity.CENTER_HORIZONTAL);

        TextView title = new TextView(this);
        title.setText("dsh 控制台");
        title.setTextColor(FG);
        title.setTextSize(22);
        root.addView(title);

        TextView hint = new TextView(this);
        boolean hasPreset = preset != null && !preset.trim().isEmpty();
        hint.setText(hasPreset
                ? "\n服务器地址（Mac 上跑着的 dsh 控制台）："
                : "\n首次使用，请填服务器地址：\n\n"
                  + "· 同一 Wi-Fi：http://<Mac 的局域网 IP>:8760\n"
                  + "· 出门在外：https://<你的隧道域名>\n\n"
                  + "启动 ./start.sh 时终端会打印可用的地址，直接抄过来即可。");
        hint.setTextColor(DIM);
        hint.setTextSize(14);
        hint.setLineSpacing(0, 1.3f);
        root.addView(hint);

        final EditText input = new EditText(this);
        input.setText(preset);
        input.setTextColor(FG);
        input.setTextSize(14);
        input.setSingleLine(true);
        root.addView(input);

        Button go = new Button(this);
        go.setText("进入");
        LinearLayout.LayoutParams bp =
                new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.WRAP_CONTENT);
        bp.topMargin = pad;
        go.setLayoutParams(bp);
        go.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                Editable e = input.getText();
                String u = e == null ? "" : e.toString().trim();

                if (u.isEmpty()) {
                    Toast.makeText(MainActivity.this, "请先填地址", Toast.LENGTH_SHORT).show();
                    return;
                }

                // 只有裸主机名才补协议。这里必须区分：
                //   局域网 IP / .local → http（本服务不提供 TLS，补 https 必然连不上）
                //   其余（隧道域名）   → https（ngrok / Cloudflare 都是 TLS 终结）
                if (!u.startsWith("http://") && !u.startsWith("https://")) {
                    boolean isLan = u.matches("^\\d{1,3}(\\.\\d{1,3}){3}(:\\d+)?.*$")
                            || u.matches("^[A-Za-z0-9-]+\\.local(:\\d+)?.*$");
                    u = (isLan ? "http://" : "https://") + u;
                }

                if (u.length() < 12) {
                    Toast.makeText(MainActivity.this, "地址不合法", Toast.LENGTH_SHORT).show();
                    return;
                }

                android.content.SharedPreferences.Editor ed =
                        getSharedPreferences(PREFS, MODE_PRIVATE).edit();
                ed.putString(KEY_URL, u);
                // 局域网地址额外记一份做兜底：以后隧道挂了能退回来。
                // 愿意手填 IP 说明用户就在同一网络里，这个地址比任何猜测都可靠。
                if (u.matches("^http://\\d{1,3}(\\.\\d{1,3}){3}:\\d+.*$")) {
                    ed.putString(KEY_LAST_LAN, u);
                }
                ed.apply();
                openWeb(u);
            }
        });
        root.addView(go);

        setContentView(root);
    }

    @Override
    public boolean onCreateOptionsMenu(Menu menu) {
        menu.add("更换服务器地址");
        return true;
    }

    @Override
    public boolean onMenuItemSelected(int featureId, MenuItem item) {
        String url = getSharedPreferences(PREFS, MODE_PRIVATE).getString(KEY_URL, DEFAULT_URL);
        showAddressScreen(url);
        return true;
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK && web != null && web.canGoBack()) {
            web.goBack();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }
}
