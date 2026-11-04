pub mod config;
pub mod download;
pub mod error;
pub mod install;
pub mod ipc;
pub mod launch;
pub mod mods;
pub mod releases;

#[cfg(test)]
mod bindings;

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
        .manage(mods::catalog::CatalogState::default())
        .manage(mods::ModsLock::default())
        .manage(mods::store::Reservations::default())
        .setup(|app| {
            install::sweep_leftovers(app.handle());
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
            mods::commands::list_mod_catalog,
            mods::commands::get_mod_sources,
            mods::commands::add_mod_source,
            mods::commands::remove_mod_source,
            mods::commands::get_mod_profile,
            mods::commands::plan_mod_install,
            mods::commands::install_mod,
            mods::commands::inspect_mod_file,
            mods::commands::install_mod_file,
            mods::commands::set_mod_enabled,
            mods::commands::remove_mod,
            mods::commands::restore_mod,
            mods::commands::preview_copy_mod_profile,
            mods::commands::copy_mod_profile,
            mods::commands::get_mod_icon,
            mods::commands::open_player_mods_folder
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
