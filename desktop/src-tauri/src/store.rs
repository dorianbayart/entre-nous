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

#[cfg(not(test))]
const SERVICE: &str = "dev.xdba.entrenous";
#[cfg(test)]
const SERVICE: &str = "dev.xdba.entrenous.test"; // never the key of the app on this machine
const ACCOUNT: &str = "store";
const NONCE: usize = 24;

pub struct Store {
    data: PathBuf,
    key_file: PathBuf,
    key: Option<[u8; 32]>,
    cache: BTreeMap<String, String>,
    /// Opened, at the first access (its key read). Until then, and after a failure (store locked
    /// or not there yet, access refused, damaged file), nothing is read nor written, so nothing
    /// is lost; it is opened again at the next access.
    loaded: bool,
}

impl Store {
    /// Nothing read yet: the store opens at the first access.
    pub fn open(dir: PathBuf) -> Store {
        let _ = fs::create_dir_all(&dir);
        restrict(&dir, 0o700);
        Store {
            data: dir.join("store.bin"),
            key_file: dir.join("store.key"),
            key: None,
            cache: BTreeMap::new(),
            loaded: false,
        }
    }

    /// Unreadable, it fails: an empty store would look like a first launch, and the page would
    /// make a new identity.
    pub fn get(&mut self, key: &str) -> Result<Option<String>, String> {
        self.readable()?;
        Ok(self.cache.get(key).cloned())
    }

    pub fn set(&mut self, key: &str, value: &str) -> Result<(), String> {
        self.readable()?;
        self.cache.insert(key.to_string(), value.to_string());
        self.save()
    }

    pub fn delete(&mut self, key: &str) {
        if self.readable().is_ok() && self.cache.remove(key).is_some() {
            let _ = self.save();
        }
    }

    /// Opened at the first access, not at launch (a session may start with the store still
    /// locked, or its service not there yet), and again at each access after a failure. The page
    /// stops at the first failure and shows its Try again button: a store that asks for its
    /// password asks once per try.
    fn readable(&mut self) -> Result<(), String> {
        if !self.loaded {
            self.load();
        }
        if !self.loaded {
            return Err(crate::l10n::t("noStorage").into());
        }
        Ok(())
    }

    // ------------------------------------------------------------------ storage

    fn load(&mut self) {
        let Ok(sealed) = fs::read(&self.data) else {
            self.loaded = true; // first launch: the key is created at the first write
            return;
        };
        let Some(key) = self.read_key() else {
            eprintln!("entrenous: storage key unreadable, nothing will be written");
            return;
        };
        match open(&key, &sealed).and_then(|plain| serde_json::from_slice(&plain).ok()) {
            Some(map) => {
                self.cache = map;
                self.key = Some(key);
                self.loaded = true;
            }
            None => eprintln!("entrenous: storage unreadable (wrong key or damaged file)"),
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
                return Err(format!("{} : {err}", crate::l10n::t("noCredentials")));
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;
    use std::process::Command;

    fn dir() -> PathBuf {
        let d = std::env::temp_dir().join(format!("entrenous-store-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&d).unwrap();
        d
    }

    /// The key unreadable at launch, then back: the store says so instead of looking empty,
    /// writes nothing, and opens once the key is back, without restarting.
    fn unreadable_then_back(lock: impl Fn(&Path), unlock: impl Fn(&Path)) {
        let d = dir();
        let mut s = Store::open(d.clone());
        assert_eq!(s.get("device"), Ok(None), "first launch: empty");
        s.set("device", "mine").unwrap();
        let sealed = fs::read(d.join("store.bin")).unwrap();

        lock(&d);
        let mut s = Store::open(d.clone()); // launched while the key cannot be read
        assert!(!s.loaded, "nothing read at launch: a locked store asks once per access");
        assert!(s.get("device").is_err(), "unreadable, not empty");
        assert!(s.set("device", "new identity").is_err());
        s.delete("device");
        assert_eq!(fs::read(d.join("store.bin")).unwrap(), sealed, "nothing written");

        unlock(&d);
        assert_eq!(s.get("device"), Ok(Some("mine".into())), "read again at the next access");
        s.set("other", "x").unwrap();
        assert_eq!(Store::open(d.clone()).get("other"), Ok(Some("x".into())));
        let _ = fs::remove_dir_all(&d);
    }

    /// No Secret Service (a minimal desktop, or Docker): the key is in store.key.
    #[test]
    fn key_file_unreadable_then_back() {
        if keyring::Entry::new(SERVICE, ACCOUNT).and_then(|e| e.set_password("probe")).is_ok() {
            let _ = keyring::Entry::new(SERVICE, ACCOUNT).and_then(|e| e.delete_credential());
            eprintln!("a Secret Service is there: see secret_service_locked_then_unlocked");
            return;
        }
        let hidden = |d: &Path| d.join("store.key.hidden");
        unreadable_then_back(
            |d| fs::rename(d.join("store.key"), hidden(d)).unwrap(),
            |d| fs::rename(hidden(d), d.join("store.key")).unwrap(),
        );
    }

    /// A real Secret Service (GNOME Keyring), locked when the app starts, as in a session opened
    /// without its password: ENTRENOUS_LOCK and ENTRENOUS_UNLOCK are the shell commands.
    #[test]
    #[ignore = "needs a Secret Service and the commands that lock and unlock it"]
    fn secret_service_locked_then_unlocked() {
        let sh = |var: &str| {
            let cmd = std::env::var(var).unwrap_or_else(|_| panic!("{var} not set"));
            assert!(Command::new("sh").args(["-c", &cmd]).status().unwrap().success(), "{var} failed");
        };
        unreadable_then_back(
            |d| {
                assert!(!d.join("store.key").exists(), "the key is in the Secret Service");
                sh("ENTRENOUS_LOCK");
            },
            |_| sh("ENTRENOUS_UNLOCK"),
        );
        let _ = keyring::Entry::new(SERVICE, ACCOUNT).and_then(|e| e.delete_credential());
    }
}
