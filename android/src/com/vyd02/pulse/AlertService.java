package com.vyd02.pulse;

import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.Uri;
import android.os.Build;
import android.os.IBinder;
import android.os.SystemClock;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;

import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;

/**
 * Keeps one live line open to the Pulse server and turns every new item into a
 * notification the moment it arrives. Runs as a foreground service so Android
 * leaves it alone.
 */
public class AlertService extends Service {
    static final int STATUS_ID = 1;
    static volatile String state = "offline";

    private volatile boolean running;
    private volatile Socket socket;
    private Thread worker;
    private ConnectivityManager.NetworkCallback netCb;
    private final SecureRandom rnd = new SecureRandom();
    private final Object sleepLock = new Object();

    static void start(Context c) {
        Intent i = new Intent(c, AlertService.class);
        if (Build.VERSION.SDK_INT >= 26) c.startForegroundService(i); else c.startService(i);
    }

    static void stop(Context c) {
        c.stopService(new Intent(c, AlertService.class));
    }

    @Override public IBinder onBind(Intent intent) { return null; }

    @Override
    public void onCreate() {
        super.onCreate();
        makeChannels(this);
        goForeground("Connecting…");
        scheduleWatchdog();
        ConnectivityManager cm = (ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE);
        netCb = new ConnectivityManager.NetworkCallback() {
            @Override public void onAvailable(Network n) { kick(); }
        };
        try { cm.registerDefaultNetworkCallback(netCb); } catch (Exception ignored) {}
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        goForeground(statusText());
        if (!Cfg.ready(this) || Cfg.paused(this)) {
            stopSelf();
            return START_NOT_STICKY;
        }
        if (worker == null || !worker.isAlive()) {
            running = true;
            worker = new Thread(this::loop, "pulse-line");
            worker.start();
        } else if (System.currentTimeMillis() - Cfg.p(this).getLong("lastHb", 0) > 180_000) {
            kick(); // watchdog: line looks stale, reconnect
        }
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        running = false;
        closeSocket();
        if (worker != null) worker.interrupt();
        try {
            ((ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE)).unregisterNetworkCallback(netCb);
        } catch (Exception ignored) {}
        setState("offline");
        super.onDestroy();
    }

    /** Drop the current line and reconnect right away. */
    private void kick() {
        closeSocket();
        synchronized (sleepLock) { sleepLock.notifyAll(); }
    }

    // ------------------------------------------------------------ main loop
    private void loop() {
        long backoff = 2000;
        while (running) {
            try {
                setState("connecting");
                catchUp();
                long opened = SystemClock.elapsedRealtime();
                readLine();
                if (SystemClock.elapsedRealtime() - opened > 60_000) backoff = 2000;
            } catch (Exception e) {
                // fall through to retry
            }
            if (!running) break;
            setState("offline");
            synchronized (sleepLock) {
                try { sleepLock.wait(backoff); } catch (InterruptedException ignored) {}
            }
            backoff = Math.min(backoff * 2, 60_000);
        }
    }

    /** Grab anything we missed while the line was down. */
    private void catchUp() throws Exception {
        long since = Cfg.p(this).getLong("lastSeen", 0);
        String base = Cfg.server(this);
        URL u = new URL(base + "/api/feed?limit=100&since=" + since);
        HttpURLConnection c = (HttpURLConnection) u.openConnection();
        c.setConnectTimeout(15_000);
        c.setReadTimeout(20_000);
        c.setRequestProperty("X-Key", Cfg.key(this));
        if (c.getResponseCode() != 200) throw new Exception("HTTP " + c.getResponseCode());
        JSONObject j = new JSONObject(readAll(c.getInputStream()));
        c.disconnect();
        JSONArray items = j.optJSONArray("items");
        if (since == 0) {
            // First time: start the clock now instead of replaying the back-catalog.
            Cfg.p(this).edit().putLong("lastSeen", j.optLong("now", System.currentTimeMillis())).apply();
            return;
        }
        if (items != null && items.length() > 0) handleItems(items, true);
    }

    // ------------------------------------------------------- the live line
    private void readLine() throws Exception {
        URL u = new URL(Cfg.server(this));
        boolean tls = !"http".equals(u.getProtocol());
        String host = u.getHost();
        int port = u.getPort() > 0 ? u.getPort() : (tls ? 443 : 80);

        Socket s;
        if (tls) {
            Socket plain = new Socket();
            plain.connect(new InetSocketAddress(host, port), 15_000);
            s = ((SSLSocketFactory) SSLSocketFactory.getDefault()).createSocket(plain, host, port, true);
            ((SSLSocket) s).startHandshake();
            javax.net.ssl.HostnameVerifier hv = javax.net.ssl.HttpsURLConnection.getDefaultHostnameVerifier();
            if (!hv.verify(host, ((SSLSocket) s).getSession())) { s.close(); throw new Exception("bad certificate"); }
        } else {
            s = new Socket();
            s.connect(new InetSocketAddress(host, port), 15_000);
        }
        socket = s;
        // Server sends a heartbeat every minute; if nothing for 2.5 min the line is dead.
        s.setSoTimeout(150_000);
        s.setKeepAlive(true);

        byte[] keyBytes = new byte[16];
        rnd.nextBytes(keyBytes);
        String wsKey = android.util.Base64.encodeToString(keyBytes, android.util.Base64.NO_WRAP);
        String req = "GET /ws HTTP/1.1\r\n"
                + "Host: " + host + (u.getPort() > 0 ? ":" + port : "") + "\r\n"
                + "Upgrade: websocket\r\nConnection: Upgrade\r\n"
                + "Sec-WebSocket-Key: " + wsKey + "\r\n"
                + "Sec-WebSocket-Version: 13\r\n"
                + "X-Key: " + Cfg.key(this) + "\r\n"
                + "User-Agent: Pulse-Android\r\n\r\n";
        OutputStream out = s.getOutputStream();
        out.write(req.getBytes(StandardCharsets.UTF_8));
        out.flush();

        DataInputStream in = new DataInputStream(s.getInputStream());
        String status = readHttpLine(in);
        if (status == null || !status.contains(" 101")) throw new Exception("upgrade failed: " + status);
        String line;
        while ((line = readHttpLine(in)) != null && !line.isEmpty()) { /* skip headers */ }

        setState("live");
        markHeartbeat();

        ByteArrayOutputStream msg = new ByteArrayOutputStream();
        while (running) {
            int b0 = in.readUnsignedByte();
            int b1 = in.readUnsignedByte();
            boolean fin = (b0 & 0x80) != 0;
            int op = b0 & 0x0F;
            long len = b1 & 0x7F;
            if (len == 126) len = in.readUnsignedShort();
            else if (len == 127) len = in.readLong();
            byte[] mask = null;
            if ((b1 & 0x80) != 0) { mask = new byte[4]; in.readFully(mask); }
            if (len > 8_000_000) throw new Exception("frame too big");
            byte[] data = new byte[(int) len];
            in.readFully(data);
            if (mask != null) for (int i = 0; i < data.length; i++) data[i] ^= mask[i % 4];

            if (op == 0x8) { // close
                send(out, 0x8, new byte[0]);
                break;
            } else if (op == 0x9) { // ping
                send(out, 0xA, data);
            } else if (op == 0x1 || op == 0x0) { // text / continuation
                msg.write(data);
                if (fin) {
                    String text = new String(msg.toByteArray(), StandardCharsets.UTF_8);
                    msg.reset();
                    onMessage(text);
                }
            }
        }
        closeSocket();
    }

    private void send(OutputStream out, int op, byte[] payload) throws Exception {
        ByteArrayOutputStream f = new ByteArrayOutputStream();
        f.write(0x80 | op);
        int n = payload.length;
        if (n < 126) f.write(0x80 | n);
        else { f.write(0x80 | 126); f.write((n >> 8) & 0xFF); f.write(n & 0xFF); }
        byte[] mask = new byte[4];
        rnd.nextBytes(mask);
        f.write(mask);
        for (int i = 0; i < n; i++) f.write(payload[i] ^ mask[i % 4]);
        synchronized (this) { out.write(f.toByteArray()); out.flush(); }
    }

    private void onMessage(String text) {
        markHeartbeat();
        if ("pong".equals(text)) return;
        try {
            JSONObject j = new JSONObject(text);
            String type = j.optString("type");
            if ("items".equals(type)) handleItems(j.getJSONArray("items"), false);
        } catch (Exception ignored) {}
    }

    // ------------------------------------------------------- notifications
    private void handleItems(JSONArray items, boolean catchingUp) {
        long lastSeen = Cfg.p(this).getLong("lastSeen", 0);
        long now = System.currentTimeMillis();
        Set<String> watch = new HashSet<>(Arrays.asList(Cfg.watchlist(this).toUpperCase(Locale.US).split(",")));
        int shown = 0, skipped = 0;
        for (int i = 0; i < items.length(); i++) {
            JSONObject it = items.optJSONObject(i);
            if (it == null) continue;
            long seen = it.optLong("seen", 0);
            if (seen > lastSeen) lastSeen = seen;
            String cat = it.optString("cat");
            if (!Cfg.notifOn(this, cat)) continue;
            if (now - it.optLong("ts", now) > 3 * 3_600_000L) continue;
            if (Cfg.myCoinsOnly(this) && !"price".equals(cat)) {
                JSONArray coins = it.optJSONArray("coins");
                boolean hit = false;
                if (coins != null) for (int k = 0; k < coins.length(); k++) if (watch.contains(coins.optString(k))) hit = true;
                if (!hit) continue;
            }
            if (catchingUp && shown >= 6 && !"price".equals(cat)) { skipped++; continue; }
            notifyItem(it);
            shown++;
        }
        if (skipped > 0) {
            Notification.Builder b = new Notification.Builder(this, "cat_news")
                    .setSmallIcon(R.drawable.ic_stat)
                    .setColor(0xFF00E5A0)
                    .setContentTitle("Pulse caught up")
                    .setContentText("+" + skipped + " more updates while you were offline — open Pulse")
                    .setAutoCancel(true)
                    .setContentIntent(openApp());
            nm().notify(2, b.build());
        }
        Cfg.p(this).edit().putLong("lastSeen", lastSeen).apply();
    }

    private void notifyItem(JSONObject it) {
        String cat = it.optString("cat");
        String title = it.optString("title");
        String summary = it.optString("summary");
        String src = it.optString("srcName");
        String url = it.optString("url");
        String mood = it.optString("mood");

        String head = emoji(cat) + " " + src;
        if ("rumor".equals(cat) && title.toLowerCase(Locale.US).matches(".*(rumou?r|unconfirmed|reportedly|sources say).*")) head += " · unconfirmed";
        if ("bull".equals(mood)) head += "  ▲";
        if ("bear".equals(mood)) head += "  ▼";

        int id = it.optString("id").hashCode();
        PendingIntent pi = url.isEmpty() ? openApp() : PendingIntent.getActivity(this, id,
                new Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);

        String group = "pulse_" + cat;
        Notification.Builder b = new Notification.Builder(this, "cat_" + cat)
                .setSmallIcon(R.drawable.ic_stat)
                .setColor(color(cat, mood))
                .setContentTitle(head)
                .setContentText(title)
                .setStyle(new Notification.BigTextStyle().bigText(summary.isEmpty() ? title : title + "\n\n" + summary))
                .setWhen(it.optLong("ts", System.currentTimeMillis()))
                .setShowWhen(true)
                .setAutoCancel(true)
                .setContentIntent(pi)
                .setGroup(group);
        nm().notify(id, b.build());

        Notification summaryN = new Notification.Builder(this, "cat_" + cat)
                .setSmallIcon(R.drawable.ic_stat)
                .setColor(color(cat, mood))
                .setContentTitle(emoji(cat) + " " + label(cat))
                .setGroup(group)
                .setGroupSummary(true)
                .setGroupAlertBehavior(Notification.GROUP_ALERT_CHILDREN)
                .setAutoCancel(true)
                .setContentIntent(openApp())
                .build();
        nm().notify(("sum_" + cat).hashCode(), summaryN);
    }

    static String emoji(String cat) {
        switch (cat) {
            case "rumor": return "🔥";
            case "asia": return "🌏";
            case "whale": return "🐋";
            case "price": return "📈";
            case "brief": return "🧠";
            default: return "📰";
        }
    }

    static String label(String cat) {
        switch (cat) {
            case "rumor": return "Breaking & rumors";
            case "asia": return "Asia & China";
            case "whale": return "Whale moves";
            case "price": return "Price alerts";
            case "brief": return "AI briefings";
            default: return "Major news";
        }
    }

    private static int color(String cat, String mood) {
        if ("bull".equals(mood)) return 0xFF00E5A0;
        if ("bear".equals(mood)) return 0xFFFF4D6D;
        switch (cat) {
            case "rumor": return 0xFFFF8A00;
            case "asia": return 0xFFFF3D7F;
            case "whale": return 0xFF3DA9FF;
            case "price": return 0xFFFFD23D;
            default: return 0xFF9B8CFF;
        }
    }

    static void makeChannels(Context c) {
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        String[][] defs = {
                {"cat_brief", "🧠 AI briefings", "3"},
                {"cat_price", "📈 Price alerts", "4"},
                {"cat_rumor", "🔥 Breaking & rumors", "4"},
                {"cat_asia", "🌏 Asia & China", "4"},
                {"cat_whale", "🐋 Whale moves", "3"},
                {"cat_news", "📰 Major news", "3"},
        };
        for (String[] d : defs) {
            NotificationChannel ch = new NotificationChannel(d[0], d[1], Integer.parseInt(d[2]));
            ch.enableVibration(true);
            if (d[0].equals("cat_price")) ch.setVibrationPattern(new long[]{0, 120, 80, 120, 80, 260});
            nm.createNotificationChannel(ch);
        }
        NotificationChannel st = new NotificationChannel("status", "Watcher status (can hide)", NotificationManager.IMPORTANCE_MIN);
        st.setShowBadge(false);
        nm.createNotificationChannel(st);
    }

    // ------------------------------------------------------------- helpers
    private void goForeground(String text) {
        Notification n = new Notification.Builder(this, "status")
                .setSmallIcon(R.drawable.ic_stat)
                .setColor(0xFF00E5A0)
                .setContentTitle("Pulse")
                .setContentText(text)
                .setOngoing(true)
                .setContentIntent(openApp())
                .build();
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(STATUS_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING);
        } else {
            startForeground(STATUS_ID, n);
        }
    }

    private String statusText() {
        switch (state) {
            case "live": return "Live — watching 15 sources";
            case "connecting": return "Connecting…";
            default: return "Reconnecting…";
        }
    }

    private void setState(String s) {
        if (s.equals(state)) return;
        state = s;
        Cfg.p(this).edit().putString("state", s).apply();
        if (running) try { goForeground(statusText()); } catch (Exception ignored) {}
    }

    private void markHeartbeat() {
        Cfg.p(this).edit().putLong("lastHb", System.currentTimeMillis()).apply();
    }

    private PendingIntent openApp() {
        Intent i = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(this, 0, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private NotificationManager nm() { return getSystemService(NotificationManager.class); }

    private void scheduleWatchdog() {
        AlarmManager am = getSystemService(AlarmManager.class);
        Intent i = new Intent().setComponent(new ComponentName(this, BootReceiver.class)).setAction("com.vyd02.pulse.WATCHDOG");
        PendingIntent pi = PendingIntent.getBroadcast(this, 7, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        am.setInexactRepeating(AlarmManager.ELAPSED_REALTIME_WAKEUP,
                SystemClock.elapsedRealtime() + AlarmManager.INTERVAL_FIFTEEN_MINUTES,
                AlarmManager.INTERVAL_FIFTEEN_MINUTES, pi);
    }

    private void closeSocket() {
        Socket s = socket;
        socket = null;
        if (s != null) try { s.close(); } catch (Exception ignored) {}
    }

    private static String readHttpLine(DataInputStream in) throws Exception {
        StringBuilder sb = new StringBuilder();
        int c;
        while ((c = in.read()) != -1) {
            if (c == '\n') break;
            if (c != '\r') sb.append((char) c);
            if (sb.length() > 8192) throw new Exception("header too long");
        }
        return c == -1 && sb.length() == 0 ? null : sb.toString();
    }

    static String readAll(InputStream is) throws Exception {
        ByteArrayOutputStream bo = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = is.read(buf)) > 0) bo.write(buf, 0, n);
        is.close();
        return new String(bo.toByteArray(), StandardCharsets.UTF_8);
    }
}
