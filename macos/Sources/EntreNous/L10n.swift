import Foundation

/// Texts of the native side (menu of the icon, a few errors), in French or English like the
/// web UI: the system's language at launch, then the one the UI says (setLang).
enum L10n {
    /// The first preferred language of the system: French, or English for any other.
    static let system: String = {
        for l in Locale.preferredLanguages {
            let base = l.split(separator: "-").first.map(String.init)?.lowercased() ?? ""
            if base == "fr" || base == "en" { return base }
        }
        return "en"
    }()

    static var lang = system

    private static let texts: [String: (fr: String, en: String)] = [
        "open": ("Ouvrir Entre Nous", "Open Entre Nous"),
        "pause": ("Mettre en pause", "Pause sharing"),
        "resume": ("Reprendre le partage", "Resume sharing"),
        "reload": ("Recharger", "Reload"),
        "quit": ("Quitter", "Quit"),
        "paused": ("Entre Nous : en pause", "Entre Nous: paused"),
        "pausedShort": ("Entre Nous (en pause)", "Entre Nous (paused)"),
        "edit": ("Édition", "Edit"),
        "undo": ("Annuler", "Undo"),
        "redo": ("Rétablir", "Redo"),
        "cut": ("Couper", "Cut"),
        "copy": ("Copier", "Copy"),
        "paste": ("Coller", "Paste"),
        "selectAll": ("Tout sélectionner", "Select All"),
        "keychain": ("Trousseau inaccessible", "Keychain unavailable"),
    ]

    static func t(_ key: String) -> String {
        guard let s = texts[key] else { return key }
        return lang == "fr" ? s.fr : s.en
    }
}
