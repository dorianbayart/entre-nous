//! Texts of the native side (tray menu, a few errors), in French or English like the web UI:
//! the language of the environment at launch (Linux), then the one the UI says (setLang).
use std::sync::atomic::{AtomicBool, Ordering};

static FRENCH: AtomicBool = AtomicBool::new(false);

/// Linux: LANGUAGE, LC_ALL, LC_MESSAGES or LANG. Windows: English until the UI says.
pub fn init() {
    let env = ["LANGUAGE", "LC_ALL", "LC_MESSAGES", "LANG"]
        .iter()
        .filter_map(|k| std::env::var(k).ok())
        .find(|v| !v.is_empty() && v != "C" && v != "POSIX")
        .unwrap_or_default();
    set(&env.to_lowercase());
}

/// "fr", "fr-FR", "fr_FR.UTF-8"…: French; anything else: English.
pub fn set(lang: &str) {
    FRENCH.store(lang.starts_with("fr"), Ordering::SeqCst);
}

pub fn t(key: &str) -> &'static str {
    let fr = FRENCH.load(Ordering::SeqCst);
    match key {
        "open" => if fr { "Ouvrir Entre Nous" } else { "Open Entre Nous" },
        "pause" => if fr { "Mettre en pause" } else { "Pause sharing" },
        "resume" => if fr { "Reprendre le partage" } else { "Resume sharing" },
        "reload" => if fr { "Recharger" } else { "Reload" },
        "quit" => if fr { "Quitter" } else { "Quit" },
        "paused" => if fr { "Entre Nous : en pause" } else { "Entre Nous: paused" },
        "noClipboard" => if fr { "presse-papier inaccessible" } else { "clipboard unavailable" },
        "noStorage" => if fr { "Stockage sécurisé inaccessible" } else { "Secure storage unavailable" },
        "noCredentials" => if fr { "Gestionnaire d’identification inaccessible" } else { "Credential Manager unavailable" },
        _ => "",
    }
}
