use crate::models::BackgroundTask;
use crate::storage::RuntimeState;
use anyhow::{Result, anyhow};
use chrono::Utc;
use tauri::{AppHandle, Emitter, Manager};
use uuid::Uuid;

fn emit(app: &AppHandle) {
    let state = app.state::<RuntimeState>();
    if let Ok(tasks) = state.background_tasks.read() {
        let _ = app.emit("background-tasks-changed", tasks.clone());
    }
}

pub fn list(state: &RuntimeState) -> Result<Vec<BackgroundTask>> {
    state
        .background_tasks
        .read()
        .map(|tasks| tasks.clone())
        .map_err(|_| anyhow!("后台任务锁已损坏"))
}

pub fn begin_scan(
    app: &AppHandle,
    key: &str,
    title: String,
    detail: String,
) -> Result<(BackgroundTask, bool)> {
    let state = app.state::<RuntimeState>();
    let mut active = state
        .active_scans
        .lock()
        .map_err(|_| anyhow!("扫描任务锁已损坏"))?;
    if let Some(id) = active.get(key)
        && let Some(task) = state
            .background_tasks
            .read()
            .ok()
            .and_then(|tasks| tasks.iter().find(|task| task.id == *id).cloned())
    {
        return Ok((task, false));
    }

    let now = Utc::now().to_rfc3339();
    let task = BackgroundTask {
        id: Uuid::new_v4().to_string(),
        kind: "scan".into(),
        title,
        detail,
        status: "running".into(),
        current: 0,
        total: None,
        error: String::new(),
        started_at: now.clone(),
        updated_at: now,
    };
    active.insert(key.into(), task.id.clone());
    let mut tasks = state
        .background_tasks
        .write()
        .map_err(|_| anyhow!("后台任务锁已损坏"))?;
    tasks.insert(0, task.clone());
    tasks.truncate(24);
    drop(tasks);
    drop(active);
    emit(app);
    Ok((task, true))
}

pub fn update(
    app: &AppHandle,
    id: &str,
    title: Option<&str>,
    detail: Option<String>,
    current: u64,
    total: Option<u64>,
) {
    let state = app.state::<RuntimeState>();
    if let Ok(mut tasks) = state.background_tasks.write()
        && let Some(task) = tasks.iter_mut().find(|task| task.id == id)
    {
        if let Some(title) = title {
            task.title = title.into();
        }
        if let Some(detail) = detail {
            task.detail = detail;
        }
        task.current = current;
        task.total = total;
        task.updated_at = Utc::now().to_rfc3339();
    }
    emit(app);
}

fn finish(app: &AppHandle, id: &str, key: &str, status: &str, error: String) {
    let state = app.state::<RuntimeState>();
    if let Ok(mut active) = state.active_scans.lock()
        && active.get(key).is_some_and(|active_id| active_id == id)
    {
        active.remove(key);
    }
    if let Ok(mut tasks) = state.background_tasks.write()
        && let Some(task) = tasks.iter_mut().find(|task| task.id == id)
    {
        task.status = status.into();
        task.error = error;
        task.updated_at = Utc::now().to_rfc3339();
        if status == "completed" {
            task.total = Some(task.total.unwrap_or(task.current));
        }
    }
    emit(app);
}

pub fn complete(app: &AppHandle, id: &str, key: &str) {
    finish(app, id, key, "completed", String::new());
}

pub fn fail(app: &AppHandle, id: &str, key: &str, error: String) {
    finish(app, id, key, "failed", error);
}
