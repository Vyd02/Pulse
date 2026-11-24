package com.vyd02.pulse;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.PowerManager;
import android.provider.Settings;
import android.view.HapticFeedbackConstants;
import android.view.View;
import android.view.Window;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONObject;

public class MainActivity extends Activity {
    private WebView web;

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        Window w = getWindow();
        w.setStatusBarColor(Color.parseColor("#07090F"));
        w.setNavigationBarColor(Color.parseColor("#07090F"));

        AlertService.makeChannels(this);

        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#07090F"));
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(true);
        s.setCacheMode(WebSettings.LOAD_NO_CACHE);
        web.setWebChromeClient(new WebChromeClient());
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                String u = r.getUrl().toString();
                if (isOwn(u)) return false;
                openExternal(u);
                return true;
            }

            @Override
            public boolean onRenderProcessGone(WebView v, android.webkit.RenderProcessGoneDetail d) {
                // Android killed the page (usually low memory). Rebuild it instead of crashing the app.
                runOnUiThread(() -> {
                    try { ((android.view.ViewGroup) v.getParent()).removeView(v); v.destroy(); } catch (Exception ignored) {}
                    recreate();
                });
                return true;
            }

            @Override
            public void onReceivedError(WebView v, WebResourceRequest r, WebResourceError e) {
                // Server unreachable (offline, etc.) — fall back to the copy built into the app.
                if (r.isForMainFrame() && !r.getUrl().toString().startsWith("file:")) {
                    v.loadUrl("file:///android_asset/index.html");
                }
            }
        });
        web.addJavascriptInterface(new Bridge(), "Android");
        loadApp();
        setContentView(web);

        if (Cfg.ready(this) && !Cfg.paused(this)) AlertService.start(this);
    }

    /** Screens load from your Pulse server so updates arrive without a new APK. */
    private void loadApp() {
        String server = Cfg.server(this);
        if (server.startsWith("https://")) {
            web.getSettings().setCacheMode(WebSettings.LOAD_DEFAULT);
            web.loadUrl(server + "/app/?shell=" + BuildInfo.VERSION + "&t=" + System.currentTimeMillis());
        } else {
            web.loadUrl("file:///android_asset/index.html");
        }
    }

    private boolean isOwn(String u) {
        String server = Cfg.server(this);
        return u.startsWith("file:///android_asset/") || (!server.isEmpty() && u.startsWith(server + "/app"));
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (web != null) web.evaluateJavascript("window.onResumeApp && onResumeApp()", null);
    }

    @Override
    public void onBackPressed() {
        web.evaluateJavascript("window.onBack ? onBack() : false", value -> {
            if (!"true".equals(value)) MainActivity.super.onBackPressed();
        });
    }

    private void openExternal(String url) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        } catch (Exception ignored) {}
    }

    /** What the screen (JavaScript) can ask the phone to do. */
    class Bridge {
        @JavascriptInterface
        public String getConfig() {
            SharedPreferences p = Cfg.p(MainActivity.this);
            try {
                JSONObject j = new JSONObject();
                j.put("server", Cfg.server(MainActivity.this));
                j.put("key", Cfg.key(MainActivity.this));
                j.put("watchlist", Cfg.watchlist(MainActivity.this));
                j.put("myCoinsOnly", Cfg.myCoinsOnly(MainActivity.this));
                j.put("paused", Cfg.paused(MainActivity.this));
                JSONObject n = new JSONObject();
                for (String c : Cfg.CATS) n.put(c, Cfg.notifOn(MainActivity.this, c));
                j.put("notif", n);
                return j.toString();
            } catch (Exception e) {
                return "{}";
            }
        }

        @JavascriptInterface
        public void saveConfig(String json) {
            try {
                JSONObject j = new JSONObject(json);
                SharedPreferences.Editor e = Cfg.p(MainActivity.this).edit();
                String oldServer = Cfg.server(MainActivity.this);
                if (j.has("server")) e.putString("server", j.getString("server").trim());
                if (j.has("key")) e.putString("key", j.getString("key").trim());
                if (j.has("watchlist")) e.putString("watchlist", j.getString("watchlist"));
                if (j.has("myCoinsOnly")) e.putBoolean("myCoinsOnly", j.getBoolean("myCoinsOnly"));
                if (j.has("paused")) e.putBoolean("paused", j.getBoolean("paused"));
                JSONObject n = j.optJSONObject("notif");
                if (n != null) for (String c : Cfg.CATS) if (n.has(c)) e.putBoolean("notif_" + c, n.getBoolean(c));
                if (j.has("server") && !j.getString("server").trim().equals(oldServer)) e.putLong("lastSeen", 0);
                e.commit();
                final boolean serverChanged = j.has("server") && !j.getString("server").trim().equals(oldServer);
                final boolean needsRestart = serverChanged || j.has("key") || j.has("paused");
                runOnUiThread(() -> {
                    if (serverChanged) web.postDelayed(MainActivity.this::loadApp, 1500);
                    if (!needsRestart) {
                        // Watchlist / notification choices are read fresh by the running service.
                        if (Cfg.ready(MainActivity.this) && !Cfg.paused(MainActivity.this)) AlertService.start(MainActivity.this);
                        return;
                    }
                    AlertService.stop(MainActivity.this);
                    if (Cfg.ready(MainActivity.this) && !Cfg.paused(MainActivity.this)) web.postDelayed(() -> AlertService.start(MainActivity.this), 600);
                });
            } catch (Exception ignored) {}
        }

        @JavascriptInterface
        public String status() {
            SharedPreferences p = Cfg.p(MainActivity.this);
            try {
                JSONObject j = new JSONObject();
                j.put("state", Cfg.ready(MainActivity.this) && !Cfg.paused(MainActivity.this) ? AlertService.state : "off");
                j.put("lastHb", p.getLong("lastHb", 0));
                j.put("notifAllowed", notifAllowed());
                j.put("batteryFree", batteryFree());
                return j.toString();
            } catch (Exception e) {
                return "{}";
            }
        }

        @JavascriptInterface
        public void openUrl(String url) { openExternal(url); }

        @JavascriptInterface
        public void askNotifications() {
            runOnUiThread(() -> {
                if (Build.VERSION.SDK_INT >= 33 && !notifAllowed()) {
                    requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 5);
                } else {
                    Intent i = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                            .putExtra(Settings.EXTRA_APP_PACKAGE, getPackageName());
                    startActivity(i);
                }
            });
        }

        @JavascriptInterface
        public void askBattery() {
            runOnUiThread(() -> {
                try {
                    Intent i = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + getPackageName()));
                    startActivity(i);
                } catch (Exception e) {
                    startActivity(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS));
                }
            });
        }

        @JavascriptInterface
        public void channelSettings() {
            runOnUiThread(() -> startActivity(new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                    .putExtra(Settings.EXTRA_APP_PACKAGE, getPackageName())));
        }

        @JavascriptInterface
        public void tap() {
            runOnUiThread(() -> web.performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP));
        }

        @JavascriptInterface
        public void thud() {
            runOnUiThread(() -> web.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS));
        }

        @JavascriptInterface
        public String version() { return BuildInfo.VERSION; }
    }

    private boolean notifAllowed() {
        if (Build.VERSION.SDK_INT >= 33) {
            return checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED;
        }
        return getSystemService(android.app.NotificationManager.class).areNotificationsEnabled();
    }

    private boolean batteryFree() {
        PowerManager pm = getSystemService(PowerManager.class);
        return pm.isIgnoringBatteryOptimizations(getPackageName());
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] perms, int[] res) {
        web.evaluateJavascript("window.onResumeApp && onResumeApp()", null);
    }
}
