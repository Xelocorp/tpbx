package com.xelocorp.xelovoice.sip;

import android.util.Log;

import org.pjsip.pjsua2.Account;
import org.pjsip.pjsua2.AccountConfig;
import org.pjsip.pjsua2.AudDevManager;
import org.pjsip.pjsua2.AudioMedia;
import org.pjsip.pjsua2.AuthCredInfo;
import org.pjsip.pjsua2.Call;
import org.pjsip.pjsua2.CallInfo;
import org.pjsip.pjsua2.CallMediaInfo;
import org.pjsip.pjsua2.CallMediaInfoVector;
import org.pjsip.pjsua2.CallOpParam;
import org.pjsip.pjsua2.Endpoint;
import org.pjsip.pjsua2.EpConfig;
import org.pjsip.pjsua2.OnCallMediaStateParam;
import org.pjsip.pjsua2.OnCallStateParam;
import org.pjsip.pjsua2.OnIncomingCallParam;
import org.pjsip.pjsua2.OnRegStateParam;
import org.pjsip.pjsua2.TransportConfig;
import org.pjsip.pjsua2.pjmedia_type;
import org.pjsip.pjsua2.pjsip_inv_state;
import org.pjsip.pjsua2.pjsip_status_code;
import org.pjsip.pjsua2.pjsip_transport_type_e;
import org.pjsip.pjsua2.pjsua_call_media_status;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Thin, single-endpoint wrapper over pjsua2. Owns the {@link Endpoint}, the
 * transports (UDP/TCP/TLS) and the current account/call, and drives register /
 * dial / hangup off a dedicated worker thread (pjsua2 requires the calling
 * thread to be library-registered).
 *
 * Audio uses the pjsua2 default sound device; explicit earpiece/speaker routing
 * is layered on in {@code audio/AudioRoute} on top of this.
 */
public final class SipEngine {

    static {
        try { System.loadLibrary("c++_shared"); } catch (Throwable ignore) { }
        System.loadLibrary("pjsua2");
    }

    public enum Transport { UDP, TCP, TLS, WSS }

    /** UI-facing callbacks (always posted back on the worker thread). */
    public interface Listener {
        void onRegState(boolean active, int code, String reason);
        void onCallState(String state, boolean established, boolean ended);
        void onIncoming(String fromUri);
        void onError(String message);
    }

    private static final String TAG = "XeloVoice/Sip";

    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private Endpoint ep;
    private Account account;
    private SipCall current;
    private Listener listener;

    private int udpId = -1, tcpId = -1, tlsId = -1;

    public void setListener(Listener l) { this.listener = l; }

    /** Start the endpoint + transports. Safe to call once. */
    public void start() {
        worker.execute(() -> {
            try {
                if (ep != null) return;
                ep = new Endpoint();
                ep.libCreate();

                EpConfig cfg = new EpConfig();
                cfg.getLogConfig().setLevel(4);
                cfg.getUaConfig().setUserAgent("XeloVoice-Android");
                ep.libInit(cfg);

                TransportConfig udp = new TransportConfig();
                udpId = ep.transportCreate(pjsip_transport_type_e.PJSIP_TRANSPORT_UDP, udp);
                TransportConfig tcp = new TransportConfig();
                tcpId = ep.transportCreate(pjsip_transport_type_e.PJSIP_TRANSPORT_TCP, tcp);
                try {
                    TransportConfig tls = new TransportConfig();
                    tlsId = ep.transportCreate(pjsip_transport_type_e.PJSIP_TRANSPORT_TLS, tls);
                } catch (Throwable t) {
                    Log.w(TAG, "TLS transport unavailable: " + t.getMessage());
                    tlsId = -1;
                }

                ep.libStart();
                Log.i(TAG, "pjsua2 started " + ep.libVersion().getFull());
            } catch (Throwable t) {
                err("engine start failed: " + t.getMessage());
            }
        });
    }

    /** Register the account on the given transport. */
    public void register(final String ext, final String secret, final String domain,
                         final Transport transport) {
        worker.execute(() -> {
            try {
                ensureThread();
                // Tear down any prior account before re-registering.
                if (account != null) { account.delete(); account = null; }

                boolean tls = transport == Transport.TLS;
                String scheme = tls ? "sips" : "sip";
                String idUri = scheme + ":" + ext + "@" + domain;
                String regUri = scheme + ":" + domain;

                AccountConfig acfg = new AccountConfig();
                acfg.setIdUri(idUri);
                acfg.getRegConfig().setRegistrarUri(regUri);

                AuthCredInfo cred = new AuthCredInfo("digest", "*", ext, 0, secret);
                acfg.getSipConfig().getAuthCreds().add(cred);

                int tid = transportIdFor(transport);
                if (tid >= 0) {
                    acfg.getSipConfig().setTransportId(tid);
                }
                acfg.getRegConfig().setRegisterOnAdd(true);

                SipAccount acc = new SipAccount(this);
                acc.create(acfg);
                account = acc;
            } catch (Throwable t) {
                err("register failed: " + t.getMessage());
            }
        });
    }

    public void unregister() {
        worker.execute(() -> {
            try {
                ensureThread();
                if (account != null) { account.delete(); account = null; }
            } catch (Throwable t) {
                err("unregister failed: " + t.getMessage());
            }
        });
    }

    public void dial(final String dest, final String domain, final Transport transport) {
        worker.execute(() -> {
            try {
                ensureThread();
                if (account == null) { err("not registered"); return; }
                String scheme = transport == Transport.TLS ? "sips" : "sip";
                String uri = dest.startsWith("sip") ? dest : scheme + ":" + dest + "@" + domain;
                SipCall call = new SipCall(account, this);
                CallOpParam prm = new CallOpParam(true);
                call.makeCall(uri, prm);
                current = call;
            } catch (Throwable t) {
                err("dial failed: " + t.getMessage());
            }
        });
    }

    public void answer() {
        worker.execute(() -> {
            try {
                ensureThread();
                if (current == null) return;
                CallOpParam prm = new CallOpParam(true);
                prm.setStatusCode(pjsip_status_code.PJSIP_SC_OK);
                current.answer(prm);
            } catch (Throwable t) {
                err("answer failed: " + t.getMessage());
            }
        });
    }

    public void hangup() {
        worker.execute(() -> {
            try {
                ensureThread();
                if (current == null) return;
                CallOpParam prm = new CallOpParam(true);
                prm.setStatusCode(pjsip_status_code.PJSIP_SC_DECLINE);
                current.hangup(prm);
            } catch (Throwable t) {
                err("hangup failed: " + t.getMessage());
            }
        });
    }

    public void shutdown() {
        worker.execute(() -> {
            try {
                if (ep == null) return;
                if (current != null) { current.delete(); current = null; }
                if (account != null) { account.delete(); account = null; }
                ep.libDestroy();
                ep = null;
            } catch (Throwable t) {
                Log.w(TAG, "shutdown: " + t.getMessage());
            }
        });
    }

    // --- internal ---------------------------------------------------------

    private int transportIdFor(Transport t) {
        switch (t) {
            case TCP: return tcpId;
            case TLS: return tlsId;
            case UDP:
            default:  return udpId;
        }
    }

    private void ensureThread() {
        try {
            if (ep != null && !ep.libIsThreadRegistered()) {
                ep.libRegisterThread("worker");
            }
        } catch (Throwable ignore) { }
    }

    void setCurrent(SipCall c) { this.current = c; }

    void onRegState(OnRegStateParam prm) {
        if (listener == null) return;
        int code = prm.getCode();
        boolean active = code / 100 == 2;
        listener.onRegState(active, code, prm.getReason());
    }

    void onIncoming(SipAccount acc, OnIncomingCallParam prm) {
        try {
            ensureThread();
            SipCall call = new SipCall(acc, this, prm.getCallId());
            current = call;
            CallInfo ci = call.getInfo();
            if (listener != null) listener.onIncoming(ci.getRemoteUri());
        } catch (Throwable t) {
            err("incoming failed: " + t.getMessage());
        }
    }

    void onCallState(SipCall call, OnCallStateParam prm) {
        try {
            CallInfo ci = call.getInfo();
            boolean established = ci.getState() == pjsip_inv_state.PJSIP_INV_STATE_CONFIRMED;
            boolean ended = ci.getState() == pjsip_inv_state.PJSIP_INV_STATE_DISCONNECTED;
            if (listener != null) listener.onCallState(ci.getStateText(), established, ended);
            if (ended) {
                if (current == call) current = null;
                call.delete();
            }
        } catch (Throwable t) {
            err("callState failed: " + t.getMessage());
        }
    }

    void onCallMedia(SipCall call) {
        try {
            CallInfo ci = call.getInfo();
            CallMediaInfoVector media = ci.getMedia();
            for (int i = 0; i < media.size(); i++) {
                CallMediaInfo mi = media.get(i);
                if (mi.getType() == pjmedia_type.PJMEDIA_TYPE_AUDIO
                        && mi.getStatus() == pjsua_call_media_status.PJSUA_CALL_MEDIA_ACTIVE) {
                    AudioMedia am = call.getAudioMedia(i);
                    AudDevManager mgr = ep.audDevManager();
                    mgr.getCaptureDevMedia().startTransmit(am);
                    am.startTransmit(mgr.getPlaybackDevMedia());
                }
            }
        } catch (Throwable t) {
            err("media failed: " + t.getMessage());
        }
    }

    Endpoint endpoint() { return ep; }

    private void err(String m) {
        Log.e(TAG, m);
        if (listener != null) listener.onError(m);
    }
}
