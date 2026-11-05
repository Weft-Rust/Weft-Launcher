//! The mod manager's Tauri commands. Each one takes the app's [`Ctx`] and calls one operation in
//! `service/`, where the checks, the locking and the rules are.

use tauri::AppHandle;

use super::catalog::Catalog;
use super::context::Ctx;
use super::inspect::FileInspection;
use super::plan::{ChangeResult, CopyPreview, CopyResult, InstallPlan};
use super::profile::ProfileReport;
use super::service;
use crate::error::AppError;

#[tauri::command]
pub async fn list_mod_catalog(app: AppHandle, force_refresh: bool) -> Result<Catalog, AppError> {
    Ok(service::load_catalog(&Ctx::of(&app)?, force_refresh).await?)
}

/// Asks one source again; the others keep their answers.
#[tauri::command]
pub async fn refresh_mod_source(app: AppHandle, repo: String) -> Result<Catalog, AppError> {
    Ok(service::refresh_source(&Ctx::of(&app)?, &repo).await?)
}

#[tauri::command]
pub async fn get_mod_sources(app: AppHandle) -> Result<Vec<String>, AppError> {
    Ok(service::source_list(&Ctx::of(&app)?)?)
}

#[tauri::command]
pub async fn add_mod_source(app: AppHandle, repo: String) -> Result<Vec<String>, AppError> {
    Ok(service::add_source(&Ctx::of(&app)?, &repo).await?)
}

#[tauri::command]
pub async fn remove_mod_source(app: AppHandle, repo: String) -> Result<Vec<String>, AppError> {
    Ok(service::remove_source(&Ctx::of(&app)?, &repo).await?)
}

#[tauri::command]
pub async fn get_mod_profile(app: AppHandle, tag: String) -> Result<ProfileReport, AppError> {
    Ok(service::profile(&Ctx::of(&app)?, &tag).await?)
}

#[tauri::command]
pub async fn plan_mod_install(
    app: AppHandle,
    tag: String,
    sha256: String,
) -> Result<InstallPlan, AppError> {
    Ok(service::plan(&Ctx::of(&app)?, &tag, &sha256).await?)
}

#[tauri::command]
pub async fn install_mod(
    app: AppHandle,
    tag: String,
    sha256: String,
    plan_token: String,
    operation_id: String,
) -> Result<ChangeResult, AppError> {
    let ctx = Ctx::of(&app)?;
    Ok(service::install(&ctx, &tag, &sha256, &plan_token, &operation_id).await?)
}

#[tauri::command]
pub async fn inspect_mod_file(
    app: AppHandle,
    tag: String,
    path: String,
) -> Result<FileInspection, AppError> {
    Ok(service::inspect_file(&Ctx::of(&app)?, &tag, &path).await?)
}

#[tauri::command]
pub async fn install_mod_file(
    app: AppHandle,
    tag: String,
    path: String,
    sha256: String,
    plan_token: String,
    operation_id: String,
) -> Result<ChangeResult, AppError> {
    let ctx = Ctx::of(&app)?;
    Ok(service::install_file(&ctx, &tag, &path, &sha256, &plan_token, &operation_id).await?)
}

#[tauri::command]
pub async fn set_mod_enabled(
    app: AppHandle,
    tag: String,
    id: String,
    enabled: bool,
) -> Result<ChangeResult, AppError> {
    Ok(service::set_enabled(&Ctx::of(&app)?, &tag, &id, enabled).await?)
}

#[tauri::command]
pub async fn remove_mod(app: AppHandle, tag: String, id: String) -> Result<ChangeResult, AppError> {
    Ok(service::remove(&Ctx::of(&app)?, &tag, &id).await?)
}

#[tauri::command]
pub async fn restore_mod(
    app: AppHandle,
    tag: String,
    id: String,
    operation_id: String,
) -> Result<ChangeResult, AppError> {
    Ok(service::restore(&Ctx::of(&app)?, &tag, &id, &operation_id).await?)
}

#[tauri::command]
pub async fn preview_copy_mod_profile(
    app: AppHandle,
    from: String,
    to: String,
) -> Result<CopyPreview, AppError> {
    Ok(service::copy_preview(&Ctx::of(&app)?, &from, &to).await?)
}

#[tauri::command]
pub async fn copy_mod_profile(
    app: AppHandle,
    from: String,
    to: String,
    plan_token: String,
    operation_id: String,
) -> Result<CopyResult, AppError> {
    let ctx = Ctx::of(&app)?;
    Ok(service::copy(&ctx, &from, &to, &plan_token, &operation_id).await?)
}

/// Stops an install, copy, file install or restore until it starts writing; it then fails with
/// `ModCancelled` and changes nothing. False when no such operation is under way any more.
#[tauri::command]
pub async fn cancel_mod_operation(app: AppHandle, operation_id: String) -> Result<bool, AppError> {
    Ok(Ctx::of(&app)?.operations.cancel(&operation_id))
}

/// A mod icon as a `data:` URL: the page may not load images from the network.
#[tauri::command]
pub async fn get_mod_icon(app: AppHandle, url: String) -> Result<String, AppError> {
    use base64::Engine;
    let bytes = service::icon_png(&Ctx::of(&app)?, &url).await?;
    Ok(format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}

#[tauri::command]
pub async fn open_player_mods_folder(app: AppHandle) -> Result<(), AppError> {
    let folder = crate::launch::find_game_folder(&app)
        .await
        .ok_or(crate::launch::LaunchError::GameFolderNotFound(None))?;
    let mods = folder.join("mods");
    crate::launch::open_path(&app, if mods.exists() { &mods } else { &folder })?;
    Ok(())
}
