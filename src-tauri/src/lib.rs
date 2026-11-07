pub mod config;
pub mod error;
pub mod install;
pub mod launch;
pub mod mods;
pub mod releases;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            let _ = app.get_webview_window("main").map(|w| {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            });
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init());

    #[cfg(desktop)]
    {
        builder = builder
            .plugin(tauri_plugin_updater::Builder::new().build())
            .plugin(tauri_plugin_process::init());
    }

    builder
        .manage(install::ActiveInstalls::default())
        .manage(launch::RunningGames::default())
        .setup(|app| {
            install::sweep_leftovers(app.handle());
            let data = app.path().app_data_dir()?;
            mods::init_log(&data.join("logs"));
            app.manage(mods::Mods::new(mods::Dirs::new(data)));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            releases::list_versions,
            install::install_version,
            install::get_installed_versions,
            install::remove_version,
            launch::launch_version,
            launch::get_running_versions,
            launch::open_game_folder,
            launch::open_log,
            mods::mods_abi,
            mods::mods_catalog,
            mods::mods_list,
            mods::mods_plan,
            mods::mods_install,
            mods::mods_inspect_file,
            mods::mods_install_file,
            mods::mods_set_enabled,
            mods::mods_remove
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
