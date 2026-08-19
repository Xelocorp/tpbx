package com.xelocorp.xelovoice.sip;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.media.Ringtone;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Binder;
import android.os.Build;
import android.os.IBinder;

import com.xelocorp.xelovoice.IncomingActivity;

/**
 * Foreground service that owns the pjsua2 {@link SipEngine} for the whole app
 * lifetime, so the SIP registration stays alive when the UI is minimised or
 * closed. It is the engine's listener (so incoming calls ring even with no UI)
 * and re-broadcasts events to a bound Activity. Started on demand (Register) or
 * on boot when a saved account exists; re-registers automatically from Prefs.
 */
public final class SipService extends Service implements SipEngine.Listener {

    public static final String ACTION_CONNECT = "com.xelocorp.xelovoice.CONNECT";
    public static final String ACTION_DISCONNECT = "com.xelocorp.xelovoice.DISCONNECT";
    public static final String ACTION_ANSWER = "com.xelocorp.xelovoice.ANSWER";
    public static final String ACTION_DECLINE = "com.xelocorp.xelovoice.DECLINE";

    private static final String CHANNEL = "xelovoice.sip";
    private static final String CHANNEL_INCOMING = "xelovoice.incoming";
    private static final int NOTIF_ID = 42;
    private static final int NOTIF_INCOMING = 43;

    private final IBinder binder = new LocalBinder();
    private SipEngine engine;
    private volatile SipEngine.Listener ui;
    private Ringtone ringtone;

    public final class LocalBinder extends Binder {
        public SipService getService() { return SipService.this; }
    }

    public SipEngine engine() { return engine; }
    public void setUiListener(SipEngine.Listener l) { this.ui = l; }
    public void clearUiListener() { this.ui = null; }

    @Override
    public void onCreate() {
        super.onCreate();
        createChannels();
        startForeground(NOTIF_ID, buildOngoing("Starting…"));
        engine = new SipEngine();
        engine.setListener(this);
        engine.start();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : null;
        if (ACTION_DISCONNECT.equals(action)) {
            new Prefs(this).clear();
            if (engine != null) engine.unregister();
            stopForeground(true);
            stopSelf();
            return START_NOT_STICKY;
        }
        if (ACTION_ANSWER.equals(action)) {
            stopRinging(); cancelIncoming();
            if (engine != null) engine.answer();
            return START_STICKY;
        }
        if (ACTION_DECLINE.equals(action)) {
            stopRinging(); cancelIncoming();
            if (engine != null) engine.hangup();
            return START_STICKY;
        }
        // CONNECT (or a restart): register from the saved account.
        Prefs prefs = new Prefs(this);
        if (prefs.autoConnect()) {
            engine.register(prefs.ext(), prefs.secret(), prefs.domain(), prefs.transport());
            updateOngoing("Connecting as " + prefs.ext() + "…");
        }
        return START_STICKY;   // OS restart -> we re-register
    }

    @Override public IBinder onBind(Intent intent) { return binder; }

    @Override
    public void onDestroy() {
        stopRinging();
        if (engine != null) { engine.shutdown(); engine = null; }
        super.onDestroy();
    }

    // --- SipEngine.Listener: service behaviour + re-broadcast to UI -------

    @Override public void onRegState(boolean active, int code, String reason) {
        updateOngoing(active ? "Registered" : ("Unregistered (" + code + ")"));
        SipEngine.Listener l = ui; if (l != null) l.onRegState(active, code, reason);
    }

    @Override public void onCallState(String state, boolean established, boolean ended) {
        if (established || ended) { stopRinging(); cancelIncoming(); }
        SipEngine.Listener l = ui; if (l != null) l.onCallState(state, established, ended);
    }

    @Override public void onIncoming(String fromUri) {
        showIncoming(fromUri);
        startRinging();
        SipEngine.Listener l = ui; if (l != null) l.onIncoming(fromUri);
    }

    @Override public void onError(String message) {
        SipEngine.Listener l = ui; if (l != null) l.onError(message);
    }

    // --- notifications + ringtone ----------------------------------------

    private void showIncoming(String from) {
        Intent full = new Intent(this, IncomingActivity.class)
                .putExtra(IncomingActivity.EXTRA_FROM, from)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int piFlags = PendingIntent.FLAG_UPDATE_CURRENT
                | (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? PendingIntent.FLAG_IMMUTABLE : 0);
        PendingIntent fullPi = PendingIntent.getActivity(this, 0, full, piFlags);

        Notification.Builder b = (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
                ? new Notification.Builder(this, CHANNEL_INCOMING)
                : new Notification.Builder(this);
        b.setContentTitle("Incoming call")
         .setContentText(from)
         .setSmallIcon(android.R.drawable.stat_sys_phone_call)
         .setAutoCancel(true)
         .setOngoing(true)
         .setFullScreenIntent(fullPi, true)
         .setContentIntent(fullPi);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            b.setCategory(Notification.CATEGORY_CALL);
        }
        b.addAction(new Notification.Action.Builder(null, "Answer",
                actionPi(ACTION_ANSWER, 1)).build());
        b.addAction(new Notification.Action.Builder(null, "Decline",
                actionPi(ACTION_DECLINE, 2)).build());

        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (nm != null) nm.notify(NOTIF_INCOMING, b.build());
    }

    private PendingIntent actionPi(String action, int req) {
        Intent i = new Intent(this, SipService.class).setAction(action);
        int flags = Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? PendingIntent.FLAG_IMMUTABLE : 0;
        return PendingIntent.getService(this, req, i, flags);
    }

    private void cancelIncoming() {
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (nm != null) nm.cancel(NOTIF_INCOMING);
    }

    private void startRinging() {
        try {
            if (ringtone != null && ringtone.isPlaying()) return;
            Uri uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE);
            ringtone = RingtoneManager.getRingtone(getApplicationContext(), uri);
            if (ringtone != null) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) ringtone.setLooping(true);
                ringtone.play();
            }
        } catch (Throwable ignore) { }
    }

    private void stopRinging() {
        try { if (ringtone != null) { ringtone.stop(); ringtone = null; } }
        catch (Throwable ignore) { }
    }

    public void updateOngoing(String text) {
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (nm != null) nm.notify(NOTIF_ID, buildOngoing(text));
    }

    private Notification buildOngoing(String text) {
        Notification.Builder b = (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
                ? new Notification.Builder(this, CHANNEL)
                : new Notification.Builder(this);
        return b.setContentTitle("XeloVoice")
                .setContentText(text)
                .setSmallIcon(android.R.drawable.stat_sys_phone_call)
                .setOngoing(true)
                .build();
    }

    private void createChannels() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
            if (nm == null) return;
            NotificationChannel ongoing = new NotificationChannel(
                    CHANNEL, "SIP connection", NotificationManager.IMPORTANCE_LOW);
            ongoing.setDescription("Keeps your extension registered in the background");
            nm.createNotificationChannel(ongoing);
            NotificationChannel incoming = new NotificationChannel(
                    CHANNEL_INCOMING, "Incoming calls", NotificationManager.IMPORTANCE_HIGH);
            incoming.setDescription("Rings for incoming calls");
            nm.createNotificationChannel(incoming);
        }
    }

    // --- static helpers ---------------------------------------------------

    public static void connect(Context ctx) { start(ctx, ACTION_CONNECT); }
    public static void answer(Context ctx) { ctx.startService(intent(ctx, ACTION_ANSWER)); }
    public static void decline(Context ctx) { ctx.startService(intent(ctx, ACTION_DECLINE)); }
    public static void disconnect(Context ctx) { ctx.startService(intent(ctx, ACTION_DISCONNECT)); }

    private static Intent intent(Context ctx, String action) {
        return new Intent(ctx, SipService.class).setAction(action);
    }

    private static void start(Context ctx, String action) {
        Intent i = intent(ctx, action);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(i);
        else ctx.startService(i);
    }
}
