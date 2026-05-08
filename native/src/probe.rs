// 同步的 workspace 探测 API：真实调用 Workspace::load +
// RepoLoader::load_at_head，返回当前 working-copy commit id / parent
// commit id / operation id。扩展激活期每 workspace folder 调一次做健康检
// 查——有 jj 仓库但 load 失败时直接让激活失败，暴露环境问题（.jj 结构
// 不完整、平台库版本不兼容等）。不承担业务 diff / 文件读取职责。

use jj_lib::object_id::ObjectId;
use jj_lib::ref_name::WorkspaceName;
use jj_lib::repo::Repo;
use napi::bindgen_prelude::{Error, Result};
use napi_derive::napi;
use pollster::FutureExt as _;

use crate::workspace_loader::load_workspace_and_repo;

/// M1 第二阶段探测结果：真实调用 jj-lib 加载 workspace/repo，读取 view 里
/// 当前 workspace 的 working-copy commit，再据此解析出父 commit 与 operation。
#[napi(object)]
pub struct WorkspaceProbe {
    /// 目标路径是否是一个可被 jj-lib 识别的 workspace。
    pub is_jj_workspace: bool,
    /// 工作区根的绝对路径（规范化后）；路径不存在时回退为输入原值。
    pub workspace_root: String,
    /// 当前 working-copy commit 的十六进制 id；加载成功时必然有值。
    pub current_commit_id: Option<String>,
    /// 当前 working-copy commit 的第一个父 commit 的 id；root commit 作
    /// working-copy（尚无任何提交）时可能为 None。merge 场景下只返回第
    /// 一个父，多父情况由后续里程碑处理。
    pub parent_commit_id: Option<String>,
    /// 当前 repo 加载到的 operation id；供调试与潜在的乐观并发控制使用。
    pub operation_id: Option<String>,
}

#[napi]
pub fn probe_workspace(workspace_path: String) -> Result<WorkspaceProbe> {
    let path = std::path::Path::new(&workspace_path);
    let canonical = match path.canonicalize() {
        Ok(p) => p,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return Ok(WorkspaceProbe {
                is_jj_workspace: false,
                workspace_root: workspace_path,
                current_commit_id: None,
                parent_commit_id: None,
                operation_id: None,
            });
        }
        Err(err) => {
            return Err(Error::from_reason(format!("路径无法规范化: {err}")));
        }
    };

    if !canonical.join(".jj").exists() {
        return Ok(WorkspaceProbe {
            is_jj_workspace: false,
            workspace_root: canonical.to_string_lossy().into_owned(),
            current_commit_id: None,
            parent_commit_id: None,
            operation_id: None,
        });
    }

    let (workspace, repo) = load_workspace_and_repo(&canonical)?;

    let ws_name: &WorkspaceName = workspace.workspace_name();
    let current_commit_id_raw = repo.view().get_wc_commit_id(ws_name).cloned();
    let current_commit_id_hex = current_commit_id_raw.as_ref().map(|id| id.hex());

    let parent_commit_id_hex = if let Some(current_id) = &current_commit_id_raw {
        let commit = repo
            .store()
            .get_commit_async(current_id)
            .block_on()
            .map_err(|err| Error::from_reason(format!("读取当前 commit 失败: {err}")))?;
        commit.parent_ids().first().map(|id| id.hex())
    } else {
        None
    };

    Ok(WorkspaceProbe {
        is_jj_workspace: true,
        workspace_root: workspace.workspace_root().to_string_lossy().into_owned(),
        current_commit_id: current_commit_id_hex,
        parent_commit_id: parent_commit_id_hex,
        operation_id: Some(repo.op_id().hex()),
    })
}
