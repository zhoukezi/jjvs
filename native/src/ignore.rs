// isPathIgnored：给定 workspace 路径 + 仓库内相对路径，返回该路径是否被 jj
// 视为 ignored。用于 M2.4 在 Explorer / 编辑器 tab 上暗化被忽略的文件。
//
// 实现策略：jj-lib 没有暴露"直接判断某路径是否 ignored"的高层 API，其 ignore
// 逻辑内嵌在 LocalWorkingCopy 的 snapshot 流程中——每进入一个目录都调用
// GitIgnoreFile::chain_with_file(prefix, dir/.gitignore) 把该目录的规则叠加
// 到链上。这里复用同一套链式构造：为目标路径的父目录（含其祖先链）按需累积
// GitIgnoreFile，然后用 matches() 做判断。
//
// 缓存：Explorer 展开大目录时会对每个子项调用 provideFileDecoration，若每次
// 都 重新读盘所有 .gitignore 会把 libuv 线程池打满。因此维护一个按 workspace
// 划分的按目录内部字符串（`""` / `"dir/"` / `"dir/sub/"`）索引的
// Arc<GitIgnoreFile> 缓存。缓存由 TS 侧在检测到 .gitignore 变更时通过
// invalidate_ignore_cache 主动清空，不做 TTL / mtime 检查——过期 ignore 状
// 态至多影响到下一次刷新事件。
//
// 与 changes.rs 的 base_ignores 关系：当前 list_changes 把 base_ignores 设
// 为 GitIgnoreFile::empty()（ROADMAP 未决问题之一，未接入全局 gitignore /
// core.excludesFile / info/exclude），这里保持一致——都只识别 repo 内的
// `.gitignore`，不读全局规则。后续若把 base_ignores 接入 gix 读出的全局规
// 则，应把 compute_chain_for_dir 的根 chain 从 GitIgnoreFile::empty() 替
// 换为同一份 base_ignores，保证 SCM 状态与装饰判断口径一致。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use jj_lib::gitignore::GitIgnoreFile;
use napi::bindgen_prelude::{AsyncTask, Env, Error, Result, Task};
use napi_derive::napi;

type PerWorkspaceCache = HashMap<String, Arc<GitIgnoreFile>>;
type GlobalCache = HashMap<PathBuf, PerWorkspaceCache>;

fn cache() -> &'static Mutex<GlobalCache> {
    static CACHE: OnceLock<Mutex<GlobalCache>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 构造或复用 `workspace_root` 下、内部目录字符串 `dir_internal` 对应的
/// 累积 GitIgnoreFile。`dir_internal` 形式：
///   - `""`：workspace 根
///   - `"a/"`：workspace 根下的 a 目录
///   - `"a/b/"`：a/b 目录（末尾永远带 `/`）
fn compute_chain_for_dir(
    workspace_root: &Path,
    dir_internal: &str,
) -> Result<Arc<GitIgnoreFile>> {
    {
        let guard = cache().lock().expect("ignore cache poisoned");
        if let Some(ws_cache) = guard.get(workspace_root) {
            if let Some(chain) = ws_cache.get(dir_internal) {
                return Ok(chain.clone());
            }
        }
    }

    // 先递归拿父级链，不持锁以避免跨层 lock。
    let parent_chain = if dir_internal.is_empty() {
        GitIgnoreFile::empty()
    } else {
        let parent_internal = parent_dir_internal(dir_internal);
        compute_chain_for_dir(workspace_root, &parent_internal)?
    };

    let dir_disk_path = if dir_internal.is_empty() {
        workspace_root.to_path_buf()
    } else {
        // 去掉末尾 `/` 再 join，避免平台差异。
        workspace_root.join(dir_internal.trim_end_matches('/'))
    };
    let gitignore_path = dir_disk_path.join(".gitignore");

    let chain = if gitignore_path.is_file() {
        parent_chain
            .chain_with_file(dir_internal, gitignore_path.clone())
            .map_err(|err| {
                Error::from_reason(format!(
                    "加载 .gitignore 失败 `{}`: {err}",
                    gitignore_path.display()
                ))
            })?
    } else {
        parent_chain
    };

    let mut guard = cache().lock().expect("ignore cache poisoned");
    let ws_cache = guard.entry(workspace_root.to_path_buf()).or_default();
    ws_cache.insert(dir_internal.to_string(), chain.clone());
    Ok(chain)
}

/// 对以 `/` 结尾的目录内部字符串，取其父目录的内部字符串。根（`""`）没有父
/// 级，调用方需先判断 `dir_internal` 是否为空再决定是否递归。
fn parent_dir_internal(dir_internal: &str) -> String {
    debug_assert!(dir_internal.ends_with('/'), "dir_internal 应以 / 结尾");
    let without_trailing = &dir_internal[..dir_internal.len() - 1];
    match without_trailing.rfind('/') {
        Some(idx) => without_trailing[..=idx].to_string(),
        None => String::new(),
    }
}

pub struct IsPathIgnoredTask {
    workspace_path: PathBuf,
    repo_path: String,
}

impl Task for IsPathIgnoredTask {
    type Output = bool;
    type JsValue = bool;

    fn compute(&mut self) -> Result<Self::Output> {
        // 规范化输入：传入的 repo_path 预期是正斜杠分隔、不带前导 `/` 的仓
        // 库内路径。去掉意外的前后 `/` 再判断；空串视为根，根永不 ignored。
        let trimmed = self
            .repo_path
            .trim_start_matches('/')
            .trim_end_matches('/');
        if trimmed.is_empty() {
            return Ok(false);
        }

        let parent_internal = match trimmed.rfind('/') {
            Some(idx) => trimmed[..=idx].to_string(),
            None => String::new(),
        };
        let chain = compute_chain_for_dir(&self.workspace_path, &parent_internal)?;

        // 与 jj-lib snapshot 内部保持一致：目录以 `dir/` 形式 match、文件以
        // `dir/file` 形式 match。磁盘上不存在的路径按文件处理，因为
        // GitIgnoreFile::matches 不会访问磁盘。
        let disk_path = self.workspace_path.join(trimmed);
        let test_path = if disk_path.is_dir() {
            format!("{trimmed}/")
        } else {
            trimmed.to_string()
        };

        Ok(chain.matches(&test_path))
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

#[napi]
pub fn is_path_ignored(
    workspace_path: String,
    repo_path: String,
) -> AsyncTask<IsPathIgnoredTask> {
    AsyncTask::new(IsPathIgnoredTask {
        workspace_path: PathBuf::from(workspace_path),
        repo_path,
    })
}

/// 清空指定 workspace 下的 ignore 链缓存。TS 侧在检测到 `.gitignore` 变更
/// 时调用。传入路径与 Workspace::load 期望的路径形式一致（绝对路径）。
#[napi]
pub fn invalidate_ignore_cache(workspace_path: String) {
    let key = PathBuf::from(workspace_path);
    let mut guard = cache().lock().expect("ignore cache poisoned");
    guard.remove(&key);
}
