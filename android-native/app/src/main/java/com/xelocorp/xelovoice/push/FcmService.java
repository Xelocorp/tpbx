package com.xelocorp.xelovoice.push;

import android.util.Log;

import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;
import com.xelocorp.xelovoice.sip.Prefs;
import com.xelocorp.xelovoice.sip.SipService;

/**
 * Wakes the SIP service on an inbound-INVITE push so the phone rings even when
 * the OS has killed the foreground service (Doze / swipe-away on aggressive
 * OEMs). Only active once a google-services.json is present and the console/
 * Asterisk sends a data push on inbound calls (see docs/ANDROID_NATIVE_SETUP.md).
 */
public final class FcmService extends FirebaseMessagingService {
    private static final String TAG = "XeloVoice/Fcm";

    @Override
    public void onMessageReceived(RemoteMessage message) {
        // Any push for this device means a call is incoming: wake + re-register
        // so pjsua2 is up in time to receive the INVITE and ring.
        if (new Prefs(this).autoConnect()) {
            SipService.connect(this);
        }
    }

    @Override
    public void onNewToken(String token) {
        Log.i(TAG, "FCM token refreshed");
        new Prefs(this).savePushToken(token);
        // The console must collect this token (e.g. via /api/agent/telemetry or
        // a dedicated endpoint) so Asterisk can target this device on inbound
        // calls. Wired server-side in a follow-up; see the setup doc.
    }
}
