//! Received files live in the user's temporary folder (entrenous/<expiry>-<uuid>/<name>):
//! each one is deleted when its item expires (like on the relay). Local files offered for
//! sending are only referenced, never copied. Same behaviour as the Mac app (FileStore.swift).

use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

const DEFAULT_LIFETIME_MS: u64 = 24 * 3600 * 1000;
const OPENED_MARK: &str = "ouvert-";

pub struct Files {
    root: PathBuf,
    inner: Mutex<Inner>,
}

#[derive(Default)]
struct Inner {
    paths: HashMap<String, PathBuf>,
    open: HashMap<String, File>,
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

impl Files {
    pub fn new() -> Files {
        let root = std::env::temp_dir().join("entrenous");
        let _ = fs::create_dir_all(&root);
        crate::store::restrict(&root, 0o700);
        Files { root, inner: Mutex::new(Inner::default()) }
    }

    pub fn register(&self, path: PathBuf) -> String {
        let token = uuid::Uuid::new_v4().to_string();
        self.inner.lock().unwrap().paths.insert(token.clone(), path);
        token
    }

    pub fn path(&self, token: &str) -> Option<PathBuf> {
        self.inner.lock().unwrap().paths.get(token).cloned()
    }

    /// Folder name = expiry timestamp, so the purge needs no index. `opened`: a copy given to
    /// another app, also deleted when the app quits (and at the next launch, after a crash).
    pub fn create(&self, name: &str, expires_at: Option<f64>, opened: bool) -> Result<String, String> {
        let expiry = expires_at.map(|e| e as u64).unwrap_or_else(|| now_ms() + DEFAULT_LIFETIME_MS);
        let mark = if opened { OPENED_MARK } else { "" };
        let dir = self.root.join(format!("{expiry}-{mark}{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        // a received file: no leading dot either (it would be hidden)
        let safe = safe(name);
        let safe = safe.trim_start_matches('.');
        let path = dir.join(if safe.is_empty() { "fichier" } else { safe });
        let file = File::create(&path).map_err(|e| e.to_string())?;
        crate::store::restrict(&path, 0o600);
        let token = self.register(path);
        self.inner.lock().unwrap().open.insert(token.clone(), file);
        Ok(token)
    }

    /// A folder chosen to save into: `name` created in it (or "name 2"…); its token.
    pub fn create_folder(&self, parent: &Path, name: &str) -> Result<(String, PathBuf), String> {
        let base = safe(name);
        let base = if base.is_empty() { "dossier".to_string() } else { base };
        let mut path = parent.join(&base);
        let mut n = 2;
        while path.exists() {
            path = parent.join(format!("{base} {n}"));
            n += 1;
        }
        fs::create_dir_all(&path).map_err(|e| e.to_string())?;
        Ok((self.register(path.clone()), path))
    }

    /// `path` inside a folder made by create_folder, never outside it ("..", absolute refused).
    fn resolve(&self, folder: &str, path: &str) -> Result<PathBuf, String> {
        let root = self.path(folder).ok_or("unknown folder")?;
        let parts: Vec<String> = path.split('/').map(safe).collect();
        if parts.is_empty() || parts.iter().any(|p| p.is_empty() || p == "." || p == "..") {
            return Err("bad path".into());
        }
        Ok(parts.iter().fold(root, |acc, p| acc.join(p)))
    }

    /// A file of a folder being saved: written piece by piece like a received file.
    pub fn create_in(&self, folder: &str, path: &str) -> Result<String, String> {
        let mut file = self.resolve(folder, path)?;
        if let Some(dir) = file.parent() {
            fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        // two names that differ only by case are one file on Windows: "a 2.txt", never overwritten
        let stem = file.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
        let ext = file.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
        let mut n = 2;
        let f = loop {
            match fs::OpenOptions::new().write(true).create_new(true).open(&file) {
                Ok(f) => break f,
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                    file.set_file_name(format!("{stem} {n}{ext}"));
                    n += 1;
                }
                Err(e) => return Err(e.to_string()),
            }
        };
        let token = self.register(file);
        self.inner.lock().unwrap().open.insert(token.clone(), f);
        Ok(token)
    }

    pub fn mkdir(&self, folder: &str, path: &str) -> Result<(), String> {
        fs::create_dir_all(self.resolve(folder, path)?).map_err(|e| e.to_string())
    }

    pub fn append(&self, token: &str, data: &[u8]) -> Result<(), String> {
        let mut inner = self.inner.lock().unwrap();
        let file = inner.open.get_mut(token).ok_or("file not open")?;
        file.write_all(data).map_err(|e| e.to_string())
    }

    pub fn close(&self, token: &str) {
        self.inner.lock().unwrap().open.remove(token);
    }

    pub fn read(&self, token: &str, offset: u64, length: usize) -> Result<Vec<u8>, String> {
        let path = self.path(token).ok_or("unknown file")?;
        let mut file = File::open(path).map_err(|e| e.to_string())?;
        file.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
        let mut buf = Vec::with_capacity(length);
        file.take(length as u64).read_to_end(&mut buf).map_err(|e| e.to_string())?;
        Ok(buf)
    }

    /// The copies given to other apps: the app quits (or starts again after a crash).
    pub fn purge_opened(&self) {
        if let Ok(dirs) = fs::read_dir(&self.root) {
            for dir in dirs.flatten() {
                if dir.file_name().to_string_lossy().contains(&format!("-{OPENED_MARK}")) {
                    let _ = fs::remove_dir_all(dir.path());
                }
            }
        }
    }

    pub fn purge(&self) {
        let now = now_ms();
        if let Ok(dirs) = fs::read_dir(&self.root) {
            for dir in dirs.flatten() {
                let name = dir.file_name().to_string_lossy().to_string();
                let expired = name.split('-').next().and_then(|e| e.parse::<u64>().ok()).is_some_and(|e| e < now);
                if expired {
                    let _ = fs::remove_dir_all(dir.path());
                }
            }
        }
        self.inner.lock().unwrap().paths.retain(|_, p| Path::new(p).exists());
    }
}

/// A name from another device, made safe for a file name here (Windows' forbidden characters
/// too, and its trailing dots). "." and ".." stay: `resolve` refuses them.
fn safe(name: &str) -> String {
    let s: String = name
        .chars()
        .map(|c| if matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') || c.is_control() { '-' } else { c })
        .collect();
    let s = s.trim();
    if s == "." || s == ".." {
        return s.to_string();
    }
    let s = s.trim_end_matches(|c: char| c == '.' || c.is_whitespace());
    // Windows' device names (CON, NUL, COM1…), even with an extension: a file of that name would be the device
    let stem = s.split('.').next().unwrap_or("").to_ascii_lowercase();
    let device = matches!(stem.as_str(), "con" | "prn" | "aux" | "nul")
        || ((stem.starts_with("com") || stem.starts_with("lpt")) && stem.len() == 4 && stem.as_bytes()[3].is_ascii_digit());
    if device { format!("_{s}") } else { s.to_string() }
}
