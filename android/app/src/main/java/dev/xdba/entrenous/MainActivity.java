package dev.xdba.entrenous;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(EntreNousPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
