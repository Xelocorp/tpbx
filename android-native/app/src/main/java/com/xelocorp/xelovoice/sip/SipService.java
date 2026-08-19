package com.xelocorp.xelovoice.sip;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.Binder;
import android.os.Build;
import android.os.IBinder;

/**
 * Foreground service that owns the pjsua2 {@link SipEngine} for the whole app
 * lifetime, so the SIP registration stays alive when the UI is minimised or
 * closed. Started on demand (agent taps Connect) and on boot (BootReceiver)
 * when a saved account exists; it re-registers automatically from {@link Prefs}.
 */
public final class SipService extends Service {

    public static final String ACTION_CONNECT = "com.xelocorp.xelovoice.CONNECT";
    public static final String ACTION_DISCONNECT = "com.xelocorp.xelovoice.DISCONNECT";
    private static final String CHANNEL = "xelovoice.sip";
    private static final int NOTIF_ID = 42;

    private final IBinder binder = new LocalBinder();
    private SipEngine engine;

    public final class LocalBinder extends Binder {
        public SipService getService() { return SipService.this; }
    }

    public SipEngine engine() { return engine; }

    @Override
    public void onCreate() {
        super.onCreate();
        createChannel();
        startForeground(NOTIF_ID, buildNotification("Starting…"));
        engine = new SipEngine();
        engine.start();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : null;
        if (ACTION_DISCONNECT.equals(action)) {
            new Prefs(this).clear();
            if (engine != null) engine.unregister();
            updateNotification("Disconnected");
            stopForeground(true);
            stopSelf();
            return START_NOT_STICKY;
        }
        // CONNECT (or a restart): register from the saved account.
        Prefs prefs = new Prefs(this);
        if (prefs.autoConnect()) {
            engine.register(prefs.ext(), prefs.secret(), prefs.domain(), prefs.transport());
            updateNotification("Connecting as " + prefs.ext() + "…");
        }
        // STICKY so Android restarts us (and we re-register) if the OS kills us.
        return START_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) { return binder; }

    @Override
    public void onDestroy() {
        if (engine != null) { engine.shutdown(); engine = null; }
        super.onDestroy();
    }

    public void updateNotification(String text) {
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (nm != null) nm.notify(NOTIF_ID, buildNotification(text));
    }

    private Notification buildNotification(String text) {
        Notification.Builder b = (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
                ? new Notification.Builder(this, CHANNEL)
                : new Notification.Builder(this);
        return b.setContentTitle("XeloVoice")
                .setContentText(text)
                .setSmallIcon(android.R.drawable.stat_sys_phone_call)
                .setOngoing(true)
                .build();
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel ch = new NotificationChannel(
                    CHANNEL, "SIP connection", NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("Keeps your extension registered in the background");
            NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
            if (nm != null) nm.createNotificationChannel(ch);
        }
    }

    /** Convenience: start (and connect) the foreground service. */
    public static void connect(Context ctx) {
        Intent i = new Intent(ctx, SipService.class).setAction(ACTION_CONNECT);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(i);
        else ctx.startService(i);
    }

    public static void disconnect(Context ctx) {
        Intent i = new Intent(ctx, SipService.class).setAction(ACTION_DISCONNECT);
        ctx.startService(i);
    }
}
