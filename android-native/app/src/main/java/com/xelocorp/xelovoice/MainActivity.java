package com.xelocorp.xelovoice;

import android.app.Activity;
import android.os.Bundle;
import android.widget.TextView;

// Milestone-0 placeholder UI. Establishes the native build toolchain; the
// pjsua2 engine, foreground service, Compose UI and telemetry are layered in
// per docs/NATIVE_SOFTPHONE.md.
public class MainActivity extends Activity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        TextView tv = new TextView(this);
        tv.setText("XeloVoice — native softphone (build scaffold)");
        tv.setPadding(48, 48, 48, 48);
        setContentView(tv);
    }
}
