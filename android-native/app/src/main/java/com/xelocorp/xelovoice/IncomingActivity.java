package com.xelocorp.xelovoice;

import android.app.Activity;
import android.os.Build;
import android.os.Bundle;
import android.view.Gravity;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

import com.xelocorp.xelovoice.sip.SipService;

/**
 * Full-screen incoming-call screen, launched via a full-screen-intent
 * notification so it rings and shows even over the lock screen when the app is
 * minimised or closed (as long as the foreground SipService is registered).
 */
public class IncomingActivity extends Activity {

    public static final String EXTRA_FROM = "from";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        showWhenLockedAndTurnScreenOn();

        String from = getIntent() != null ? getIntent().getStringExtra(EXTRA_FROM) : null;
        if (from == null) from = "Unknown";

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER);
        int pad = Math.round(24 * getResources().getDisplayMetrics().density);
        root.setPadding(pad, pad, pad, pad);

        TextView label = new TextView(this);
        label.setText("Incoming call");
        label.setTextSize(18);
        label.setGravity(Gravity.CENTER);
        root.addView(label);

        TextView caller = new TextView(this);
        caller.setText(from);
        caller.setTextSize(30);
        caller.setGravity(Gravity.CENTER);
        caller.setPadding(0, pad, 0, pad * 2);
        root.addView(caller);

        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        Button decline = new Button(this);
        decline.setText("Decline");
        decline.setOnClickListener(v -> { SipService.decline(this); finish(); });
        Button accept = new Button(this);
        accept.setText("Accept");
        accept.setOnClickListener(v -> {
            SipService.answer(this);
            startActivity(new android.content.Intent(this, MainActivity.class));
            finish();
        });
        LinearLayout.LayoutParams lp =
                new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f);
        row.addView(decline, lp);
        row.addView(accept, lp);
        root.addView(row);

        setContentView(root);
    }

    private void showWhenLockedAndTurnScreenOn() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true);
            setTurnScreenOn(true);
        } else {
            getWindow().addFlags(
                    WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED
                            | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON
                            | WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        }
    }
}
