// build_base_ignores：构造 jj snapshot / ignore 判定共用的"基础 ignore 链"。
//
// 参照 jj CLI v0.40.0 `cli/src/cli_util.rs::WorkspaceCommandHelper::base_ignores`
// 的行为原样复刻，确保 jjvs 与 `jj status` / `jj file list` 的"哪些路径被忽略"
// 判定口径一致：
//
//   1. 用 GitBackend（若 repo 是 git-backed，无论是否 colocated）：
//      - 从 `git_repo().config_snapshot()` 读 `core.excludesFile`；未设时回退到
//        `$XDG_CONFIG_HOME/git/ignore`（空/未设则 `$HOME/.config/git/ignore`）。
//      - 追加 `git_repo_path()/info/exclude`。colocated 下该路径是 workspace
//        根部的 `.git/info/exclude`；非 colocated 下落到 `.jj/repo/store/git/
//        info/exclude`，通常为空或只含 jj 自写的占位注释，不会越权。与 jj CLI
//        `base_ignores` 行为一致，保证"jj 当作 ignored 的 jjvs 也当作 ignored"。
//
//   2. 不是 git backend（比如 jj 的 simple backend）时，回退 `gix::config::
//      File::from_globals()`（仅读全局 / 系统 / git-installation 三层配置），
//      再按同样规则解析 `core.excludesFile`；没有 `info/exclude` 可追加。
//
// 对不存在的 gitignore 文件，`GitIgnoreFile::chain_with_file` 自身已返回
// `Ok(self.clone())`，不报错也不 panic，调用方无需守卫。路径中的 `~/` 通过
// `jj_lib::file_util::expand_home_path` 展开；若 `core.excludesFile` 是相对路
// 径，`Path::join` 会沿用 workspace_root 前缀（和 jj CLI 一致）。

use std::path::{Path, PathBuf};
use std::str;
use std::sync::Arc;

use gix::config::File as GixConfigFile;
use jj_lib::file_util::expand_home_path;
use jj_lib::gitignore::GitIgnoreFile;
use jj_lib::store::Store;
use napi::bindgen_prelude::{Error, Result};

/// 按 jj CLI 的 `base_ignores` 语义构造 ignore 链，供 `SnapshotOptions.
/// base_ignores` 与 `ignore::compute_chain_for_dir` 共用。
///
/// 签名只取真正依赖的两个字段：`workspace_root` 决定相对路径的锚定与
/// `info/exclude` 的物理位置取决于 GitBackend；`store` 是 `get_git_backend`
/// 的入参。取更宽的 `Workspace` / `ReadonlyRepo` 会让调用方无法从签名看
/// 出"只读两个字段"。
pub fn build_base_ignores(
    workspace_root: &Path,
    store: &Store,
) -> Result<Arc<GitIgnoreFile>> {
    let mut chain = GitIgnoreFile::empty();

    match jj_lib::git::get_git_backend(store) {
        Ok(git_backend) => {
            let git_repo = git_backend.git_repo();
            if let Some(excludes_path) = resolve_excludes_file_or_xdg_default(
                &git_repo.config_snapshot(),
                workspace_root,
            ) {
                log::debug!(
                    target: "native",
                    "base_ignores: core.excludesFile → {}",
                    excludes_path.display()
                );
                chain = chain
                    .chain_with_file("", excludes_path.clone())
                    .map_err(|err| {
                        Error::from_reason(format!(
                            "加载全局 gitignore `{}` 失败: {err}",
                            excludes_path.display()
                        ))
                    })?;
            }
            let info_exclude = git_backend.git_repo_path().join("info").join("exclude");
            log::debug!(
                target: "native",
                "base_ignores: info/exclude → {}",
                info_exclude.display()
            );
            chain = chain
                .chain_with_file("", info_exclude.clone())
                .map_err(|err| {
                    Error::from_reason(format!(
                        "加载 `{}` 失败: {err}",
                        info_exclude.display()
                    ))
                })?;
        }
        Err(err) => {
            // 非 git backend 或 store 异常：退回 `from_globals` 读纯全局配置。
            // 把原错误落到 debug log，避免日后用户报"colocated 仓库 ignore
            // 规则突然不生效"时线索沉默——否则 Err 分支整个吞下。
            log::debug!(
                target: "native",
                "base_ignores: get_git_backend 失败（{err}），回退 from_globals"
            );
            match GixConfigFile::from_globals() {
                Ok(global) => {
                    if let Some(excludes_path) =
                        resolve_excludes_file_or_xdg_default(&global, workspace_root)
                    {
                        log::debug!(
                            target: "native",
                            "base_ignores: core.excludesFile (globals) → {}",
                            excludes_path.display()
                        );
                        chain = chain
                            .chain_with_file("", excludes_path.clone())
                            .map_err(|err| {
                                Error::from_reason(format!(
                                    "加载全局 gitignore `{}` 失败: {err}",
                                    excludes_path.display()
                                ))
                            })?;
                    }
                }
                Err(err) => {
                    // 全局 gitconfig 语法坏掉 / 读不到等同于"没配置过"，不
                    // 把 XDG fallback 也一并放弃太激进；但把错误落日志方便
                    // 排查"为啥我 core.excludesFile 没生效"。
                    log::debug!(
                        target: "native",
                        "base_ignores: from_globals 失败（{err}），跳过全局 excludesFile"
                    );
                }
            }
        }
    }

    Ok(chain)
}

/// 从 gix config 视图解 `core.excludesFile` 的绝对路径；未配置时回退到 XDG。
/// 所有路径在返回前按 jj CLI 的约定用 `workspace_root.join(...)` 叠一层——
/// `Path::join` 对绝对路径是直通，对相对路径则前置 workspace_root。
fn resolve_excludes_file_or_xdg_default(
    config: &GixConfigFile<'_>,
    workspace_root: &Path,
) -> Option<PathBuf> {
    if let Some(value) = config.string("core.excludesFile") {
        // `value` 是 `Cow<'_, BStr>`；jj CLI 注释提到在非 UTF-8 path 的 Unix
        // 场景下更合适用 `path()` + `interpolate()`。这里对齐 jj CLI 的当前
        // 行为（同样走 utf-8 解码 → expand_home_path），保持两端一致。
        let path_str = str::from_utf8(&value).ok()?;
        let expanded = expand_home_path(path_str);
        return Some(workspace_root.join(expanded));
    }

    let xdg = xdg_config_home()?;
    Some(xdg.join("git").join("ignore"))
}

/// 等价于 jj CLI 私有 `xdg_config_home`：`$XDG_CONFIG_HOME` 非空时直接用，
/// 否则退回 `$HOME/.config`。当前仅支持 Linux x86_64，环境变量取不到 home
/// 时返回 None，由调用方按"没有 XDG fallback"处理。
fn xdg_config_home() -> Option<PathBuf> {
    if let Ok(value) = std::env::var("XDG_CONFIG_HOME") {
        if !value.is_empty() {
            return Some(PathBuf::from(value));
        }
    }
    std::env::var("HOME")
        .ok()
        .filter(|s| !s.is_empty())
        .map(|home| PathBuf::from(home).join(".config"))
}
