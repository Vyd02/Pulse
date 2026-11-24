package com.vyd02.pulse;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Starts the watcher after a reboot, an app update, or a watchdog alarm. */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context ctx, Intent intent) {
        if (Cfg.ready(ctx) && !Cfg.paused(ctx)) {
            try {
                AlertService.start(ctx);
            } catch (Exception ignored) {
                // Android can refuse a background start; the next watchdog tick retries.
            }
        }
    }
}
