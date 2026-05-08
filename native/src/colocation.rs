// isColocatedWorkspace：判断某 jj workspace 是否与 Git 仓库 colocated（.jj
// 与 .git 共存于同一 workspace 根）。用于 quickDiffProvider 的 "auto" 模式：
// colocated 下默认不挂 jj quickDiff，避免与 VSCode 内置 Git 扩展的 gutter
// 行级 diff 重叠。
//
// 实现复刻 jj v0.40.0 CLI 的 `is_colocated_git_workspace`
// （cli/src/git_util.rs），四层短路判定：
//   1. 从 repo.store() 取 GitBackend；非 Git backend → false。
//   2. GitBackend 没有 workdir（bare repo）→ false。
//   3. git_workdir == workspace_root → true（最常见 colocated 形态）。
//   4. 否则 canonicalize workspace_root/.git，其 parent 与 canonicalize 后
//      的 git_workdir 相等 → true（.git 为符号链接 / repo tool 场景）。
//   5. 其它 → false。
// 不复刻 CLI 里 workspace_supports_git_colocation_commands 对主 workspace
// 的 gate——那是命令体验限制，纯 colocation 判定不需要。
//
// 仅构建 x86_64-unknown-linux-gnu，std::fs::canonicalize 即可；jj CLI 原文
// 用 dunce 是为了在 Windows 上规避 `\\?\` verbatim 路径，此处不需要。

use std::path::Path;

use jj_lib::repo::{ReadonlyRepo, Repo};
use jj_lib::workspace::Workspace;
use napi::bindgen_prelude::Result;
use napi_derive::napi;

use crate::workspace_loader::load_workspace_and_repo;

#[napi]
pub fn is_colocated_workspace(workspace_path: String) -> Result<bool> {
    let (workspace, repo) = load_workspace_and_repo(Path::new(&workspace_path))?;
    Ok(compute_colocated(&workspace, &repo))
}

fn compute_colocated(workspace: &Workspace, repo: &ReadonlyRepo) -> bool {
    let Ok(git_backend) = jj_lib::git::get_git_backend(repo.store()) else {
        return false;
    };
    let Some(git_workdir) = git_backend.git_workdir() else {
        return false;
    };
    if git_workdir == workspace.workspace_root() {
        return true;
    }
    let Ok(dot_git) = std::fs::canonicalize(workspace.workspace_root().join(".git")) else {
        return false;
    };
    let Ok(canonical_workdir) = std::fs::canonicalize(git_workdir) else {
        return false;
    };
    let Some(dot_git_parent) = dot_git.parent() else {
        return false;
    };
    canonical_workdir.as_path() == dot_git_parent
}
