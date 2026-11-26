package dev.xdba.entrenous;

import android.app.Notification;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

/**
 * A song plays in the page: keeps the app alive in the background (screen locked, another app
 * in front), with the song's notification. The media session itself is the plugin's.
 */
public class PlaybackService extends Service {

    static final int NOTIFICATION_ID = 7;
    /** The notification to show, set by the plugin before it starts the service. */
    static volatile Notification notification;

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        Notification n = notification;
        if (n == null) {
            stopSelf();
            return START_NOT_STICKY;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
        } else {
            startForeground(NOTIFICATION_ID, n);
        }
        return START_NOT_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    /** The app swiped away from the recent apps: the song stops with it. */
    @Override
    public void onTaskRemoved(Intent rootIntent) {
        stopSelf();
    }
}
