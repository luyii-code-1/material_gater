use crate::models::BackgroundTask;
use crate::storage::RuntimeState;
use anyhow::{Result, anyhow};
use chrono::Utc;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
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
    begin(app, key, "scan", title, detail)
}

pub fn begin(
    app: &AppHandle,
    key: &str,
    kind: &str,
    title: String,
    detail: String,
) -> Result<(BackgroundTask, bool)> {
    let state = app.state::<RuntimeState>();
    let mut active = state
        .active_scans
        .lock()
        .map_err(|_| anyhow!("后台任务锁已损坏"))?;
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
        kind: kind.into(),
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
    state
        .background_pauses
        .write()
        .map_err(|_| anyhow!("后台任务控制锁已损坏"))?
        .insert(task.id.clone(), Arc::new(AtomicBool::new(false)));
    let mut tasks = state
        .background_tasks
        .write()
        .map_err(|_| anyhow!("后台任务锁已损坏"))?;
    tasks.insert(0, task.clone());
    tasks.truncate(48);
    drop(tasks);
    drop(active);
    emit(app);
    if kind == "scan" {
        crate::power::set_reason(app, format!("scan:{}", task.id), true);
    }
    Ok((task, true))
}

pub fn checkpoint(app: &AppHandle, id: &str) -> Result<()> {
    loop {
        let control = app
            .state::<RuntimeState>()
            .background_pauses
            .read()
            .map_err(|_| anyhow!("后台任务控制锁已损坏"))?
            .get(id)
            .cloned();
        let Some(control) = control else {
            return Err(anyhow!("后台任务已结束"));
        };
        if !control.load(Ordering::Relaxed) {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(120));
    }
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

pub fn pause(app: &AppHandle, id: &str) -> Result<()> {
    let state = app.state::<RuntimeState>();
    let control = state
        .background_pauses
        .read()
        .map_err(|_| anyhow!("后台任务控制锁已损坏"))?
        .get(id)
        .cloned()
        .ok_or_else(|| anyhow!("任务已经结束"))?;
    control.store(true, Ordering::Relaxed);
    if let Ok(mut tasks) = state.background_tasks.write()
        && let Some(task) = tasks.iter_mut().find(|task| task.id == id)
    {
        task.status = "paused".into();
        task.updated_at = Utc::now().to_rfc3339();
    }
    emit(app);
    crate::power::set_reason(app, format!("scan:{id}"), false);
    Ok(())
}

pub fn resume(app: &AppHandle, id: &str) -> Result<()> {
    let state = app.state::<RuntimeState>();
    let control = state
        .background_pauses
        .read()
        .map_err(|_| anyhow!("后台任务控制锁已损坏"))?
        .get(id)
        .cloned()
        .ok_or_else(|| anyhow!("任务已经结束"))?;
    control.store(false, Ordering::Relaxed);
    if let Ok(mut tasks) = state.background_tasks.write()
        && let Some(task) = tasks.iter_mut().find(|task| task.id == id)
    {
        task.status = "running".into();
        task.updated_at = Utc::now().to_rfc3339();
    }
    emit(app);
    crate::power::set_reason(app, format!("scan:{id}"), true);
    Ok(())
}

fn is_finished(status: &str) -> bool {
    matches!(status, "completed" | "failed" | "cancelled")
}

pub fn clear_finished(app: &AppHandle) -> Result<Vec<BackgroundTask>> {
    let state = app.state::<RuntimeState>();
    let (remaining, removed) = {
        let mut tasks = state
            .background_tasks
            .write()
            .map_err(|_| anyhow!("后台任务锁已损坏"))?;
        let removed = tasks
            .iter()
            .filter(|task| is_finished(&task.status))
            .map(|task| task.id.clone())
            .collect::<Vec<_>>();
        tasks.retain(|task| !is_finished(&task.status));
        (tasks.clone(), removed)
    };
    if let Ok(mut controls) = state.background_pauses.write() {
        controls.retain(|id, _| !removed.contains(id));
    }
    if let Ok(mut active) = state.active_scans.lock() {
        active.retain(|_, task_id| !removed.contains(task_id));
    }
    if let Ok(mut thumbnail_task) = state.thumbnail_task.lock()
        && thumbnail_task
            .as_ref()
            .is_some_and(|id| removed.contains(id))
    {
        *thumbnail_task = None;
    }
    emit(app);
    Ok(remaining)
}

pub fn dismiss(app: &AppHandle, id: &str) -> Result<Vec<BackgroundTask>> {
    let state = app.state::<RuntimeState>();
    {
        let mut tasks = state
            .background_tasks
            .write()
            .map_err(|_| anyhow!("后台任务锁已损坏"))?;
        let task = tasks
            .iter()
            .find(|task| task.id == id)
            .ok_or_else(|| anyhow!("找不到后台任务"))?;
        if !is_finished(&task.status) {
            return Err(anyhow!("运行中或已暂停的任务不能清理"));
        }
        tasks.retain(|task| task.id != id);
    }
    if let Ok(mut controls) = state.background_pauses.write() {
        controls.remove(id);
    }
    if let Ok(mut active) = state.active_scans.lock() {
        active.retain(|_, task_id| task_id != id);
    }
    if let Ok(mut thumbnail_task) = state.thumbnail_task.lock()
        && thumbnail_task.as_deref() == Some(id)
    {
        *thumbnail_task = None;
    }
    emit(app);
    crate::power::set_reason(app, format!("scan:{id}"), false);
    list(&state)
}

#[allow(dead_code)]
pub fn clear_completed(app: &AppHandle) -> Result<Vec<BackgroundTask>> {
    clear_finished(app)
}

pub fn cancel_key(app: &AppHandle, key: &str) -> Result<Vec<BackgroundTask>> {
    let state = app.state::<RuntimeState>();
    let id = state
        .active_scans
        .lock()
        .map_err(|_| anyhow!("后台任务锁已损坏"))?
        .remove(key)
        .ok_or_else(|| anyhow!("该素材源当前没有索引任务"))?;
    if let Ok(mut controls) = state.background_pauses.write() {
        controls.remove(&id);
    }
    if let Ok(mut tasks) = state.background_tasks.write()
        && let Some(task) = tasks.iter_mut().find(|task| task.id == id)
    {
        task.status = "cancelled".into();
        task.detail = "用户已取消索引".into();
        task.updated_at = Utc::now().to_rfc3339();
    }
    emit(app);
    crate::power::set_reason(app, format!("scan:{id}"), false);
    list(&state)
}

fn finish(app: &AppHandle, id: &str, key: &str, status: &str, error: String) {
    let state = app.state::<RuntimeState>();
    if state
        .background_tasks
        .read()
        .ok()
        .and_then(|tasks| {
            tasks
                .iter()
                .find(|task| task.id == id)
                .map(|task| task.status.clone())
        })
        .is_some_and(|value| value == "cancelled")
    {
        return;
    }
    if let Ok(mut active) = state.active_scans.lock()
        && active.get(key).is_some_and(|active_id| active_id == id)
    {
        active.remove(key);
    }
    if let Ok(mut controls) = state.background_pauses.write() {
        controls.remove(id);
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
    crate::power::set_reason(app, format!("scan:{id}"), false);
}

pub fn complete(app: &AppHandle, id: &str, key: &str) {
    finish(app, id, key, "completed", String::new());
}

pub fn fail(app: &AppHandle, id: &str, key: &str, error: String) {
    finish(app, id, key, "failed", error);
}

#[cfg(test)]
mod tests {
    use super::is_finished;

    #[test]
    fn finished_task_filter_includes_failures_and_cancellations() {
        assert!(is_finished("completed"));
        assert!(is_finished("failed"));
        assert!(is_finished("cancelled"));
        assert!(!is_finished("running"));
        assert!(!is_finished("paused"));
    }
}
