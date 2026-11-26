//! Entre Nous for Linux and Windows: the same web UI as the Mac app, bundled (never
//! downloaded: the code that holds the keys does not come from the server), shown in the
//! system web view (WebKitGTK, WebView2), with an icon in the tray.
//! The native side owns the clipboard, the secure storage and the received files, and answers
//! the same calls as the Mac app (web/src/platform/desktop.ts).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod clip;
mod files;
mod l10n;
mod store;

use base64::engine::{general_purpose::GeneralPurposeConfig, DecodePaddingMode, GeneralPurpose};
use base64::{alphabet, Engine as _};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{
    AppHandle, LogicalSize, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder, WindowEvent, Wry,
};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt as _};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;

/// The relay built in (ENTRENOUS_RELAY at build time, for a relay of one's own).
const DEFAULT_RELAY: &str = match option_env!("ENTRENOUS_RELAY") {
    Some(r) if !r.is_empty() => r,
    _ => "https://entrenous.0xdba.dev",
};

/// base64url without padding, like the web code (core/bytes.ts).
pub const B64: GeneralPurpose = GeneralPurpose::new(
    &alphabet::URL_SAFE,
    GeneralPurposeConfig::new().with_encode_padding(false).with_decode_padding_mode(DecodePaddingMode::Indifferent),
);

pub struct Bridge {
    store: Mutex<store::Store>,
    pub clip: clip::Clip,
    pub files: files::Files,
    /// Pause state, set by the web UI (which keeps it in its preferences).
    pub paused: AtomicBool,
    awake: Mutex<Option<Awake>>,
    menu: Mutex<Option<TrayMenu>>,
    /// In picture-in-picture: the window's size and place before, to go back to.
    pip: Mutex<Option<(PhysicalSize<u32>, PhysicalPosition<i32>)>>,
}

/// The window of the app, its normal minimum size.
const MIN_SIZE: (f64, f64) = (340.0, 480.0);
/// Picture-in-picture: the width of the small window, its gap to the screen's edges.
const PIP_WIDTH: f64 = 400.0;
const PIP_MARGIN: f64 = 24.0;

/// Picture-in-picture, as the web views of Linux and Windows have none: the window shrinks to
/// the video (`width` × `height`, its pixels) in the bottom right corner, above the others.
/// It keeps its frame, to be moved, resized or closed like any window.
fn pip_enter(app: &AppHandle, width: f64, height: f64) -> tauri::Result<()> {
    let Some(w) = app.get_webview_window("main") else { return Ok(()) };
    let b = app.state::<Bridge>();
    let mut saved = b.pip.lock().unwrap();
    if saved.is_none() {
        *saved = Some((w.inner_size()?, w.outer_position()?));
    }
    let ratio = if width > 0.0 && height > 0.0 { height / width } else { 9.0 / 16.0 };
    let size = LogicalSize::new(PIP_WIDTH, (PIP_WIDTH * ratio).round());
    // the frame around the content, measured before resizing (X11 applies a new size later:
    // the window's own size cannot be read back at once)
    let (inner, outer) = (w.inner_size()?, w.outer_size()?);
    let frame = (outer.width.saturating_sub(inner.width), outer.height.saturating_sub(inner.height));
    w.set_min_size(None::<LogicalSize<f64>>)?;
    w.set_size(size)?;
    w.set_always_on_top(true)?;
    if let Some(m) = w.current_monitor()? {
        let scale = m.scale_factor();
        let area = m.work_area();
        let target = size.to_physical::<u32>(scale);
        let margin = (PIP_MARGIN * scale) as i32;
        let x = area.position.x + area.size.width as i32 - (target.width + frame.0) as i32 - margin;
        let y = area.position.y + area.size.height as i32 - (target.height + frame.1) as i32 - margin;
        w.set_position(PhysicalPosition::new(x.max(area.position.x), y.max(area.position.y)))?;
    }
    w.unminimize()?;
    w.show()?;
    Ok(())
}

/// Back to the full window, where it was.
fn pip_exit(app: &AppHandle) -> tauri::Result<bool> {
    let Some(w) = app.get_webview_window("main") else { return Ok(false) };
    let Some((size, position)) = app.state::<Bridge>().pip.lock().unwrap().take() else { return Ok(false) };
    w.set_always_on_top(false)?;
    w.set_size(size)?;
    w.set_position(position)?;
    w.set_min_size(Some(LogicalSize::new(MIN_SIZE.0, MIN_SIZE.1)))?;
    Ok(true)
}

/// The items of the tray menu, relabelled when the language or the pause changes.
struct TrayMenu {
    open: MenuItem<Wry>,
    pause: MenuItem<Wry>,
    reload: MenuItem<Wry>,
    quit: MenuItem<Wry>,
}

/// The tray menu and tooltip in the current language, for the current pause state.
fn relabel(app: &AppHandle) {
    let b = app.state::<Bridge>();
    let paused = b.paused.load(Ordering::SeqCst);
    if let Some(m) = b.menu.lock().unwrap().as_ref() {
        let _ = m.open.set_text(l10n::t("open"));
        let _ = m.pause.set_text(l10n::t(if paused { "resume" } else { "pause" }));
        let _ = m.reload.set_text(l10n::t("reload"));
        let _ = m.quit.set_text(l10n::t("quit"));
    }
    if let Some(tray) = app.tray_by_id("main") {
        let _ = tray.set_tooltip(Some(if paused { l10n::t("paused") } else { "Entre Nous" }));
    }
}

/// Keeps the computer awake during a transfer (the guard is dropped on its own thread).
struct Awake(std::sync::mpsc::Sender<()>);

impl Awake {
    fn start() -> Awake {
        let (tx, rx) = std::sync::mpsc::channel::<()>();
        std::thread::spawn(move || {
            let _guard = keepawake::Builder::default()
                .idle(true)
                .reason("Transfert Entre Nous en cours")
                .app_name("Entre Nous")
                .app_reverse_domain("dev.xdba.entrenous")
                .create();
            let _ = rx.recv(); // until stopped
        });
        Awake(tx)
    }
}

impl Drop for Awake {
    fn drop(&mut self) {
        let _ = self.0.send(());
    }
}

/// Relay: ENTRENOUS_RELAY in the environment, else a `relay` file in the config folder
/// (~/.config/dev.xdba.entrenous/relay, %APPDATA%\dev.xdba.entrenous\relay), else the default.
fn relay_url(app: &AppHandle) -> String {
    if let Ok(r) = std::env::var("ENTRENOUS_RELAY") {
        if !r.trim().is_empty() {
            return r.trim().to_string();
        }
    }
    let file = app.path().app_config_dir().ok().map(|d| d.join("relay"));
    if let Some(r) = file.and_then(|f| std::fs::read_to_string(f).ok()) {
        if !r.trim().is_empty() {
            return r.trim().to_string();
        }
    }
    DEFAULT_RELAY.to_string()
}

/// Native -> JS event.
pub fn emit(app: &AppHandle, name: &str, payload: Value) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.eval(format!("window.__entrenous && window.__entrenous.event({}, {})", json!(name), payload));
    }
}

fn show(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn toggle(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        if w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false) {
            let _ = w.hide();
        } else {
            show(app);
        }
    }
}

// ------------------------------------------------------------------ JS -> native

#[tauri::command]
async fn native(app: AppHandle, msg: Value) -> Result<Value, String> {
    handle(&app, &msg)
}

fn handle(app: &AppHandle, a: &Value) -> Result<Value, String> {
    let b = app.state::<Bridge>();
    let s = |k: &str| a.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    let cmd = s("cmd");
    match cmd.as_str() {
        "kvGet" => Ok(b.store.lock().unwrap().get(&s("key"))?.map(Value::from).unwrap_or(Value::Null)),
        "kvSet" => {
            b.store.lock().unwrap().set(&s("key"), &s("value"))?;
            Ok(json!(true))
        }
        "kvDel" => {
            b.store.lock().unwrap().delete(&s("key"));
            Ok(json!(true))
        }

        "clipWrite" => {
            match s("kind").as_str() {
                "text" => b.clip.write_text(&s("text"))?,
                "image" => b.clip.write_image(&B64.decode(s("data")).map_err(|_| "bad image")?)?,
                "file" => b.clip.write_file(&b.files.path(&s("token")).ok_or("unknown file")?)?,
                _ => return Err("bad kind".into()),
            }
            Ok(json!(true))
        }
        "clipRead" => Ok(b.clip.read(|p| b.files.register(p)).unwrap_or(Value::Null)),

        "notify" => {
            // only while the window is not in front; never the content itself
            let front = app
                .get_webview_window("main")
                .is_some_and(|w| w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false));
            if !front {
                let title = a.get("title").and_then(Value::as_str).unwrap_or("Entre Nous");
                let _ = app.notification().builder().title(title).body(s("body")).show();
            }
            Ok(json!(true))
        }

        // a web link of the history: opened in the browser
        "openUrl" => {
            let url = s("url");
            if !(url.starts_with("http://") || url.starts_with("https://")) {
                return Err("not a web link".into());
            }
            app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())?;
            Ok(json!(true))
        }

        "keepAwake" => {
            let mut awake = b.awake.lock().unwrap();
            if a.get("on").and_then(Value::as_bool).unwrap_or(false) {
                if awake.is_none() {
                    *awake = Some(Awake::start());
                }
            } else {
                *awake = None;
            }
            Ok(json!(true))
        }

        "setPaused" => {
            let paused = a.get("paused").and_then(Value::as_bool).unwrap_or(false);
            b.paused.store(paused, Ordering::SeqCst);
            relabel(app);
            Ok(json!(true))
        }
        // the language of the UI, for the tray menu
        "setLang" => {
            l10n::set(&s("lang"));
            relabel(app);
            Ok(json!(true))
        }

        "fileCreate" => {
            // a file of a folder being saved, or a received file (temporary folder)
            if let Some(folder) = a.get("folder").and_then(Value::as_str) {
                return Ok(json!(b.files.create_in(folder, &s("path"))?));
            }
            let name = a.get("name").and_then(Value::as_str).unwrap_or("fichier");
            Ok(json!(b.files.create(name, a.get("expiresAt").and_then(Value::as_f64))?))
        }
        // a folder to send: picked here, its files read through tokens
        "folderPick" => {
            let Some(dir) = app.dialog().file().blocking_pick_folder().and_then(|d| d.into_path().ok()) else {
                return Ok(Value::Null);
            };
            Ok(clip::folder(&dir, &|p| b.files.register(p)).unwrap_or(Value::Null))
        }
        // a folder to save: where, asked here; created there (another name if it exists)
        "folderCreate" => {
            let mut dialog = app.dialog().file();
            if let Some(downloads) = app.path().download_dir().ok() {
                dialog = dialog.set_directory(downloads);
            }
            let Some(parent) = dialog.blocking_pick_folder().and_then(|d| d.into_path().ok()) else {
                return Ok(Value::Null);
            };
            let name = a.get("name").and_then(Value::as_str).unwrap_or("dossier");
            let (token, made) = b.files.create_folder(&parent, name)?;
            let last = |p: &std::path::Path| p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
            Ok(json!({ "token": token, "where": format!("{}/{}", last(&parent), last(&made)) }))
        }
        "folderMkdir" => {
            b.files.mkdir(&s("folder"), &s("path"))?;
            Ok(json!(true))
        }
        "fileAppend" => {
            let data = B64.decode(s("data")).map_err(|_| "bad data")?;
            b.files.append(&s("token"), &data)?;
            Ok(json!(true))
        }
        "fileClose" => {
            b.files.close(&s("token"));
            Ok(json!(true))
        }
        "fileRead" => {
            let offset = a.get("offset").and_then(Value::as_u64).unwrap_or(0);
            let length = a.get("length").and_then(Value::as_u64).unwrap_or(0) as usize;
            Ok(json!(B64.encode(b.files.read(&s("token"), offset, length)?)))
        }
        "fileSaveAs" => {
            let src = b.files.path(&s("token")).ok_or("unknown file")?;
            let name = a.get("name").and_then(Value::as_str).unwrap_or("fichier");
            app.dialog().file().set_file_name(name).save_file(move |dest| {
                if let Some(dest) = dest.and_then(|d| d.into_path().ok()) {
                    let _ = std::fs::copy(&src, dest);
                }
            });
            Ok(json!(true))
        }
        "pipEnter" => {
            let n = |k: &str| a.get(k).and_then(Value::as_f64).unwrap_or(0.0);
            pip_enter(app, n("width"), n("height")).map_err(|e| e.to_string())?;
            Ok(json!(true))
        }
        "pipExit" => {
            pip_exit(app).map_err(|e| e.to_string())?;
            Ok(json!(true))
        }

        // open at login, with --hidden: straight to the tray
        "autostartGet" => Ok(json!(app.autolaunch().is_enabled().unwrap_or(false))),
        "autostartSet" => {
            let al = app.autolaunch();
            if a.get("on").and_then(Value::as_bool).unwrap_or(false) {
                al.enable().map_err(|e| e.to_string())?;
            } else {
                al.disable().map_err(|e| e.to_string())?;
            }
            Ok(json!(al.is_enabled().unwrap_or(false)))
        }
        other => Err(format!("unknown command {other}")),
    }
}

// ------------------------------------------------------------------ app

fn tray(app: &tauri::App) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", l10n::t("open"), true, None::<&str>)?;
    let pause = MenuItem::with_id(app, "pause", l10n::t("pause"), true, None::<&str>)?;
    let reload = MenuItem::with_id(app, "reload", l10n::t("reload"), true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", l10n::t("quit"), true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&open, &pause, &reload, &separator, &quit])?;
    *app.state::<Bridge>().menu.lock().unwrap() = Some(TrayMenu { open, pause, reload, quit });

    TrayIconBuilder::with_id("main")
        .icon(Image::from_bytes(include_bytes!("../icons/64x64.png"))?)
        .tooltip("Entre Nous")
        .menu(&menu)
        .show_menu_on_left_click(false) // left click: the window; right click: the menu
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => show(app),
            // the web UI decides and calls back setPaused
            "pause" => emit(app, "pause", json!({ "paused": !app.state::<Bridge>().paused.load(Ordering::SeqCst) })),
            "reload" => {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.eval("location.reload()");
                }
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                toggle(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

fn main() {
    l10n::init();
    tauri::Builder::default()
        // launched again (menu, shortcut): the window of the running app comes forward
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show(app)))
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec!["--hidden"])))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![native])
        .setup(|app| {
            let handle = app.handle().clone();
            let data_dir = app.path().app_data_dir()?;
            app.manage(Bridge {
                store: Mutex::new(store::Store::open(data_dir)),
                clip: clip::Clip::new(),
                files: files::Files::new(),
                paused: AtomicBool::new(false),
                awake: Mutex::new(None),
                menu: Mutex::new(None),
                pip: Mutex::new(None),
            });

            let name = gethostname::gethostname().to_string_lossy().to_string();
            let config = json!({
                "relay": relay_url(&handle),
                "name": name,
                "platform": if cfg!(windows) { "windows" } else { "linux" },
            });
            let script = format!(
                "window.__entrenous = {{ config: {config}, event() {{}}, \
                 call: (m) => window.__TAURI_INTERNALS__.invoke('native', {{ msg: m }}) }};"
            );
            // --hidden (start with the session): straight to the tray
            let hidden = std::env::args().any(|a| a == "--hidden");
            let opener = handle.clone();
            let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Entre Nous")
                .inner_size(400.0, 640.0)
                .min_inner_size(MIN_SIZE.0, MIN_SIZE.1)
                .visible(!hidden)
                .initialization_script(script)
                .incognito(true) // nothing stored by the web view: the secure store holds it all
                .use_https_scheme(true)
                .disable_drag_drop_handler() // files dropped on the window reach the web UI
                .on_navigation(move |url| {
                    let local = matches!(url.scheme(), "tauri" | "blob" | "about" | "data")
                        || url.host_str() == Some("tauri.localhost");
                    if !local {
                        // external links open in the browser
                        let _ = opener.opener().open_url(url.as_str(), None::<&str>);
                    }
                    local
                })
                .build()?;
            // closing the window keeps the app running (clipboard, relay): Quit is in the tray
            let w = window.clone();
            let app_handle = handle.clone();
            window.on_window_event(move |event| {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    // the small window of a video closed: the video stops, the window gets
                    // its size back for the next time
                    if pip_exit(&app_handle).unwrap_or(false) {
                        emit(&app_handle, "pip", json!({ "active": false, "closed": true }));
                    }
                    let _ = w.hide();
                }
            });

            tray(app)?;
            clip::watch(handle.clone());
            std::thread::spawn(move || loop {
                handle.state::<Bridge>().files.purge();
                std::thread::sleep(Duration::from_secs(600));
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Entre Nous n'a pas pu démarrer");
}
