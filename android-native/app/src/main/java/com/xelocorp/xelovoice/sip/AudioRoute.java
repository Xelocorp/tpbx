package com.xelocorp.xelovoice.sip;

import android.content.Context;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.os.Build;

/**
 * In-call audio routing. Default is the earpiece; the agent can toggle the
 * loudspeaker. Uses setCommunicationDevice on API 31+ and falls back to
 * setSpeakerphoneOn on older releases.
 */
public final class AudioRoute {

    /** Enter communication (in-call) mode; start on the earpiece. */
    public static void beginCall(Context ctx) {
        AudioManager am = am(ctx);
        if (am == null) return;
        am.setMode(AudioManager.MODE_IN_COMMUNICATION);
        setSpeaker(ctx, false);
    }

    /** Leave in-call mode and restore normal routing. */
    public static void endCall(Context ctx) {
        AudioManager am = am(ctx);
        if (am == null) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            am.clearCommunicationDevice();
        } else {
            am.setSpeakerphoneOn(false);
        }
        am.setMode(AudioManager.MODE_NORMAL);
    }

    /** true = loudspeaker, false = earpiece. */
    public static void setSpeaker(Context ctx, boolean on) {
        AudioManager am = am(ctx);
        if (am == null) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            int target = on ? AudioDeviceInfo.TYPE_BUILTIN_SPEAKER
                            : AudioDeviceInfo.TYPE_BUILTIN_EARPIECE;
            for (AudioDeviceInfo d : am.getAvailableCommunicationDevices()) {
                if (d.getType() == target) { am.setCommunicationDevice(d); return; }
            }
        } else {
            am.setSpeakerphoneOn(on);
        }
    }

    public static boolean isSpeakerOn(Context ctx) {
        AudioManager am = am(ctx);
        if (am == null) return false;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            AudioDeviceInfo d = am.getCommunicationDevice();
            return d != null && d.getType() == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER;
        }
        return am.isSpeakerphoneOn();
    }

    private static AudioManager am(Context ctx) {
        return (AudioManager) ctx.getApplicationContext().getSystemService(Context.AUDIO_SERVICE);
    }

    private AudioRoute() {}
}
