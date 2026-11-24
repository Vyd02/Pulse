package com.vyd02.pulse;

import android.content.Context;
import android.content.SharedPreferences;

/** Shared settings between the screen and the background watcher. */
final class Cfg {
    static final String[] CATS = {"brief", "rumor", "asia", "whale", "news", "price"};

    static SharedPreferences p(Context c) {
        return c.getSharedPreferences("pulse", Context.MODE_PRIVATE);
    }

    static String server(Context c) {
        String s = p(c).getString("server", "").trim();
        while (s.endsWith("/")) s = s.substring(0, s.length() - 1);
        return s;
    }

    static String key(Context c) { return p(c).getString("key", ""); }

    static boolean ready(Context c) { return !server(c).isEmpty() && !key(c).isEmpty(); }

    static boolean notifOn(Context c, String cat) { return p(c).getBoolean("notif_" + cat, true); }

    static boolean myCoinsOnly(Context c) { return p(c).getBoolean("myCoinsOnly", false); }

    static String watchlist(Context c) { return p(c).getString("watchlist", "BTC,ETH,SOL,XRP,DOGE"); }

    static boolean paused(Context c) { return p(c).getBoolean("paused", false); }
}
