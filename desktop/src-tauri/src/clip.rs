//! Watches the system clipboard and writes received content to it (as PasteboardWatcher.swift
//! does on the Mac):
//!  - content marked secret by password managers is never shared;
//!  - what we write is marked the same way, so clipboard history tools ignore it;
//!  - what we wrote ourselves is not sent back.
//! Linux: X11 clipboard (directly, or through XWayland under Wayland).

use crate::{emit, Bridge, B64};
use base64::Engine as _;
use clipboard_rs::common::RustImage;
use clipboard_rs::{
    Clipboard, ClipboardContent, ClipboardContext, ClipboardHandler, ClipboardWatcher, ClipboardWatcherContext,
    ContentFormat, RustImageData,
};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

const MAX_IMAGE: usize = 32 * 1024 * 1024;
/// A change seen this soon after our own write is that write.
const OWN_WRITE: Duration = Duration::from_millis(1500);

/// Formats set by password managers (and by us): "don't keep, don't sync".
#[cfg(windows)]
const SECRET_FORMATS: &[&str] = &["ExcludeClipboardContentFromMonitorProcessing", "Clipboard Viewer Ignore"];
#[cfg(not(windows))]
const SECRET_FORMATS: &[&str] = &["x-kde-passwordManagerHint"];

pub struct Clip {
    /// Kept for the whole run: on X11, the app serves what it wrote as long as it lives.
    ctx: Mutex<Option<ClipboardContext>>,
    own_write: Mutex<Option<Instant>>,
}

impl Clip {
    pub fn new() -> Clip {
        let ctx = ClipboardContext::new().map_err(|e| eprintln!("entrenous: no clipboard: {e}")).ok();
        Clip { ctx: Mutex::new(ctx), own_write: Mutex::new(None) }
    }

    fn set(&self, mut contents: Vec<ClipboardContent>) -> Result<(), String> {
        contents.extend(secret_marks());
        let guard = self.ctx.lock().unwrap();
        let ctx = guard.as_ref().ok_or("presse-papier inaccessible")?;
        *self.own_write.lock().unwrap() = Some(Instant::now());
        let res = ctx.set(contents).map_err(|e| e.to_string());
        *self.own_write.lock().unwrap() = Some(Instant::now());
        res
    }

    pub fn write_text(&self, text: &str) -> Result<(), String> {
        self.set(vec![ClipboardContent::Text(text.to_string())])
    }

    pub fn write_image(&self, data: &[u8]) -> Result<(), String> {
        let image = RustImageData::from_bytes(data).map_err(|e| e.to_string())?;
        self.set(vec![ClipboardContent::Image(image)])
    }

    /// A received file, put in the clipboard as a file (Ctrl+V in the file manager, a mail…).
    pub fn write_file(&self, path: &Path) -> Result<(), String> {
        self.set(vec![ClipboardContent::Files(vec![path.to_string_lossy().to_string()])])
    }

    fn is_own_change(&self) -> bool {
        self.own_write.lock().unwrap().is_some_and(|t| t.elapsed() < OWN_WRITE)
    }
}

#[cfg(windows)]
fn secret_marks() -> Vec<ClipboardContent> {
    // also keeps it out of the Windows clipboard history (Win+V) and cloud clipboard
    vec![
        ClipboardContent::Other("ExcludeClipboardContentFromMonitorProcessing".into(), vec![0; 4]),
        ClipboardContent::Other("CanIncludeInClipboardHistory".into(), vec![0; 4]),
        ClipboardContent::Other("CanUploadToCloudClipboard".into(), vec![0; 4]),
    ]
}

#[cfg(not(windows))]
fn secret_marks() -> Vec<ClipboardContent> {
    vec![ClipboardContent::Other("x-kde-passwordManagerHint".into(), b"secret".to_vec())]
}

/// What the clipboard holds, for the web UI: every file (folders skipped), otherwise an
/// image, otherwise text (same payloads as the Mac app).
fn contents(ctx: &ClipboardContext, register: impl Fn(PathBuf) -> String) -> Vec<Value> {
    if ctx.has(ContentFormat::Files) {
        let files: Vec<Value> = ctx
            .get_files()
            .unwrap_or_default()
            .into_iter()
            .filter_map(|f| {
                let path = file_path(&f);
                let meta = std::fs::metadata(&path).ok()?;
                if !meta.is_file() {
                    return None;
                }
                let name = path.file_name()?.to_string_lossy().to_string();
                let mime = mime_guess::from_path(&path).first_or_octet_stream().to_string();
                Some(json!({ "kind": "file", "token": register(path), "name": name, "size": meta.len(), "mime": mime }))
            })
            .collect();
        if !files.is_empty() {
            return files;
        }
    }
    if ctx.has(ContentFormat::Image) {
        if let Some(png) = ctx.get_image().ok().and_then(|i| i.to_png().ok()) {
            let bytes = png.get_bytes();
            if !bytes.is_empty() && bytes.len() <= MAX_IMAGE {
                return vec![json!({ "kind": "image", "data": B64.encode(bytes), "mime": "image/png", "name": "image.png" })];
            }
        }
    }
    match ctx.get_text() {
        Ok(text) if !text.is_empty() => vec![json!({ "kind": "text", "text": text })],
        _ => vec![],
    }
}

/// "file:///home/a%20b.txt" (X11) or "C:\a b.txt" (Windows) → a path.
fn file_path(f: &str) -> PathBuf {
    let Some(rest) = f.strip_prefix("file://") else {
        return PathBuf::from(f);
    };
    let rest = rest.strip_prefix("localhost").unwrap_or(rest);
    let bytes = rest.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(b) = u8::from_str_radix(std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or(""), 16) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    PathBuf::from(String::from_utf8_lossy(&out).to_string())
}

struct Handler {
    app: AppHandle,
    reader: Option<ClipboardContext>,
}

impl ClipboardHandler for Handler {
    fn on_clipboard_change(&mut self) {
        let bridge = self.app.state::<Bridge>();
        if bridge.clip.is_own_change() || bridge.paused.load(std::sync::atomic::Ordering::SeqCst) {
            return; // paused: copies are not even read
        }
        let Some(ctx) = self.reader.as_ref() else { return };
        if SECRET_FORMATS.iter().any(|f| ctx.has(ContentFormat::Other(f.to_string()))) {
            return;
        }
        // a copy shares one thing: the first file
        let files = &bridge.files;
        if let Some(first) = contents(ctx, |p| files.register(p)).into_iter().next() {
            emit(&self.app, "localCopy", first);
        }
    }
}

/// Starts watching the clipboard, on a thread of its own.
pub fn watch(app: AppHandle) {
    std::thread::spawn(move || {
        let mut watcher: ClipboardWatcherContext<Handler> = match ClipboardWatcherContext::new() {
            Ok(w) => w,
            Err(e) => {
                eprintln!("entrenous: clipboard not watched: {e}");
                return;
            }
        };
        let reader = ClipboardContext::new().ok();
        watcher.add_handler(Handler { app, reader }).start_watch();
    });
}
