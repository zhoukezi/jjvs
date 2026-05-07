#![deny(clippy::all)]

// M1 第一阶段：napi-rs 绑定脚手架。
// 目标：建立「TS 侧 -> .node -> jj-lib 可链接」的完整构建链路，并暴露一个可
// 被 TS 调用的占位 API，用于验证 .node 加载与错误冒泡路径——TS 侧采用
// fail-fast，任何加载/调用失败都直接抛错，不存在降级分支。
//
// M1 第二阶段（待做）：
//   - probe_workspace 改成真实调用 jj_lib::workspace::Workspace::load，返回
//     当前 working-copy commit id（jj-lib 0.40.0 的 Workspace / UserSettings /
//     StoreFactories 初始化签名需在 cargo check 时按实际 API 微调）。
//   - 为支撑 M2，追加：list_changes / read_file_at_commit / snapshot_working_copy /
//     get_parent_commit_id 等最小 API。

use napi::bindgen_prelude::*;
use napi_derive::napi;

/// 返回绑定自身的版本号，用于 TS 侧健康检查与版本错配排查。
#[napi]
pub fn native_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// M1 第二阶段的占位：探测给定路径是否为 jj 工作区，返回基本信息。
///
/// 目前仅做路径存在性检查与 `.jj/` 存在性检查，真实的 Workspace::load + view
/// 读取会在第二阶段替换掉这个实现。保持函数签名已经定下来，便于 TS 侧先行
/// 接入降级逻辑。
#[napi(object)]
pub struct WorkspaceProbe {
    /// 目标路径是否存在、且根目录含 `.jj/`。
    pub is_jj_workspace: bool,
    /// 工作区根的绝对路径（规范化后）；路径不存在时回退为输入原值。
    pub workspace_root: String,
    /// 当前 working-copy commit id 的十六进制表示。第一阶段恒为 None；
    /// 第二阶段接入 jj-lib 后由 view.get_wc_commit_id 填充。
    pub current_commit_id: Option<String>,
}

#[napi]
pub fn probe_workspace(workspace_path: String) -> Result<WorkspaceProbe> {
    let path = std::path::Path::new(&workspace_path);
    match path.canonicalize() {
        Ok(canonical) => {
            let is_jj = canonical.join(".jj").exists();
            Ok(WorkspaceProbe {
                is_jj_workspace: is_jj,
                workspace_root: canonical.to_string_lossy().into_owned(),
                current_commit_id: None,
            })
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            // 路径不存在在调用方语义上等同于"非 jj 工作区"，不向 TS 侧抛错。
            // 权限拒绝等其他 I/O 错误仍传播，避免把环境问题伪装成空结果。
            Ok(WorkspaceProbe {
                is_jj_workspace: false,
                workspace_root: workspace_path,
                current_commit_id: None,
            })
        }
        Err(err) => Err(Error::from_reason(format!("路径无法规范化: {err}"))),
    }
}
