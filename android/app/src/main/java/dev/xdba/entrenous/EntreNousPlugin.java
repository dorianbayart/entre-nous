package dev.xdba.entrenous;

import android.content.ClipData;
import android.content.ClipDescription;
import android.content.ClipboardManager;
import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.PersistableBundle;
import android.provider.OpenableColumns;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import androidx.activity.OnBackPressedCallback;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Native side of Entre Nous on Android. The web UI (bundled in the app, never downloaded)
 * holds the end-to-end encryption; this plugin only does what a web page cannot:
 *  - key storage encrypted by the Android Keystore (the keys never leave the device);
 *  - clipboard without a tap, marked sensitive;
 *  - received files (shared through the share sheet), and the "Share -> Entre Nous" entry;
 *  - invitation links (App Links), the back button, foreground / background.
 */
@CapacitorPlugin(name = "EntreNous")
public class EntreNousPlugin extends Plugin {

    private static final String KEY_ALIAS = "entrenous-kv";
    private static final String SENSITIVE = "android.content.extra.IS_SENSITIVE";
    private static final long KEEP_FILES_MS = 8L * 24 * 3600 * 1000; // longer than any retention

    private SharedPreferences prefs;
    private final Map<String, File> files = new ConcurrentHashMap<>();
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService io = Executors.newSingleThreadExecutor();

    @Override
    public void load() {
        prefs = getContext().getSharedPreferences("entrenous", Context.MODE_PRIVATE);
        io.execute(this::purgeOldFiles);
        getActivity()
            .getOnBackPressedDispatcher()
            .addCallback(
                getActivity(),
                new OnBackPressedCallback(true) {
                    @Override
                    public void handleOnBackPressed() {
                        notifyListeners("back", new JSObject());
                    }
                }
            );
        handleIntent(getActivity().getIntent());
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        handleIntent(intent);
    }

    @Override
    protected void handleOnStart() {
        JSObject o = new JSObject();
        o.put("active", true);
        notifyListeners("appState", o);
    }

    @Override
    protected void handleOnStop() {
        JSObject o = new JSObject();
        o.put("active", false);
        notifyListeners("appState", o);
    }

    // ------------------------------------------------------------------ device

    @PluginMethod
    public void info(PluginCall call) {
        JSObject o = new JSObject();
        o.put("model", Build.MODEL);
        call.resolve(o);
    }

    /** Back button on the main screen: the app goes to the background (like Home). */
    @PluginMethod
    public void background(PluginCall call) {
        main.post(() -> getActivity().moveTaskToBack(true));
        call.resolve();
    }

    /** During a transfer: the screen stays on (a sleeping phone suspends the app). */
    @PluginMethod
    public void keepAwake(PluginCall call) {
        boolean on = Boolean.TRUE.equals(call.getBoolean("on", false));
        main.post(() -> {
            if (on) getActivity().getWindow().addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            else getActivity().getWindow().clearFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        });
        call.resolve();
    }

    // ------------------------------------------------------------------ key storage

    private SecretKey key() throws Exception {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
        ks.load(null);
        if (ks.containsAlias(KEY_ALIAS)) {
            return ((KeyStore.SecretKeyEntry) ks.getEntry(KEY_ALIAS, null)).getSecretKey();
        }
        KeyGenerator kg = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        kg.init(
            new KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build()
        );
        return kg.generateKey();
    }

    @PluginMethod
    public void kvGet(PluginCall call) {
        String name = call.getString("key", "");
        String stored = prefs.getString(name, null);
        JSObject o = new JSObject();
        if (stored == null) {
            o.put("value", JSObject.NULL);
            call.resolve(o);
            return;
        }
        try {
            byte[] all = Base64.decode(stored, Base64.NO_WRAP);
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, all, 0, 12));
            c.updateAAD(name.getBytes(StandardCharsets.UTF_8)); // a value only opens under its own name
            byte[] plain = c.doFinal(all, 12, all.length - 12);
            o.put("value", new String(plain, StandardCharsets.UTF_8));
            call.resolve(o);
        } catch (Exception e) {
            call.reject("unreadable value: " + e.getMessage());
        }
    }

    @PluginMethod
    public void kvSet(PluginCall call) {
        String name = call.getString("key", "");
        String value = call.getString("value", "");
        try {
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.ENCRYPT_MODE, key());
            c.updateAAD(name.getBytes(StandardCharsets.UTF_8));
            byte[] ct = c.doFinal(value.getBytes(StandardCharsets.UTF_8));
            byte[] iv = c.getIV();
            byte[] all = new byte[iv.length + ct.length];
            System.arraycopy(iv, 0, all, 0, iv.length);
            System.arraycopy(ct, 0, all, iv.length, ct.length);
            prefs.edit().putString(name, Base64.encodeToString(all, Base64.NO_WRAP)).commit();
            call.resolve();
        } catch (Exception e) {
            call.reject("cannot store: " + e.getMessage());
        }
    }

    @PluginMethod
    public void kvDel(PluginCall call) {
        prefs.edit().remove(call.getString("key", "")).commit();
        call.resolve();
    }

    // ------------------------------------------------------------------ clipboard

    private ClipboardManager clipboard() {
        return (ClipboardManager) getContext().getSystemService(Context.CLIPBOARD_SERVICE);
    }

    private Uri fileUri(File f) {
        return FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", f);
    }

    /** Writes text or an image; marked sensitive (no preview). */
    @PluginMethod
    public void clipWrite(PluginCall call) {
        String kind = call.getString("kind", "text");
        String label = "entrenous-" + UUID.randomUUID();
        ClipData clip;
        try {
            if ("image".equals(kind)) {
                String mime = call.getString("mime", "image/png");
                File dir = new File(getContext().getCacheDir(), "clip");
                deleteTree(dir); // only the last image is kept
                dir.mkdirs();
                File f = new File(dir, "image." + extension(mime));
                try (OutputStream out = new FileOutputStream(f)) {
                    out.write(decode(call.getString("data", "")));
                }
                clip = ClipData.newUri(getContext().getContentResolver(), label, fileUri(f));
            } else {
                clip = ClipData.newPlainText(label, call.getString("text", ""));
            }
        } catch (Exception e) {
            call.reject("clipboard: " + e.getMessage());
            return;
        }
        PersistableBundle extras = new PersistableBundle();
        extras.putBoolean(SENSITIVE, true);
        clip.getDescription().setExtras(extras);
        final ClipData toWrite = clip;
        main.post(() -> {
            clipboard().setPrimaryClip(toWrite);
            call.resolve();
        });
    }

    /** Reads the clipboard (the app is in the foreground: a tap on "Send the clipboard"). */
    @PluginMethod
    public void clipRead(PluginCall call) {
        main.post(() -> {
            JSObject o = new JSObject();
            ClipData clip = clipboard().getPrimaryClip();
            if (clip == null || clip.getItemCount() == 0) {
                o.put("kind", "none");
                call.resolve(o);
                return;
            }
            ClipData.Item item = clip.getItemAt(0);
            Uri uri = item.getUri();
            String mime = uri != null ? getContext().getContentResolver().getType(uri) : null;
            if (uri != null && mime != null && mime.startsWith("image/")) {
                io.execute(() -> {
                    try (InputStream in = getContext().getContentResolver().openInputStream(uri)) {
                        o.put("kind", "image");
                        o.put("mime", mime);
                        o.put("data", encode(readAll(in)));
                        call.resolve(o);
                    } catch (Exception e) {
                        call.reject("clipboard: " + e.getMessage());
                    }
                });
                return;
            }
            CharSequence text = item.coerceToText(getContext());
            o.put("kind", text == null || text.length() == 0 ? "none" : "text");
            o.put("text", text == null ? "" : text.toString());
            call.resolve(o);
        });
    }

    // ------------------------------------------------------------------ files

    /** A received file, written piece by piece, then offered through the share sheet. */
    @PluginMethod
    public void fileCreate(PluginCall call) {
        String token = UUID.randomUUID().toString();
        File dir = new File(new File(getContext().getCacheDir(), "received"), token);
        dir.mkdirs();
        File f = new File(dir, safeName(call.getString("name", "fichier")));
        files.put(token, f);
        JSObject o = new JSObject();
        o.put("token", token);
        call.resolve(o);
    }

    @PluginMethod
    public void fileAppend(PluginCall call) {
        File f = files.get(call.getString("token", ""));
        if (f == null) {
            call.reject("unknown file");
            return;
        }
        try (OutputStream out = new FileOutputStream(f, true)) {
            out.write(decode(call.getString("data", "")));
            call.resolve();
        } catch (Exception e) {
            call.reject("file: " + e.getMessage());
        }
    }

    @PluginMethod
    public void fileShare(PluginCall call) {
        File f = files.get(call.getString("token", ""));
        if (f == null) {
            call.reject("unknown file");
            return;
        }
        Intent send = new Intent(Intent.ACTION_SEND);
        send.setType(call.getString("mime", "application/octet-stream"));
        send.putExtra(Intent.EXTRA_STREAM, fileUri(f));
        send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        Intent chooser = Intent.createChooser(send, f.getName());
        chooser.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        main.post(() -> {
            getActivity().startActivity(chooser);
            call.resolve();
        });
    }

    /** Reads a shared file (from "Share -> Entre Nous"), piece by piece. */
    @PluginMethod
    public void fileRead(PluginCall call) {
        File f = files.get(call.getString("token", ""));
        if (f == null) {
            call.reject("unknown file");
            return;
        }
        long offset = call.getLong("offset", 0L);
        int length = call.getInt("length", 512 * 1024);
        try (RandomAccessFile raf = new RandomAccessFile(f, "r")) {
            long left = Math.max(0, raf.length() - offset);
            byte[] buf = new byte[(int) Math.min(length, left)];
            raf.seek(offset);
            raf.readFully(buf);
            JSObject o = new JSObject();
            o.put("data", encode(buf));
            call.resolve(o);
        } catch (Exception e) {
            call.reject("file: " + e.getMessage());
        }
    }

    /** A shared file has been sent: its copy goes. */
    @PluginMethod
    public void fileDelete(PluginCall call) {
        File f = files.remove(call.getString("token", ""));
        if (f != null) deleteTree(f.getParentFile());
        call.resolve();
    }

    // ------------------------------------------------------------------ intents

    private void handleIntent(Intent intent) {
        if (intent == null || intent.getAction() == null) return;
        String action = intent.getAction();
        if (Intent.ACTION_VIEW.equals(action) && intent.getData() != null) {
            JSObject o = new JSObject();
            o.put("url", intent.getData().toString());
            notifyListeners("link", o, true);
        } else if (Intent.ACTION_SEND.equals(action) || Intent.ACTION_SEND_MULTIPLE.equals(action)) {
            List<Uri> uris = new ArrayList<>();
            if (Intent.ACTION_SEND.equals(action)) {
                Uri u = intent.getParcelableExtra(Intent.EXTRA_STREAM);
                if (u != null) uris.add(u);
            } else {
                ArrayList<Uri> list = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
                if (list != null) uris.addAll(list);
            }
            String text = intent.getStringExtra(Intent.EXTRA_TEXT);
            io.execute(() -> {
                JSObject o = new JSObject();
                JSArray list = new JSArray();
                for (Uri u : uris) {
                    JSObject f = copyShared(u);
                    if (f != null) list.put(f);
                }
                o.put("files", list);
                o.put("text", uris.isEmpty() && text != null ? text : "");
                notifyListeners("share", o, true);
            });
        }
        intent.setAction(null); // handled once, not again on a configuration change
    }

    /** Copies a shared content:// item into the app's cache so the web side can read it. */
    private JSObject copyShared(Uri uri) {
        ContentResolver cr = getContext().getContentResolver();
        String name = "partage";
        try (Cursor c = cr.query(uri, new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null)) {
            if (c != null && c.moveToFirst() && c.getString(0) != null) name = c.getString(0);
        } catch (Exception ignored) {}
        String token = UUID.randomUUID().toString();
        File dir = new File(new File(getContext().getCacheDir(), "shared"), token);
        dir.mkdirs();
        File f = new File(dir, safeName(name));
        try (InputStream in = cr.openInputStream(uri); OutputStream out = new FileOutputStream(f)) {
            if (in == null) return null;
            byte[] buf = new byte[256 * 1024];
            for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
        } catch (Exception e) {
            deleteTree(dir);
            return null;
        }
        files.put(token, f);
        String mime = cr.getType(uri);
        JSObject o = new JSObject();
        o.put("token", token);
        o.put("name", f.getName());
        o.put("mime", mime == null ? "application/octet-stream" : mime);
        o.put("size", f.length());
        return o;
    }

    // ------------------------------------------------------------------ helpers

    private void purgeOldFiles() {
        long limit = System.currentTimeMillis() - KEEP_FILES_MS;
        for (String sub : new String[] { "received", "shared" }) {
            File[] dirs = new File(getContext().getCacheDir(), sub).listFiles();
            if (dirs == null) continue;
            for (File d : dirs) if (d.lastModified() < limit) deleteTree(d);
        }
    }

    private static void deleteTree(File f) {
        if (f == null || !f.exists()) return;
        File[] children = f.listFiles();
        if (children != null) for (File c : children) deleteTree(c);
        f.delete();
    }

    private static String safeName(String name) {
        String n = name.replaceAll("[/\\\\:\\x00]", "_").trim();
        return n.isEmpty() ? "fichier" : n;
    }

    private static String extension(String mime) {
        switch (mime) {
            case "image/jpeg":
                return "jpg";
            case "image/gif":
                return "gif";
            case "image/webp":
                return "webp";
            case "image/heic":
                return "heic";
            default:
                return "png";
        }
    }

    private static byte[] readAll(InputStream in) throws Exception {
        java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
        byte[] buf = new byte[256 * 1024];
        for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
        return out.toByteArray();
    }

    /** The web side uses base64url (no padding). */
    private static byte[] decode(String s) {
        return Base64.decode(s, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
    }

    private static String encode(byte[] b) {
        return Base64.encodeToString(b, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
    }
}
