mod background;
mod commands;
mod copy_engine;
mod media;
mod models;
mod repository;
mod storage;
mod tasks;

use crate::storage::{RuntimeState, load_catalog, resolve_data_directory};
use tauri::menu::MenuBuilder;
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Manager, RunEvent, WindowEvent};
use tauri_plugin_opener::OpenerExt;

fn show_main(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if window.is_minimized().unwrap_or(false) {
            let _ = window.unminimize();
        }
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(
            tauri_plugin_log::Builder::default()
                .level(log::LevelFilter::Info)
                .build(),
        )
        .setup(|app| {
            let data_dir = resolve_data_directory(app.handle())?;
            let catalog = load_catalog(app.handle(), &data_dir)?;
            app.manage(RuntimeState::new(catalog, data_dir));

            app.on_menu_event(|app, event| {
                let target = app
                    .state::<RuntimeState>()
                    .context_target
                    .read()
                    .ok()
                    .and_then(|value| value.clone());
                if let Some(target) = target {
                    match event.id().as_ref() {
                        "open-media" => {
                            let _ = app
                                .opener()
                                .open_path(target.to_string_lossy(), None::<&str>);
                        }
                        "reveal-media" => {
                            let _ = app.opener().reveal_item_in_dir(target);
                        }
                        _ => {}
                    }
                }
            });

            if let Some(window) = app.get_webview_window("main") {
                let handle = app.handle().clone();
                window.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        let keep_running = handle
                            .state::<RuntimeState>()
                            .catalog
                            .read()
                            .ok()
                            .is_some_and(|catalog| catalog.settings.keep_running);
                        if keep_running {
                            api.prevent_close();
                            if let Some(window) = handle.get_webview_window("main") {
                                let _ = window.hide();
                            }
                        }
                    }
                });
            }

            let tray_menu = MenuBuilder::new(app)
                .text("show", "显示 Material Gater")
                .separator()
                .text("quit", "退出")
                .build()?;
            let mut tray = TrayIconBuilder::with_id("material-gater")
                .menu(&tray_menu)
                .show_menu_on_left_click(false)
                .tooltip("Material Gater");
            if let Some(icon) = app.default_window_icon().cloned() {
                tray = tray.icon(icon);
            }
            tray.on_menu_event(|app, event| match event.id().as_ref() {
                "show" => show_main(app),
                "quit" => app.exit(0),
                _ => {}
            })
            .on_tray_icon_event(|tray, event| {
                if matches!(
                    event,
                    TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    }
                ) {
                    show_main(tray.app_handle());
                }
            })
            .build(app)?;

            background::start(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_state,
            commands::get_drives,
            commands::get_background_tasks,
            commands::scan_media,
            commands::list_directory,
            commands::create_library,
            commands::save_mapping,
            commands::run_mapping,
            commands::delete_mapping,
            commands::save_repository,
            commands::test_repository,
            commands::delete_repository,
            commands::save_preset,
            commands::delete_preset,
            commands::create_copy_task,
            commands::pause_copy_task,
            commands::resume_copy_task,
            commands::save_settings,
            commands::clear_catalog,
            commands::show_window,
            commands::show_media_menu,
        ])
        .build(tauri::generate_context!())
        .expect("无法启动 Material Gater");

    app.run(|app, event| {
        #[cfg(target_os = "macos")]
        if matches!(event, RunEvent::Reopen { .. }) {
            show_main(app);
        }
        #[cfg(not(target_os = "macos"))]
        let _ = (app, event);
    });
}
