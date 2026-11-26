//! Windows, installed from the Microsoft Store (MSIX package, desktop/msix/): the app runs with
//! the package's identity, so what the installer's version does by itself works differently:
//!  - open at login: a StartupTask declared in the manifest (the registry key written by the
//!    autostart plugin would stay in the package's private copy of the registry);
//!  - notifications: shown under the package's identity (the installer's app id is not its own);
//!  - updates: the Store's (the web UI links to no installer).
use windows::core::{Result, HSTRING};
use windows::ApplicationModel::Activation::ActivationKind;
use windows::ApplicationModel::{AppInstance, StartupTask, StartupTaskState};
use windows::Data::Xml::Dom::XmlDocument;
use windows::UI::Notifications::{ToastNotification, ToastNotificationManager};

/// The StartupTask of the manifest (desktop/msix/AppxManifest.xml).
const TASK: &str = "EntreNousStartup";

#[link(name = "kernel32")]
extern "system" {
    fn GetCurrentPackageFullName(length: *mut u32, name: *mut u16) -> i32;
}

/// Is the app running from its MSIX package?
pub fn packaged() -> bool {
    const APPMODEL_ERROR_NO_PACKAGE: i32 = 15700;
    let mut length = 0u32;
    // the length only: ERROR_INSUFFICIENT_BUFFER in a package, APPMODEL_ERROR_NO_PACKAGE outside
    unsafe { GetCurrentPackageFullName(&mut length, std::ptr::null_mut()) != APPMODEL_ERROR_NO_PACKAGE }
}

/// Started by the system at login (then straight to the tray, like --hidden elsewhere)?
pub fn started_at_login() -> bool {
    AppInstance::GetActivatedEventArgs()
        .and_then(|a| a.Kind())
        .is_ok_and(|k| k == ActivationKind::StartupTask)
}

fn task() -> Result<StartupTask> {
    StartupTask::GetAsync(&HSTRING::from(TASK))?.join()
}

pub fn autostart_get() -> bool {
    task()
        .and_then(|t| t.State())
        .is_ok_and(|s| s == StartupTaskState::Enabled || s == StartupTaskState::EnabledByPolicy)
}

/// Turned off in the Task Manager or the Settings, it stays off: only the user turns it on there.
pub fn autostart_set(on: bool) -> std::result::Result<bool, String> {
    let t = task().map_err(|e| e.to_string())?;
    if on {
        t.RequestEnableAsync().and_then(|r| r.join()).map_err(|e| e.to_string())?;
    } else {
        t.Disable().map_err(|e| e.to_string())?;
    }
    Ok(autostart_get())
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

pub fn notify(title: &str, body: &str) -> Result<()> {
    let xml = XmlDocument::new()?;
    xml.LoadXml(&HSTRING::from(format!(
        "<toast><visual><binding template=\"ToastGeneric\"><text>{}</text><text>{}</text></binding></visual></toast>",
        xml_escape(title),
        xml_escape(body)
    )))?;
    let toast = ToastNotification::CreateToastNotification(&xml)?;
    ToastNotificationManager::CreateToastNotifier()?.Show(&toast)
}
