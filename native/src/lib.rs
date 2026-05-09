#![deny(clippy::all)]

// jjvs 的 napi-rs 绑定。职责边界：把 jj-lib 的若干能力包成 Node 侧可调用的
// 最小 API 集合，供 TS 侧驱动 SCM Provider 与 diff 视图。
//
// 设计要点：
//   - 同步入口（native_version / probe_workspace）走 #[napi] 同步函数，
//     适用于激活期健康检查、低开销探测。
//   - 涉及磁盘 I/O / snapshot / blob 读取的 API 走 AsyncTask：
//     compute() 在 libuv 线程池运行，jj-lib 的 async 调用由 pollster 拉平为
//     同步，不拉进 tokio。这样既不阻塞 extension host 主线程，也避免引入
//     整套 tokio runtime。
//   - 所有错误统一 map 成 napi::Error::from_reason(format!(...)) 带上 jj-lib
//     的错误文本，TS 侧按 Promise.reject / throw 语义处理；不做 Option<T>
//     伪装空结果，不吞错。

mod blob;
mod changes;
mod colocation;
mod ignore;
mod logger;
mod probe;
mod workspace_loader;

use napi_derive::napi;

/// 返回绑定自身的版本号，用于 TS 侧健康检查与版本错配排查。
#[napi]
pub fn native_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

pub use blob::{read_file_at_commit, ReadFileAtCommitTask};
pub use changes::{
    list_changes, FileChange, ListChangesOutcome, ListChangesResult, ListChangesStale,
    ListChangesTask,
};
pub use colocation::is_colocated_workspace;
pub use ignore::{invalidate_ignore_cache, is_path_ignored, IsPathIgnoredTask};
pub use logger::{set_native_log_level, set_native_logger, NativeLogPayload};
pub use probe::{probe_workspace, WorkspaceProbe};
