// jj-lib Workspace 的最小化加载工具，被 probe / list_changes / read_file
// 各入口复用。无状态：每次调用重新 `Workspace::load`，不做进程内缓存。
// 这是有意的：扩展生命周期内仓库配置可能变化，且 load 的主要开销是打开
// store 句柄，相对一次 snapshot 成本可忽略。后续若性能瓶颈在这里再优化。

use std::path::Path;
use std::sync::Arc;

use jj_lib::config::StackedConfig;
// Repo trait 需要在导出 Store / View 的调用点 in scope；load_workspace_and_repo
// 返回 Arc<ReadonlyRepo>，调用方若要 repo.store() / repo.view() 需自行 `use`。
use jj_lib::repo::{ReadonlyRepo, StoreFactories};
use jj_lib::settings::UserSettings;
use jj_lib::workspace::{default_working_copy_factories, Workspace};
use napi::bindgen_prelude::{Error, Result};
use pollster::FutureExt as _;

/// 加载指定路径下的 jj Workspace，并同步解析出当前 operation 对应的
/// ReadonlyRepo。调用方拿到 Workspace（可变，用于 snapshot）与 ReadonlyRepo
/// （只读，用于 view / store 访问）。
pub fn load_workspace_and_repo(workspace_path: &Path) -> Result<(Workspace, Arc<ReadonlyRepo>)> {
    let settings = UserSettings::from_config(StackedConfig::with_defaults())
        .map_err(|err| Error::from_reason(format!("构造 UserSettings 失败: {err}")))?;
    let store_factories = StoreFactories::default();
    let wc_factories = default_working_copy_factories();

    let workspace = Workspace::load(&settings, workspace_path, &store_factories, &wc_factories)
        .map_err(|err| Error::from_reason(format!("加载 jj workspace 失败: {err}")))?;

    let repo = workspace
        .repo_loader()
        .load_at_head()
        .block_on()
        .map_err(|err| Error::from_reason(format!("加载 jj repo 失败: {err}")))?;

    Ok((workspace, repo))
}
