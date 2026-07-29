use crate::storage::RuntimeState;
use std::process::{Child, Command, Stdio};
use tauri::{AppHandle, Manager};

fn configured(app: &AppHandle, reasons: &[String]) -> bool {
    let settings = match app.state::<RuntimeState>().catalog.read() {
        Ok(catalog) => catalog.settings.clone(),
        Err(_) => return false,
    };
    reasons.iter().any(|reason| {
        (reason == "app" && settings.prevent_sleep_app)
            || (reason.starts_with("copy:") && settings.prevent_sleep_copy)
            || (reason.starts_with("scan:") && settings.prevent_sleep_scan)
            || (reason.starts_with("mapping:") && settings.prevent_sleep_mapping)
    })
}

#[cfg(target_os = "macos")]
fn start_inhibitor() -> Option<Child> {
    Command::new("caffeinate")
        .arg("-i")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .ok()
}

#[cfg(target_os = "windows")]
fn start_inhibitor() -> Option<Child> {
    Command::new("powershell")
        .args(["-NoProfile", "-WindowStyle", "Hidden", "-Command", "Add-Type -Name Power -Namespace MG -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint esFlags);'; while ($true) { [MG.Power]::SetThreadExecutionState(0x80000001) | Out-Null; Start-Sleep -Seconds 30 }"])
        .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().ok()
}

#[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
fn start_inhibitor() -> Option<Child> {
    Command::new("systemd-inhibit")
        .args([
            "--what=sleep",
            "--why=Material Gater 正在执行任务",
            "--mode=block",
            "sleep",
            "infinity",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .ok()
}

pub fn refresh(app: &AppHandle) {
    let state = app.state::<RuntimeState>();
    let reasons = state
        .sleep_reasons
        .lock()
        .map(|value| value.iter().cloned().collect::<Vec<_>>())
        .unwrap_or_default();
    let should_run = configured(app, &reasons);
    let Ok(mut process) = state.sleep_process.lock() else {
        return;
    };
    if should_run && process.is_none() {
        *process = start_inhibitor();
    } else if !should_run && let Some(mut child) = process.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
}

pub fn set_reason(app: &AppHandle, reason: String, active: bool) {
    if let Ok(mut reasons) = app.state::<RuntimeState>().sleep_reasons.lock() {
        if active {
            reasons.insert(reason);
        } else {
            reasons.remove(&reason);
        }
    }
    refresh(app);
}

pub fn shutdown(app: &AppHandle) {
    let state = app.state::<RuntimeState>();
    if let Ok(mut process) = state.sleep_process.lock()
        && let Some(mut child) = process.take()
    {
        let _ = child.kill();
        let _ = child.wait();
    }
}
