package com.xelocorp.xelovoice.sip;

import org.pjsip.pjsua2.Account;
import org.pjsip.pjsua2.Call;
import org.pjsip.pjsua2.OnCallMediaStateParam;
import org.pjsip.pjsua2.OnCallStateParam;

/** pjsua2 Call subclass forwarding state + media events to the engine. */
final class SipCall extends Call {
    private final SipEngine engine;

    SipCall(Account acc, SipEngine engine) {
        super(acc);
        this.engine = engine;
    }

    SipCall(Account acc, SipEngine engine, int callId) {
        super(acc, callId);
        this.engine = engine;
    }

    @Override
    public void onCallState(OnCallStateParam prm) {
        engine.onCallState(this, prm);
    }

    @Override
    public void onCallMediaState(OnCallMediaStateParam prm) {
        engine.onCallMedia(this);
    }
}
