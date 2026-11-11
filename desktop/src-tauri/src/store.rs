//! Device identity, groups, prekeys and preferences: ONE file (a JSON object of key → value),
//! encrypted with XChaCha20-Poly1305 under a random 256-bit key kept by the system:
//!  - Windows: Credential Manager (protected by the session, DPAPI);
//!  - Linux: the Secret Service (GNOME Keyring, KWallet…), or, when there is none, a key
//!    file readable by the user only (`store.key`, next to the data: weaker, said in the docs).
//! The key alone is in the system store: Credential Manager caps a secret at 2.5 KB, the data
//! is larger.

use chacha20poly1305::aead::{Aead, AeadCore, KeyInit, OsRng};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

const SERVICE: &str = "dev.xdba.entrenous";
const ACCOUNT: &str = "store";
const NONCE: usize = 24;

pub struct Store {
    data: PathBuf,
    key_file: PathBuf,
    key: Option<[u8; 32]>,
    cache: BTreeMap<String, String>,
    /// The key could not be read while data exists (store locked, access refused): nothing is
    /// written, so nothing is lost.
    unreadable: bool,
}

impl Store {
    pub fn open(dir: PathBuf) -> Store {
        let _ = fs::create_dir_all(&dir);
        restrict(&dir, 0o700);
        let mut s = Store {
            data: dir.join("store.bin"),
            key_file: dir.join("store.key"),
            key: None,
            cache: BTreeMap::new(),
            unreadable: false,
        };
        s.load();
        s
    }

    pub fn get(&self, key: &str) -> Option<String> {
        self.cache.get(key).cloned()
    }

    pub fn set(&mut self, key: &str, value: &str) -> Result<(), String> {
        if self.unreadable {
            return Err("Stockage sécurisé inaccessible".into());
        }
        self.cache.insert(key.to_string(), value.to_string());
        self.save()
    }

    pub fn delete(&mut self, key: &str) {
        if !self.unreadable && self.cache.remove(key).is_some() {
            let _ = self.save();
        }
    }

    // ------------------------------------------------------------------ storage

    fn load(&mut self) {
        let Ok(sealed) = fs::read(&self.data) else {
            return; // first launch: the key is created at the first write
        };
        let Some(key) = self.read_key() else {
            eprintln!("entrenous: storage key unreadable, nothing will be written");
            self.unreadable = true;
            return;
        };
        match open(&key, &sealed).and_then(|plain| serde_json::from_slice(&plain).ok()) {
            Some(map) => {
                self.cache = map;
                self.key = Some(key);
            }
            None => {
                eprintln!("entrenous: storage unreadable (wrong key or damaged file)");
                self.unreadable = true;
            }
        }
    }

    fn save(&mut self) -> Result<(), String> {
        let key = match self.key {
            Some(k) => k,
            None => {
                let k = self.create_key()?;
                self.key = Some(k);
                k
            }
        };
        let plain = serde_json::to_vec(&self.cache).map_err(|e| e.to_string())?;
        let sealed = seal(&key, &plain)?;
        let tmp = self.data.with_extension("tmp");
        fs::write(&tmp, sealed).map_err(|e| e.to_string())?;
        restrict(&tmp, 0o600);
        fs::rename(&tmp, &self.data).map_err(|e| e.to_string())
    }

    fn read_key(&self) -> Option<[u8; 32]> {
        if let Ok(hex) = fs::read_to_string(&self.key_file) {
            return from_hex(hex.trim());
        }
        let entry = keyring::Entry::new(SERVICE, ACCOUNT).ok()?;
        from_hex(entry.get_password().ok()?.trim())
    }

    fn create_key(&self) -> Result<[u8; 32], String> {
        let key: [u8; 32] = XChaCha20Poly1305::generate_key(&mut OsRng).into();
        let hex = to_hex(&key);
        let stored = keyring::Entry::new(SERVICE, ACCOUNT).and_then(|e| e.set_password(&hex));
        if let Err(err) = stored {
            if cfg!(windows) {
                return Err(format!("Gestionnaire d’identification inaccessible : {err}"));
            }
            // Linux without a Secret Service (minimal desktops): a key file for the user only
            eprintln!("entrenous: no Secret Service ({err}), key kept in {}", self.key_file.display());
            fs::write(&self.key_file, &hex).map_err(|e| e.to_string())?;
            restrict(&self.key_file, 0o600);
        }
        Ok(key)
    }
}

fn seal(key: &[u8; 32], plain: &[u8]) -> Result<Vec<u8>, String> {
    let cipher = XChaCha20Poly1305::new(key.into());
    let nonce = XChaCha20Poly1305::generate_nonce(&mut OsRng);
    let mut out = nonce.to_vec();
    out.extend(cipher.encrypt(&nonce, plain).map_err(|_| "chiffrement")?);
    Ok(out)
}

fn open(key: &[u8; 32], sealed: &[u8]) -> Option<Vec<u8>> {
    if sealed.len() < NONCE {
        return None;
    }
    let cipher = XChaCha20Poly1305::new(key.into());
    cipher.decrypt(XNonce::from_slice(&sealed[..NONCE]), &sealed[NONCE..]).ok()
}

fn to_hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn from_hex(s: &str) -> Option<[u8; 32]> {
    if s.len() != 64 {
        return None;
    }
    let mut out = [0u8; 32];
    for (i, o) in out.iter_mut().enumerate() {
        *o = u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).ok()?;
    }
    Some(out)
}

#[cfg(unix)]
pub fn restrict(path: &std::path::Path, mode: u32) {
    use std::os::unix::fs::PermissionsExt;
    let _ = fs::set_permissions(path, fs::Permissions::from_mode(mode));
}

#[cfg(not(unix))]
pub fn restrict(_path: &std::path::Path, _mode: u32) {
    // Windows: the user's profile folders are already private to the user
}
