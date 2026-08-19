package com.xelocorp.xelovoice;

import android.Manifest;
import android.app.Activity;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.ServiceConnection;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.text.InputType;
import android.widget.ArrayAdapter;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.Spinner;
import android.widget.TextView;

import com.xelocorp.xelovoice.sip.Prefs;
import com.xelocorp.xelovoice.sip.SipEngine;
import com.xelocorp.xelovoice.sip.SipService;

/**
 * Native dialer UI. The pjsua2 engine lives in {@link SipService} (a foreground
 * service) so registration persists in the background and across reboot; this
 * activity binds to it to drive dial/answer/hangup and show status. Registering
 * saves the account and starts the service; it stays registered until the agent
 * taps Unregister. WSS is shown for parity but handled via the WebRTC path.
 */
public class MainActivity extends Activity implements SipEngine.Listener {

    private final Handler ui = new Handler(Looper.getMainLooper());
    private SipEngine engine;
    private boolean bound;

    private EditText extField, secretField, domainField, destField;
    private Spinner transportSpinner;
    private TextView status;

    private final ServiceConnection conn = new ServiceConnection() {
        @Override public void onServiceConnected(ComponentName name, IBinder binder) {
            SipService svc = ((SipService.LocalBinder) binder).getService();
            engine = svc.engine();
            if (engine != null) engine.setListener(MainActivity.this);
            bound = true;
        }
        @Override public void onServiceDisconnected(ComponentName name) {
            engine = null; bound = false;
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        requestRuntimePermissions();

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        int pad = dp(20);
        root.setPadding(pad, pad, pad, pad);

        TextView title = new TextView(this);
        title.setText("XeloVoice — Native Softphone");
        title.setTextSize(20);
        title.setPadding(0, 0, 0, dp(12));
        root.addView(title);

        Prefs prefs = new Prefs(this);
        extField = field(root, "Extension", InputType.TYPE_CLASS_NUMBER, prefs.ext());
        secretField = field(root, "SIP secret",
                InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD, prefs.secret());
        domainField = field(root, "Domain (host[:port])", InputType.TYPE_CLASS_TEXT, prefs.domain());

        transportSpinner = new Spinner(this);
        ArrayAdapter<String> adapter = new ArrayAdapter<>(this,
                android.R.layout.simple_spinner_dropdown_item,
                new String[]{"UDP", "TCP", "TLS", "WSS"});
        transportSpinner.setAdapter(adapter);
        transportSpinner.setSelection(indexOf(prefs.transport().name()));
        root.addView(transportSpinner);

        LinearLayout regRow = new LinearLayout(this);
        regRow.setOrientation(LinearLayout.HORIZONTAL);
        Button registerBtn = new Button(this);
        registerBtn.setText("Register");
        registerBtn.setOnClickListener(v -> doRegister());
        Button unregisterBtn = new Button(this);
        unregisterBtn.setText("Unregister");
        unregisterBtn.setOnClickListener(v -> doUnregister());
        regRow.addView(registerBtn, eqWidth());
        regRow.addView(unregisterBtn, eqWidth());
        root.addView(regRow);

        destField = field(root, "Dial (extension or SIP URI)", InputType.TYPE_CLASS_TEXT, "");

        LinearLayout callRow = new LinearLayout(this);
        callRow.setOrientation(LinearLayout.HORIZONTAL);
        Button callBtn = new Button(this);
        callBtn.setText("Call");
        callBtn.setOnClickListener(v -> doDial());
        Button answerBtn = new Button(this);
        answerBtn.setText("Answer");
        answerBtn.setOnClickListener(v -> { if (engine != null) engine.answer(); });
        Button hangupBtn = new Button(this);
        hangupBtn.setText("Hang up");
        hangupBtn.setOnClickListener(v -> { if (engine != null) engine.hangup(); });
        callRow.addView(callBtn, eqWidth());
        callRow.addView(answerBtn, eqWidth());
        callRow.addView(hangupBtn, eqWidth());
        root.addView(callRow);

        status = new TextView(this);
        status.setPadding(0, dp(16), 0, 0);
        status.setText(prefs.autoConnect() ? "Registered account saved." : "Idle.");
        root.addView(status);

        setContentView(root);
    }

    @Override protected void onStart() {
        super.onStart();
        // Bind (without auto-creating) so we attach to a running service; the
        // service is created explicitly on Register / boot.
        bindService(new Intent(this, SipService.class), conn, 0);
    }

    @Override protected void onStop() {
        super.onStop();
        if (bound) { unbindService(conn); bound = false; }
    }

    private void doRegister() {
        new Prefs(this).save(
                extField.getText().toString().trim(),
                secretField.getText().toString(),
                domainField.getText().toString().trim(),
                selectedTransport());
        SipService.connect(this);                 // start FGS -> registers from prefs
        // Re-bind so we pick up the freshly created engine.
        if (!bound) bindService(new Intent(this, SipService.class), conn, 0);
        setStatus("Registering…");
    }

    private void doUnregister() {
        SipService.disconnect(this);
        setStatus("Unregistered.");
    }

    private void doDial() {
        if (engine == null) { setStatus("Not connected yet — tap Register first."); return; }
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

    private void requestRuntimePermissions() {
        java.util.List<String> need = new java.util.ArrayList<>();
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED)
            need.add(Manifest.permission.RECORD_AUDIO);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED)
            need.add(Manifest.permission.POST_NOTIFICATIONS);
        if (!need.isEmpty()) requestPermissions(need.toArray(new String[0]), 1);
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

    // --- helpers ----------------------------------------------------------

    private void setStatus(String s) { ui.post(() -> status.setText(s)); }

    private int indexOf(String t) {
        String[] all = {"UDP", "TCP", "TLS", "WSS"};
        for (int i = 0; i < all.length; i++) if (all[i].equals(t)) return i;
        return 0;
    }

    private EditText field(LinearLayout parent, String hint, int inputType, String value) {
        EditText e = new EditText(this);
        e.setHint(hint);
        e.setInputType(inputType);
        if (value != null && !value.isEmpty()) e.setText(value);
        parent.addView(e);
        return e;
    }

    private LinearLayout.LayoutParams eqWidth() {
        return new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f);
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }
}
