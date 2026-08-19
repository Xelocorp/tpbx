package com.xelocorp.xelovoice.sip;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * Restarts the SIP service after a device reboot so registration persists with
 * no agent action — only if a saved account exists (autoConnect).
 */
public final class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent != null ? intent.getAction() : null;
        if (Intent.ACTION_BOOT_COMPLETED.equals(action)
                || Intent.ACTION_LOCKED_BOOT_COMPLETED.equals(action)
                || "android.intent.action.QUICKBOOT_POWERON".equals(action)) {
            if (new Prefs(context).autoConnect()) {
                SipService.connect(context);
            }
        }
    }
}
