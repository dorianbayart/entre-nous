package dev.xdba.entrenous;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.PictureInPictureParams;
import android.app.RemoteAction;
import android.content.BroadcastReceiver;
import android.content.ClipData;
import android.content.ClipDescription;
import android.content.ClipboardManager;
import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.Icon;
import android.media.MediaMetadata;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.os.PersistableBundle;
import android.os.ParcelFileDescriptor;
import android.provider.DocumentsContract;
import android.provider.OpenableColumns;
import android.webkit.MimeTypeMap;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.annotation.ActivityCallback;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import android.util.Rational;
import androidx.activity.OnBackPressedCallback;
import androidx.annotation.RequiresApi;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
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
 *  - invitation links (App Links), the back button, foreground / background;
 *  - picture-in-picture of a video (the WebView has none): the app becomes the small window.
 */
@CapacitorPlugin(name = "EntreNous")
public class EntreNousPlugin extends Plugin {

    private static final String KEY_ALIAS = "entrenous-kv";
    private static final String SENSITIVE = "android.content.extra.IS_SENSITIVE";
    private static final long KEEP_FILES_MS = 8L * 24 * 3600 * 1000; // longer than any retention

    private SharedPreferences prefs;
    private final Map<String, File> files = new ConcurrentHashMap<>();
    /** Documents of a folder (Android's folder picker): files read or written, folders created. */
    private final Map<String, Uri> docs = new ConcurrentHashMap<>();
    /** A folder being saved: its folders already made, by path ("" is the folder itself). */
    private final Map<String, Map<String, Uri>> saving = new ConcurrentHashMap<>();
    /** Files of a folder being saved, open until written (cloud folders refuse appending). */
    private final Map<String, OutputStream> writing = new ConcurrentHashMap<>();
    /** Files read in a folder at most (a whole storage picked by mistake stops there). */
    private static final int FOLDER_MAX = 100_000;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService io = Executors.newSingleThreadExecutor();

    @Override
    public void load() {
        prefs = getContext().getSharedPreferences("entrenous", Context.MODE_PRIVATE);
        registerPipReceiver();
        registerMediaReceiver();
        io.execute(() -> {
            deleteTree(new File(getContext().getCacheDir(), "opened")); // left by a closed app
            purgeOldFiles();
        });
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
        o.put("pip", pipSupported());
        String store = store();
        if (store != null) o.put("store", store);
        call.resolve(o);
    }

    /** The stores that update the app themselves: installed by one, the app links to no APK. */
    private static final Set<String> PLAY = new HashSet<>(Arrays.asList(
        "com.android.vending", // Google Play
        "com.aurora.store" // Aurora Store (Google Play's version)
    ));
    private static final Set<String> FDROID = new HashSet<>(Arrays.asList(
        "org.fdroid.fdroid", "org.fdroid.basic", // F-Droid
        "com.looker.droidify", // Droid-ify
        "com.machiav3lli.fdroid" // Neo Store
    ));
    private static final Set<String> OBTAINIUM = new HashSet<>(Arrays.asList(
        "dev.imranr.obtainium", "dev.imranr.obtainium.fdroid" // follows the releases
    ));

    /** The store that installed the app ("play", "fdroid", "obtainium"), null for a downloaded APK. */
    @SuppressWarnings("deprecation")
    private String store() {
        Context c = getContext();
        try {
            String installer = Build.VERSION.SDK_INT >= Build.VERSION_CODES.R
                ? c.getPackageManager().getInstallSourceInfo(c.getPackageName()).getInstallingPackageName()
                : c.getPackageManager().getInstallerPackageName(c.getPackageName());
            if (installer == null) return null;
            if (PLAY.contains(installer)) return "play";
            if (FDROID.contains(installer)) return "fdroid";
            if (OBTAINIUM.contains(installer)) return "obtainium";
            return null;
        } catch (Exception e) {
            return null;
        }
    }

    /** Back button on the main screen: the app goes to the background (like Home). */
    @PluginMethod
    public void background(PluginCall call) {
        main.post(() -> getActivity().moveTaskToBack(true));
        call.resolve();
    }

    /** A web link of the history: opened in the browser (or the app that handles it). */
    @PluginMethod
    public void openUrl(PluginCall call) {
        Uri uri = Uri.parse(call.getString("url", ""));
        if (!"http".equals(uri.getScheme()) && !"https".equals(uri.getScheme())) {
            call.reject("not a web link");
            return;
        }
        try {
            getActivity().startActivity(new Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE));
            call.resolve();
        } catch (android.content.ActivityNotFoundException e) {
            call.reject("no app opens this link");
        }
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
        String folder = call.getString("folder");
        if (folder != null) {
            // a file of a folder being saved: a document in the folder picked
            io.execute(() -> {
                try {
                    String path = call.getString("path", "");
                    int slash = path.lastIndexOf('/');
                    Uri dir = folderDir(folder, slash < 0 ? "" : path.substring(0, slash));
                    String name = safeName(path.substring(slash + 1));
                    Uri doc = DocumentsContract.createDocument(getContext().getContentResolver(), dir, mimeOf(name), name);
                    if (doc == null) throw new Exception("cannot create " + name);
                    OutputStream out = getContext().getContentResolver().openOutputStream(doc, "w");
                    if (out == null) throw new Exception("cannot write " + name);
                    String token = UUID.randomUUID().toString();
                    writing.put(token, out);
                    JSObject o = new JSObject();
                    o.put("token", token);
                    call.resolve(o);
                } catch (Exception e) {
                    call.reject("file: " + e.getMessage());
                }
            });
            return;
        }
        String token = UUID.randomUUID().toString();
        // a copy given to another app: deleted when the app closes
        String where = Boolean.TRUE.equals(call.getBoolean("open", false)) ? "opened" : "received";
        File dir = new File(new File(getContext().getCacheDir(), where), token);
        dir.mkdirs();
        File f = new File(dir, safeName(call.getString("name", "fichier")));
        files.put(token, f);
        JSObject o = new JSObject();
        o.put("token", token);
        call.resolve(o);
    }

    @PluginMethod
    public void fileAppend(PluginCall call) {
        OutputStream stream = writing.get(call.getString("token", ""));
        if (stream != null) {
            try {
                stream.write(decode(call.getString("data", "")));
                call.resolve();
            } catch (Exception e) {
                call.reject("file: " + e.getMessage());
            }
            return;
        }
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

    /** A received file, opened by its app (Android asks which one when there is no default). */
    @PluginMethod
    public void fileOpen(PluginCall call) {
        File f = files.get(call.getString("token", ""));
        if (f == null) {
            call.reject("unknown file");
            return;
        }
        Intent view = new Intent(Intent.ACTION_VIEW);
        view.setDataAndType(fileUri(f), call.getString("mime", "application/octet-stream"));
        view.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        main.post(() -> {
            try {
                getActivity().startActivity(view);
                call.resolve();
            } catch (android.content.ActivityNotFoundException e) {
                call.reject("no app opens this file", "NO_APP");
            }
        });
    }

    /** Reads a shared file (from "Share -> Entre Nous"), piece by piece. */
    @PluginMethod
    public void fileRead(PluginCall call) {
        Uri doc = docs.get(call.getString("token", ""));
        if (doc != null) {
            readDocument(call, doc);
            return;
        }
        File f = files.get(call.getString("token", ""));
        if (f == null) {
            call.reject("unknown file");
            return;
        }
        // not getLong: it gives the default for a number that fits in an int (any offset below 2 GB)
        long offset = call.getData().optLong("offset", 0L);
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

    /** A file of a folder being saved is complete. */
    @PluginMethod
    public void fileClose(PluginCall call) {
        OutputStream out = writing.remove(call.getString("token", ""));
        try {
            if (out != null) out.close();
            call.resolve();
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

    // ------------------------------------------------------------------ folders

    /** A folder to send: Android's folder picker, then its files (read later, through tokens). */
    @PluginMethod
    public void folderPick(PluginCall call) {
        startActivityForResult(call, new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE), "folderPicked");
    }

    @ActivityCallback
    private void folderPicked(PluginCall call, ActivityResult result) {
        Uri tree = result.getResultCode() == android.app.Activity.RESULT_OK && result.getData() != null ? result.getData().getData() : null;
        if (tree == null) {
            call.resolve(new JSObject());
            return;
        }
        io.execute(() -> {
            try {
                String rootId = DocumentsContract.getTreeDocumentId(tree);
                JSArray list = new JSArray();
                JSArray empty = new JSArray();
                JSObject o = new JSObject();
                o.put("kind", "folder");
                o.put("name", displayName(DocumentsContract.buildDocumentUriUsingTree(tree, rootId), "dossier"));
                try {
                    walk(tree, rootId, "", list, empty);
                    o.put("files", list);
                    o.put("dirs", empty);
                } catch (TooMany e) {
                    // too many: nothing is sent (the web UI says so)
                    o.put("files", new JSArray());
                    o.put("dirs", new JSArray());
                    o.put("truncated", true);
                }
                call.resolve(o);
            } catch (Exception e) {
                call.reject("folder: " + e.getMessage());
            }
        });
    }

    /** The files below a folder (depth first), with their paths; its empty folders. */
    private void walk(Uri tree, String id, String path, JSArray list, JSArray empty) {
        ContentResolver cr = getContext().getContentResolver();
        Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, id);
        String[] cols = {
            DocumentsContract.Document.COLUMN_DOCUMENT_ID,
            DocumentsContract.Document.COLUMN_DISPLAY_NAME,
            DocumentsContract.Document.COLUMN_MIME_TYPE,
            DocumentsContract.Document.COLUMN_SIZE,
        };
        boolean any = false;
        try (Cursor c = cr.query(children, cols, null, null, null)) {
            while (c != null && c.moveToNext()) {
                if (list.length() >= FOLDER_MAX) throw new TooMany();
                any = true;
                String child = c.getString(0);
                String name = c.getString(1) == null ? "fichier" : c.getString(1);
                String mime = c.getString(2) == null ? "application/octet-stream" : c.getString(2);
                String p = path.isEmpty() ? name : path + "/" + name;
                if (DocumentsContract.Document.MIME_TYPE_DIR.equals(mime)) {
                    walk(tree, child, p, list, empty);
                    continue;
                }
                String token = UUID.randomUUID().toString();
                docs.put(token, DocumentsContract.buildDocumentUriUsingTree(tree, child));
                JSObject f = new JSObject();
                f.put("token", token);
                f.put("path", p);
                f.put("size", c.isNull(3) ? 0 : c.getLong(3));
                f.put("mime", mime);
                list.put(f);
            }
        }
        if (!any && !path.isEmpty()) empty.put(path);
    }

    private static class TooMany extends RuntimeException {}

    /** A folder to save: where, asked with Android's folder picker; created there. */
    @PluginMethod
    public void folderCreate(PluginCall call) {
        startActivityForResult(call, new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE), "folderChosen");
    }

    @ActivityCallback
    private void folderChosen(PluginCall call, ActivityResult result) {
        Uri tree = result.getResultCode() == android.app.Activity.RESULT_OK && result.getData() != null ? result.getData().getData() : null;
        if (tree == null) {
            call.resolve(new JSObject());
            return;
        }
        io.execute(() -> {
            try {
                Uri parent = DocumentsContract.buildDocumentUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree));
                String name = safeName(call.getString("name", "dossier"));
                // Android gives another name ("Vacances (1)") if it exists
                Uri made = DocumentsContract.createDocument(getContext().getContentResolver(), parent, DocumentsContract.Document.MIME_TYPE_DIR, name);
                if (made == null) throw new Exception("cannot create " + name);
                String token = UUID.randomUUID().toString();
                Map<String, Uri> dirs = new ConcurrentHashMap<>();
                dirs.put("", made);
                saving.put(token, dirs);
                JSObject o = new JSObject();
                o.put("token", token);
                o.put("where", displayName(parent, "") + "/" + displayName(made, name));
                call.resolve(o);
            } catch (Exception e) {
                call.reject("folder: " + e.getMessage());
            }
        });
    }

    @PluginMethod
    public void folderMkdir(PluginCall call) {
        io.execute(() -> {
            try {
                folderDir(call.getString("folder", ""), call.getString("path", ""));
                call.resolve();
            } catch (Exception e) {
                call.reject("folder: " + e.getMessage());
            }
        });
    }

    /** The folder at `path` in a folder being saved, made level by level ("..": refused). */
    private Uri folderDir(String token, String path) throws Exception {
        Map<String, Uri> dirs = saving.get(token);
        if (dirs == null) throw new Exception("unknown folder");
        String at = "";
        Uri dir = dirs.get("");
        for (String part : path.split("/")) {
            if (part.isEmpty()) continue;
            String name = safeName(part);
            if (name.equals(".") || name.equals("..")) throw new Exception("bad path");
            at = at.isEmpty() ? name : at + "/" + name;
            Uri known = dirs.get(at);
            if (known == null) {
                known = DocumentsContract.createDocument(getContext().getContentResolver(), dir, DocumentsContract.Document.MIME_TYPE_DIR, name);
                if (known == null) throw new Exception("cannot create " + at);
                dirs.put(at, known);
            }
            dir = known;
        }
        return dir;
    }

    /** Bytes of a document, from `offset` (a file of a folder being sent). */
    private void readDocument(PluginCall call, Uri doc) {
        long offset = call.getData().optLong("offset", 0L);
        int length = call.getInt("length", 512 * 1024);
        try (ParcelFileDescriptor pfd = getContext().getContentResolver().openFileDescriptor(doc, "r");
             FileInputStream in = new FileInputStream(pfd.getFileDescriptor())) {
            FileChannel ch = in.getChannel();
            ch.position(offset);
            ByteBuffer buf = ByteBuffer.allocate(length);
            while (buf.hasRemaining() && ch.read(buf) > 0) {}
            byte[] out = new byte[buf.position()];
            buf.flip();
            buf.get(out);
            JSObject o = new JSObject();
            o.put("data", encode(out));
            call.resolve(o);
        } catch (Exception e) {
            call.reject("file: " + e.getMessage());
        }
    }

    private String displayName(Uri doc, String fallback) {
        try (Cursor c = getContext().getContentResolver().query(doc, new String[] { DocumentsContract.Document.COLUMN_DISPLAY_NAME }, null, null, null)) {
            if (c != null && c.moveToFirst() && c.getString(0) != null) return c.getString(0);
        } catch (Exception ignored) {}
        return fallback;
    }

    private static String mimeOf(String name) {
        int dot = name.lastIndexOf('.');
        String type = dot < 0 ? null : MimeTypeMap.getSingleton().getMimeTypeFromExtension(name.substring(dot + 1).toLowerCase());
        return type == null ? "application/octet-stream" : type;
    }

    // ------------------------------------------------------------------ picture-in-picture

    private static final String PIP_TOGGLE = "dev.xdba.entrenous.PIP_TOGGLE";
    /** Android accepts small windows between 1:2.39 and 2.39:1. */
    private static final float PIP_RATIO_MAX = 2.39f;
    private boolean pipPlaying = false;
    private Rational pipRatio = new Rational(16, 9);

    private boolean pipSupported() {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            && getContext().getPackageManager().hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE);
    }

    private void setRatio(PluginCall call) {
        int w = Math.max(1, call.getInt("width", 16));
        int h = Math.max(1, call.getInt("height", 9));
        float r = Math.max(1 / PIP_RATIO_MAX, Math.min(PIP_RATIO_MAX, (float) w / h));
        pipRatio = new Rational(Math.round(r * 1000), 1000);
    }

    /** The small window's shape, its play/pause button, and whether leaving the app opens it. */
    @RequiresApi(Build.VERSION_CODES.O)
    private PictureInPictureParams pipParams() {
        Context ctx = getContext();
        Intent toggle = new Intent(PIP_TOGGLE).setPackage(ctx.getPackageName());
        PendingIntent pi = PendingIntent.getBroadcast(ctx, 0, toggle, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        String label = pipPlaying ? "Pause" : "Lecture";
        Icon icon = Icon.createWithResource(ctx, pipPlaying ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play);
        List<RemoteAction> actions = new ArrayList<>();
        actions.add(new RemoteAction(icon, label, label, pi));
        PictureInPictureParams.Builder b = new PictureInPictureParams.Builder().setAspectRatio(pipRatio).setActions(actions);
        // Android 12 and later: a playing video turns into the small window when the app is left
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) b.setAutoEnterEnabled(pipPlaying).setSeamlessResizeEnabled(true);
        return b.build();
    }

    /** The play/pause button of the small window: handed over to the web side. */
    private void registerPipReceiver() {
        if (!pipSupported()) return;
        BroadcastReceiver receiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context c, Intent i) {
                notifyListeners("pipToggle", new JSObject());
            }
        };
        IntentFilter filter = new IntentFilter(PIP_TOGGLE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            getContext().registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED);
        } else {
            getContext().registerReceiver(receiver, filter);
        }
    }

    @PluginMethod
    public void pipEnter(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O || !pipSupported()) {
            call.reject("picture-in-picture not available");
            return;
        }
        setRatio(call);
        main.post(() -> {
            try {
                getActivity().enterPictureInPictureMode(pipParams());
                call.resolve();
            } catch (IllegalStateException | IllegalArgumentException e) {
                call.reject(e.getMessage());
            }
        });
    }

    /** Back to the full app (the web side leaves its video-only page). */
    @PluginMethod
    public void pipExit(PluginCall call) {
        main.post(() -> {
            Intent i = new Intent(getContext(), MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_REORDER_TO_FRONT);
            getActivity().startActivity(i);
        });
        call.resolve();
    }

    /** A video plays or not: the button of the small window, and the automatic entry. */
    @PluginMethod
    public void pipPlaying(PluginCall call) {
        pipPlaying = Boolean.TRUE.equals(call.getBoolean("on", false));
        setRatio(call);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && pipSupported()) {
            main.post(() -> {
                try {
                    getActivity().setPictureInPictureParams(pipParams());
                } catch (IllegalStateException | IllegalArgumentException ignored) {}
            });
        }
        call.resolve();
    }

    /** Android 8 to 11: leaving the app (Home) while a video plays opens the small window. */
    void onUserLeaving() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && Build.VERSION.SDK_INT < Build.VERSION_CODES.S && pipPlaying && pipSupported()) {
            try {
                getActivity().enterPictureInPictureMode(pipParams());
            } catch (IllegalStateException ignored) {}
        }
    }

    /** In or out of the small window; `closed`: dismissed (not expanded back to the app). */
    void onPipChanged(boolean active, boolean closed) {
        JSObject o = new JSObject();
        o.put("active", active);
        o.put("closed", closed);
        notifyListeners("pip", o);
    }

    // ------------------------------------------------------------------ now playing

    // The WebView tells the system nothing about what it plays: this media session gives the
    // song's name to a Bluetooth headset or car, the lock screen and the notification, and sends
    // their buttons to the page; a foreground service keeps the app playing in the background.

    private static final String MEDIA_ACTION = "dev.xdba.entrenous.MEDIA";
    private static final String MEDIA_CHANNEL = "playback";
    private MediaSession session;
    private boolean playbackService = false;
    private Bitmap mediaArt;

    @PluginMethod
    public void mediaSet(PluginCall call) {
        JSObject d = call.getData();
        String title = d.optString("title", "");
        String artist = d.optString("artist", "");
        String album = d.optString("album", "");
        long duration = Math.max(0, d.optLong("duration", 0));
        long position = Math.max(0, d.optLong("position", 0));
        boolean playing = d.optBoolean("playing", false);
        boolean hasNext = d.optBoolean("hasNext", false);
        main.post(() -> {
            try {
                showMedia(title, artist, album, duration, position, playing, hasNext);
            } catch (RuntimeException e) {
                // a service the system refuses to start (in the background): the session stays
            }
        });
        call.resolve();
    }

    @PluginMethod
    public void mediaClear(PluginCall call) {
        main.post(this::clearMedia);
        call.resolve();
    }

    @Override
    protected void handleOnDestroy() {
        clearMedia();
        deleteTree(new File(getContext().getCacheDir(), "opened"));
    }

    private void showMedia(String title, String artist, String album, long duration, long position, boolean playing, boolean hasNext) {
        Context ctx = getContext();
        if (session == null) {
            session = new MediaSession(ctx, "EntreNous");
            session.setCallback(
                new MediaSession.Callback() {
                    @Override
                    public void onPlay() {
                        mediaAction("play", -1);
                    }

                    @Override
                    public void onPause() {
                        mediaAction("pause", -1);
                    }

                    @Override
                    public void onStop() {
                        mediaAction("stop", -1);
                    }

                    @Override
                    public void onSkipToNext() {
                        mediaAction("next", -1);
                    }

                    @Override
                    public void onSkipToPrevious() {
                        mediaAction("prev", -1);
                    }

                    @Override
                    public void onSeekTo(long pos) {
                        mediaAction("seek", pos);
                    }
                }
            );
            session.setSessionActivity(openApp(ctx));
        }
        MediaMetadata.Builder meta = new MediaMetadata.Builder()
            .putString(MediaMetadata.METADATA_KEY_TITLE, title)
            .putString(MediaMetadata.METADATA_KEY_ARTIST, artist)
            .putString(MediaMetadata.METADATA_KEY_ALBUM, album)
            .putLong(MediaMetadata.METADATA_KEY_DURATION, duration);
        Bitmap art = mediaArt(ctx);
        if (art != null) meta.putBitmap(MediaMetadata.METADATA_KEY_ART, art);
        session.setMetadata(meta.build());
        long actions = PlaybackState.ACTION_PLAY | PlaybackState.ACTION_PAUSE | PlaybackState.ACTION_PLAY_PAUSE | PlaybackState.ACTION_STOP
            | PlaybackState.ACTION_SKIP_TO_PREVIOUS | PlaybackState.ACTION_SEEK_TO | (hasNext ? PlaybackState.ACTION_SKIP_TO_NEXT : 0);
        session.setPlaybackState(
            new PlaybackState.Builder()
                .setActions(actions)
                .setState(playing ? PlaybackState.STATE_PLAYING : PlaybackState.STATE_PAUSED, position, playing ? 1f : 0f, SystemClock.elapsedRealtime())
                .build()
        );
        session.setActive(true);

        Notification n = mediaNotification(ctx, title, album, art, playing, hasNext);
        PlaybackService.notification = n;
        if (!playbackService) {
            Intent service = new Intent(ctx, PlaybackService.class);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(service);
            else ctx.startService(service);
            playbackService = true;
        } else {
            ctx.getSystemService(NotificationManager.class).notify(PlaybackService.NOTIFICATION_ID, n);
        }
    }

    private void clearMedia() {
        Context ctx = getContext();
        if (session != null) {
            session.setActive(false);
            session.release();
            session = null;
        }
        if (playbackService) {
            ctx.stopService(new Intent(ctx, PlaybackService.class));
            playbackService = false;
        }
        PlaybackService.notification = null;
        ctx.getSystemService(NotificationManager.class).cancel(PlaybackService.NOTIFICATION_ID);
    }

    private void mediaAction(String action, long position) {
        JSObject o = new JSObject();
        o.put("action", action);
        if (position >= 0) o.put("position", position);
        notifyListeners("media", o);
    }

    /** The song's notification: its name, previous / play or pause / next. */
    private Notification mediaNotification(Context ctx, String title, String album, Bitmap art, boolean playing, boolean hasNext) {
        Notification.Builder b;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationManager nm = ctx.getSystemService(NotificationManager.class);
            if (nm.getNotificationChannel(MEDIA_CHANNEL) == null) {
                NotificationChannel ch = new NotificationChannel(MEDIA_CHANNEL, ctx.getString(R.string.media_channel), NotificationManager.IMPORTANCE_LOW);
                ch.setShowBadge(false);
                nm.createNotificationChannel(ch);
            }
            b = new Notification.Builder(ctx, MEDIA_CHANNEL);
        } else {
            b = new Notification.Builder(ctx);
        }
        b.setSmallIcon(R.drawable.ic_stat_music)
            .setContentTitle(title)
            .setContentText(album)
            .setContentIntent(openApp(ctx))
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .setShowWhen(false)
            .setOngoing(playing);
        if (art != null) b.setLargeIcon(art);
        b.addAction(mediaButton(ctx, "prev", android.R.drawable.ic_media_previous, R.string.media_prev));
        b.addAction(
            playing
                ? mediaButton(ctx, "pause", android.R.drawable.ic_media_pause, R.string.media_pause)
                : mediaButton(ctx, "play", android.R.drawable.ic_media_play, R.string.media_play)
        );
        if (hasNext) b.addAction(mediaButton(ctx, "next", android.R.drawable.ic_media_next, R.string.media_next));
        Notification.MediaStyle style = new Notification.MediaStyle().setMediaSession(session.getSessionToken());
        style.setShowActionsInCompactView(hasNext ? new int[] { 0, 1, 2 } : new int[] { 0, 1 });
        b.setStyle(style);
        return b.build();
    }

    private Notification.Action mediaButton(Context ctx, String action, int icon, int label) {
        Intent i = new Intent(MEDIA_ACTION).setPackage(ctx.getPackageName()).putExtra("action", action);
        PendingIntent pi = PendingIntent.getBroadcast(ctx, action.hashCode(), i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        return new Notification.Action.Builder(Icon.createWithResource(ctx, icon), ctx.getString(label), pi).build();
    }

    private static PendingIntent openApp(Context ctx) {
        Intent i = new Intent(ctx, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_REORDER_TO_FRONT);
        return PendingIntent.getActivity(ctx, 0, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    /** The app's icon, for the lock screen and the notification. */
    private Bitmap mediaArt(Context ctx) {
        if (mediaArt != null) return mediaArt;
        try {
            Drawable icon = ctx.getPackageManager().getApplicationIcon(ctx.getPackageName());
            Bitmap bmp = Bitmap.createBitmap(256, 256, Bitmap.Config.ARGB_8888);
            Canvas c = new Canvas(bmp);
            icon.setBounds(0, 0, 256, 256);
            icon.draw(c);
            mediaArt = bmp;
        } catch (PackageManager.NameNotFoundException ignored) {}
        return mediaArt;
    }

    /** The notification's buttons: handed over to the web side. */
    private void registerMediaReceiver() {
        BroadcastReceiver receiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context c, Intent i) {
                String action = i.getStringExtra("action");
                if (action != null) mediaAction(action, -1);
            }
        };
        IntentFilter filter = new IntentFilter(MEDIA_ACTION);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            getContext().registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED);
        } else {
            getContext().registerReceiver(receiver, filter);
        }
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
