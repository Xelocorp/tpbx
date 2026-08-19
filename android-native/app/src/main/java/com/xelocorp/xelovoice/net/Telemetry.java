package com.xelocorp.xelovoice.net;

import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Best-effort console telemetry, matching the desktop softphone contract:
 *   POST /api/agent/login   {extension, password} -> {token}
 *   POST /api/agent/telemetry (Bearer)  registered/unregistered/dnd/call events
 *   GET  /api/agent/calls    (Bearer) -> {calls:[...]}   (Recents)
 *   DELETE /api/agent/calls  (Bearer)                    (clear Recents)
 *
 * Native calls thus feed the same green analytics dashboard and Postgres-backed
 * Recents as desktop, and persist across re-login. All I/O is off the main
 * thread; every failure is swallowed so the phone works even if unreachable.
 */
public final class Telemetry {
    private static final String TAG = "XeloVoice/Telemetry";

    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private volatile String base;   // e.g. https://pbx.example.com
    private volatile String token;

    public static final class Call {
        public String direction, peer, outcome, at;
        public int durationSec;
    }

    /** Derive the console origin from the SIP domain (strip any :port). */
    public static String baseFromDomain(String domain) {
        if (domain == null) return "";
        String host = domain.trim();
        int colon = host.indexOf(':');
        if (colon > 0) host = host.substring(0, colon);
        if (host.isEmpty()) return "";
        return "https://" + host;
    }

    public void configure(String base) {
        this.base = base == null ? "" : base.replaceAll("/+$", "");
    }

    public boolean enabled() { return token != null && base != null && !base.isEmpty(); }

    public void login(final String extension, final String password) {
        io.execute(() -> {
            if (base == null || base.isEmpty()) return;
            try {
                JSONObject body = new JSONObject()
                        .put("extension", extension).put("password", password);
                String resp = request("POST", "/api/agent/login", body.toString(), null);
                if (resp != null) token = new JSONObject(resp).optString("token", null);
            } catch (Throwable t) {
                Log.w(TAG, "login failed: " + t.getMessage());
            }
        });
    }

    public void sendRegistered(boolean up, String transport) {
        final String ev = up ? "registered" : "unregistered";
        io.execute(() -> post(safe(new JSONObject(), o -> {
            o.put("event", ev).put("transport", transport);
        })));
    }

    public void sendCall(final String direction, final String peer, final String outcome,
                         final int durationSec, final String transport) {
        io.execute(() -> post(safe(new JSONObject(), o -> {
            o.put("event", "call").put("direction", direction).put("peer", peer)
             .put("outcome", outcome).put("durationSec", durationSec).put("transport", transport);
        })));
    }

    public List<Call> getCalls() {
        List<Call> out = new ArrayList<>();
        if (!enabled()) return out;
        try {
            String resp = request("GET", "/api/agent/calls", null, token);
            if (resp == null) return out;
            JSONArray arr = new JSONObject(resp).optJSONArray("calls");
            if (arr == null) return out;
            for (int i = 0; i < arr.length(); i++) {
                JSONObject c = arr.getJSONObject(i);
                Call call = new Call();
                call.direction = c.optString("direction");
                call.peer = c.optString("peer");
                call.outcome = c.optString("outcome");
                call.durationSec = c.optInt("durationSec");
                call.at = c.optString("at");
                out.add(call);
            }
        } catch (Throwable t) {
            Log.w(TAG, "getCalls failed: " + t.getMessage());
        }
        return out;
    }

    public boolean clearCalls() {
        if (!enabled()) return false;
        try { return request("DELETE", "/api/agent/calls", null, token) != null; }
        catch (Throwable t) { return false; }
    }

    // --- internal ---------------------------------------------------------

    private void post(JSONObject body) {
        if (!enabled() || body == null) return;
        try { request("POST", "/api/agent/telemetry", body.toString(), token); }
        catch (Throwable t) { Log.w(TAG, "telemetry post failed: " + t.getMessage()); }
    }

    private interface Build { void fill(JSONObject o) throws Exception; }

    private static JSONObject safe(JSONObject o, Build b) {
        try { b.fill(o); return o; } catch (Throwable t) { return null; }
    }

    private String request(String method, String path, String body, String bearer) throws Exception {
        URL url = new URL(base + path);
        HttpURLConnection c = (HttpURLConnection) url.openConnection();
        c.setConnectTimeout(8000);
        c.setReadTimeout(8000);
        c.setRequestMethod(method);
        if (bearer != null) c.setRequestProperty("Authorization", "Bearer " + bearer);
        if (body != null) {
            c.setDoOutput(true);
            c.setRequestProperty("Content-Type", "application/json");
            try (OutputStream os = c.getOutputStream()) {
                os.write(body.getBytes(StandardCharsets.UTF_8));
            }
        }
        int code = c.getResponseCode();
        if (code < 200 || code >= 300) { c.disconnect(); return null; }
        InputStream is = c.getInputStream();
        StringBuilder sb = new StringBuilder();
        try (BufferedReader r = new BufferedReader(new InputStreamReader(is, StandardCharsets.UTF_8))) {
            String line;
            while ((line = r.readLine()) != null) sb.append(line);
        }
        c.disconnect();
        return sb.toString();
    }
}
