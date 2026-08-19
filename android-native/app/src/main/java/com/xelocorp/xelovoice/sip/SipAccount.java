package com.xelocorp.xelovoice.sip;

import org.pjsip.pjsua2.Account;
import org.pjsip.pjsua2.OnIncomingCallParam;
import org.pjsip.pjsua2.OnRegStateParam;

/** pjsua2 Account subclass forwarding registration + incoming-call events. */
final class SipAccount extends Account {
    private final SipEngine engine;

    SipAccount(SipEngine engine) {
        this.engine = engine;
    }

    @Override
    public void onRegState(OnRegStateParam prm) {
        engine.onRegState(prm);
    }

    @Override
    public void onIncomingCall(OnIncomingCallParam prm) {
        engine.onIncoming(this, prm);
    }
}
