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

    /// Folder name = expiry timestamp, so the purge needs no index.
    pub fn create(&self, name: &str, expires_at: Option<f64>) -> Result<String, String> {
        let expiry = expires_at.map(|e| e as u64).unwrap_or_else(|| now_ms() + DEFAULT_LIFETIME_MS);
        let dir = self.root.join(format!("{expiry}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let safe: String = name
            .chars()
            .map(|c| if matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') || c.is_control() { '-' } else { c })
            .collect();
        let safe = safe.trim_matches(|c: char| c == '.' || c.is_whitespace());
        let path = dir.join(if safe.is_empty() { "fichier" } else { safe });
        let file = File::create(&path).map_err(|e| e.to_string())?;
        crate::store::restrict(&path, 0o600);
        let token = self.register(path);
        self.inner.lock().unwrap().open.insert(token.clone(), file);
        Ok(token)
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
