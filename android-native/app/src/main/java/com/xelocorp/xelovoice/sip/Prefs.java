package com.xelocorp.xelovoice.sip;

import android.content.Context;
import android.content.SharedPreferences;

/**
 * Persisted account so registration survives app close and device reboot.
 * The agent registers once; {@code autoConnect} stays true until they sign out.
 */
public final class Prefs {
    private static final String FILE = "xelovoice";
    private final SharedPreferences sp;

    public Prefs(Context ctx) {
        this.sp = ctx.getApplicationContext().getSharedPreferences(FILE, Context.MODE_PRIVATE);
    }

    public void save(String ext, String secret, String domain, SipEngine.Transport transport) {
        sp.edit()
          .putString("ext", ext)
          .putString("secret", secret)
          .putString("domain", domain)
          .putString("transport", transport.name())
          .putBoolean("autoConnect", true)
          .apply();
    }

    public void clear() {
        sp.edit().putBoolean("autoConnect", false).apply();
    }

    public boolean autoConnect() { return sp.getBoolean("autoConnect", false); }
    public String ext()    { return sp.getString("ext", ""); }
    public String secret() { return sp.getString("secret", ""); }
    public String domain() { return sp.getString("domain", ""); }

    public SipEngine.Transport transport() {
        try { return SipEngine.Transport.valueOf(sp.getString("transport", "UDP")); }
        catch (Throwable e) { return SipEngine.Transport.UDP; }
    }
}
