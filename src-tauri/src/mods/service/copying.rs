//! "Copy mods from…": the preview, and the copy it agrees to.

use super::*;

struct CopyInputs {
    catalog: Catalog,
    abi: String,
    preview: CopyPreview,
    picks: Vec<(CatalogMod, CatalogVersion)>,
}

async fn copy_inputs(ctx: &Ctx, from: &str, to: &str) -> Result<CopyInputs, ModsError> {
    ensure_installed(&ctx.paths, to)?;
    let source = store::read_lock(&ctx.paths, from)?;
    let target = store::read_lock(&ctx.paths, to)?;
    let catalog = current_catalog(ctx).await?;
    let abi = require_abi(&ctx.paths, &catalog, to).await?;
    let (preview, picks) =
        plan::copy_preview(&catalog, (from, &source), (to, &target), Fit::here(&abi));
    Ok(CopyInputs {
        catalog,
        abi,
        preview,
        picks,
    })
}

/// What `copy` would bring over.
pub async fn copy_preview(ctx: &Ctx, from: &str, to: &str) -> Result<CopyPreview, ModsError> {
    Ok(copy_inputs(ctx, from, to).await?.preview)
}

/// Brings the turned-on mods of one version to another, each as the build made for the new one,
/// as previewed with `plan_token`. Mods the new version already has are left as they are.
pub async fn copy(
    ctx: &Ctx,
    from: &str,
    to: &str,
    plan_token: &str,
    operation_id: &str,
) -> Result<CopyResult, ModsError> {
    let op = ctx.operations.begin(operation_id)?;
    ctx.ensure_not_running(to)?;
    let inputs = copy_inputs(ctx, from, to).await?;
    if inputs.preview.plan_token != plan_token {
        return Err(plan_changed());
    }
    let left_behind = inputs
        .preview
        .items
        .into_iter()
        .filter(|i| {
            matches!(
                i.outcome,
                CopyOutcome::NoBuild | CopyOutcome::LocalFile | CopyOutcome::Revoked
            )
        })
        .collect();
    let change = if inputs.picks.is_empty() {
        let lock = store::read_lock(&ctx.paths, to)?;
        change_result(ctx, to, &lock, &inputs.catalog).await
    } else {
        let agreed = Agreed {
            plan_token,
            op: &op,
        };
        run_install(
            ctx,
            to,
            inputs.catalog,
            inputs.abi,
            inputs.picks,
            Vec::new(),
            agreed,
        )
        .await?
    };
    Ok(CopyResult {
        change,
        left_behind,
    })
}
