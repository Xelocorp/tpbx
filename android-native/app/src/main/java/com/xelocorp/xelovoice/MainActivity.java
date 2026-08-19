package com.xelocorp.xelovoice;

import android.app.Activity;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.widget.ArrayAdapter;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.Spinner;
import android.widget.TextView;

import com.xelocorp.xelovoice.sip.SipEngine;

/**
 * Minimal native dialer driving the pjsua2 {@link SipEngine} over UDP/TCP/TLS.
 * This is the device-testable M1 milestone; the foreground service, audio
 * routing, boot/FCM persistence and telemetry parity are layered on next
 * (see docs/NATIVE_SOFTPHONE.md). WSS on native routes through the WebRTC
 * path and is shown here for parity but disabled in the native engine.
 */
public class MainActivity extends Activity implements SipEngine.Listener {

    static {
        try { System.loadLibrary("c++_shared"); } catch (Throwable ignore) { }
        System.loadLibrary("pjsua2");
    }

    private final SipEngine engine = new SipEngine();
    private final Handler ui = new Handler(Looper.getMainLooper());

    private EditText extField, secretField, domainField, destField;
    private Spinner transportSpinner;
    private TextView status;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        int pad = dp(20);
        root.setPadding(pad, pad, pad, pad);

        TextView title = new TextView(this);
        title.setText("XeloVoice — Native Softphone");
        title.setTextSize(20);
        title.setPadding(0, 0, 0, dp(12));
        root.addView(title);

        extField = field(root, "Extension", InputType.TYPE_CLASS_NUMBER);
        secretField = field(root, "SIP secret",
                InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        domainField = field(root, "Domain (host[:port])", InputType.TYPE_CLASS_TEXT);

        transportSpinner = new Spinner(this);
        ArrayAdapter<String> adapter = new ArrayAdapter<>(this,
                android.R.layout.simple_spinner_dropdown_item,
                new String[]{"UDP", "TCP", "TLS", "WSS"});
        transportSpinner.setAdapter(adapter);
        root.addView(transportSpinner);

        LinearLayout regRow = new LinearLayout(this);
        regRow.setOrientation(LinearLayout.HORIZONTAL);
        Button registerBtn = new Button(this);
        registerBtn.setText("Register");
        registerBtn.setOnClickListener(v -> doRegister());
        Button unregisterBtn = new Button(this);
        unregisterBtn.setText("Unregister");
        unregisterBtn.setOnClickListener(v -> engine.unregister());
        regRow.addView(registerBtn, eqWidth());
        regRow.addView(unregisterBtn, eqWidth());
        root.addView(regRow);

        destField = field(root, "Dial (extension or SIP URI)", InputType.TYPE_CLASS_TEXT);

        LinearLayout callRow = new LinearLayout(this);
        callRow.setOrientation(LinearLayout.HORIZONTAL);
        Button callBtn = new Button(this);
        callBtn.setText("Call");
        callBtn.setOnClickListener(v -> doDial());
        Button answerBtn = new Button(this);
        answerBtn.setText("Answer");
        answerBtn.setOnClickListener(v -> engine.answer());
        Button hangupBtn = new Button(this);
        hangupBtn.setText("Hang up");
        hangupBtn.setOnClickListener(v -> engine.hangup());
        callRow.addView(callBtn, eqWidth());
        callRow.addView(answerBtn, eqWidth());
        callRow.addView(hangupBtn, eqWidth());
        root.addView(callRow);

        status = new TextView(this);
        status.setPadding(0, dp(16), 0, 0);
        status.setText("Idle.");
        root.addView(status);

        setContentView(root);

        engine.setListener(this);
        engine.start();
    }

    private void doRegister() {
        engine.register(
                extField.getText().toString().trim(),
                secretField.getText().toString(),
                domainField.getText().toString().trim(),
                selectedTransport());
        setStatus("Registering…");
    }

    private void doDial() {
        engine.dial(
                destField.getText().toString().trim(),
                domainField.getText().toString().trim(),
                selectedTransport());
        setStatus("Calling…");
    }

    private SipEngine.Transport selectedTransport() {
        String t = (String) transportSpinner.getSelectedItem();
        try { return SipEngine.Transport.valueOf(t); }
        catch (Throwable e) { return SipEngine.Transport.UDP; }
    }

    // --- SipEngine.Listener (posted onto the UI thread) -------------------

    @Override public void onRegState(boolean active, int code, String reason) {
        setStatus((active ? "Registered" : "Unregistered") + " (" + code + " " + reason + ")");
    }

    @Override public void onCallState(String state, boolean established, boolean ended) {
        setStatus("Call: " + state);
    }

    @Override public void onIncoming(String fromUri) {
        setStatus("Incoming call from " + fromUri);
    }

    @Override public void onError(String message) {
        setStatus("Error: " + message);
    }

    @Override protected void onDestroy() {
        super.onDestroy();
        engine.shutdown();
    }

    // --- tiny view helpers ------------------------------------------------

    private void setStatus(String s) { ui.post(() -> status.setText(s)); }

    private EditText field(LinearLayout parent, String hint, int inputType) {
        EditText e = new EditText(this);
        e.setHint(hint);
        e.setInputType(inputType);
        parent.addView(e);
        return e;
    }

    private LinearLayout.LayoutParams eqWidth() {
        LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(
                0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f);
        return p;
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }
}
