package dev.xdba.entrenous;

import android.content.res.Configuration;
import android.os.Bundle;
import androidx.lifecycle.Lifecycle;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.PluginHandle;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(EntreNousPlugin.class);
        super.onCreate(savedInstanceState);
    }

    private EntreNousPlugin plugin() {
        PluginHandle h = getBridge() == null ? null : getBridge().getPlugin("EntreNous");
        return h == null ? null : (EntreNousPlugin) h.getInstance();
    }

    /** Picture-in-picture of a video: in, out, or dismissed (the activity is then stopped). */
    @Override
    public void onPictureInPictureModeChanged(boolean inPip, Configuration newConfig) {
        super.onPictureInPictureModeChanged(inPip, newConfig);
        EntreNousPlugin p = plugin();
        if (p != null) p.onPipChanged(inPip, !inPip && getLifecycle().getCurrentState() == Lifecycle.State.CREATED);
    }

    @Override
    protected void onUserLeaveHint() {
        super.onUserLeaveHint();
        EntreNousPlugin p = plugin();
        if (p != null) p.onUserLeaving();
    }
}
