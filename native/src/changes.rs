// listChanges：加载 workspace → 校验 wc 与 repo 的 freshness → snapshot 当前
// 工作区 → 取 @ 的第一个父的 tree 做 diff → finish 把 snapshot 固化到磁盘。
// 以 AsyncTask 运行，避免阻塞 extension host 主线程。
//
// freshness 分支对齐 jj CLI 的 snapshot_working_copy 流程：只有 Fresh / Updated
// 会真正 snapshot+finish；WorkingCopyStale / SiblingOperation 直接放弃锁、不
// 固化任何写入，并向 TS 侧回报 stale outcome 让用户自行运行 `jj workspace
// update-stale`。如果跳过这一步，SCM 面板的每次刷新都等于用 head op 盲目覆盖
// wc 原本持有的 op id，会抹掉其他 workspace / 并发 jj 命令的进度。
//
// M2 不做 rename 检测。原因：jj 的 copy/rename 信息来自 store.get_copy_records，
// 而它只能基于已 commit 的 tree 对比；要真正拿到 working-copy rename，必须
// 像 jj CLI 那样在 snapshot 之后开 transaction rewrite @——那会让每次 SCM
// 刷新都在 `jj op log` 里多一条 "snapshot working copy" 条目。ROADMAP 把这
// 部分与后续 jj 命令集成一并推进。现阶段 working-copy 里的 rename 只会显示
// 成 added + removed 两条，这与当前阶段不 rewrite @ 的语义是一致的，不假装
// 支持。

use std::path::PathBuf;
use std::sync::Arc;

use futures::StreamExt as _;
use jj_lib::gitignore::GitIgnoreFile;
use jj_lib::id_prefix::IdPrefixContext;
use jj_lib::matchers::{EverythingMatcher, NothingMatcher};
use jj_lib::object_id::ObjectId;
use jj_lib::repo::Repo;
use jj_lib::revset::RevsetExtensions;
use jj_lib::working_copy::{SnapshotOptions, WorkingCopyFreshness};
use napi::bindgen_prelude::{AsyncTask, Env, Error, Result, Task};
use napi_derive::napi;
use pollster::FutureExt as _;

use crate::workspace_loader::load_workspace_and_repo;

/// stale outcome 的 kind 标签。对齐 `WorkingCopyFreshness` 的两种"不应继续
/// snapshot" 状态：
///
/// - `wc_stale`：wc 落后 repo，需要跑 `jj workspace update-stale`；
/// - `sibling`：wc 与 repo head 分叉成 sibling operations，需要 `jj op log`
///   结合 `jj op abandon` / 重建合并。
///
/// TS 侧以字符串形式比对；这两个常量在 Rust 和 TS 都复制一份，改动时两边同步。
const STALE_KIND_WC_STALE: &str = "wc_stale";
const STALE_KIND_SIBLING: &str = "sibling";

/// change_id 前缀的最小展示宽度。jj CLI 默认模板 `shortest(change_id, 8)`
/// 在最短唯一前缀短于 8 位时会填充至 8 位；VSCode 状态栏展示对齐此行为。
const MIN_CHANGE_ID_PREFIX_LEN: usize = 8;

/// 单个文件变更。`path` 使用 jj 的内部路径形式（相对仓库根的正斜杠字符串），
/// TS 侧负责拼 workspace_root 还原成绝对路径。
#[napi(object)]
pub struct FileChange {
    /// 变更类型："added" | "modified" | "removed"。
    pub kind: String,
    /// 文件路径。`removed` 时仍用原路径填此字段，便于 TS 侧统一按
    /// resourceUri 标识文件身份。
    pub path: String,
}

/// stale 发生时的原因载体。`kind` 取自 `STALE_KIND_*`；`message` 用于直接
/// 展示给用户的中文提示，不做二次翻译。
#[napi(object)]
pub struct ListChangesStale {
    pub kind: String,
    pub message: String,
}

/// listChanges 的顶层返回。`stale` 与 `data` 互斥：stale 非空时 data 为 None，
/// 调用方应保留上一帧 SCM 视图并把 stale 信息透出到状态栏；data 非空时是
/// 正常刷新结果。之所以不通过 Promise.reject 表达 stale——因为它是预期的
/// 业务状态（并发 jj 操作很常见），reject 在 JS 侧会混进"真正的异常"（如
/// 仓库损坏），让 TS 侧难以稳定区分。
#[napi(object)]
pub struct ListChangesOutcome {
    pub stale: Option<ListChangesStale>,
    pub data: Option<ListChangesResult>,
}

#[napi(object)]
pub struct ListChangesResult {
    /// workspace 绝对路径，TS 侧用于拼文件的绝对路径与构造自定义 URI。
    pub workspace_root: String,
    /// 当前 working-copy commit id（十六进制）。
    pub current_commit_id: String,
    /// 当前 working-copy commit 的 change_id，用 reverse_hex 形式（字符集
    /// k-z，对齐 jj CLI 展示约定，以避免与 commit_id 的标准 hex 混淆）。
    /// 状态栏 tooltip 要展示完整 change_id；前缀由 `current_change_id_prefix`
    /// 单独回传。
    pub current_change_id: String,
    /// 当前 change_id 的最短唯一前缀（对齐 jj CLI 默认模板
    /// `shortest(change_id, 8)`，同为 reverse_hex 形式）。通过 `IdPrefixContext`
    /// 计算最短不冲突长度，不足 8 位时填充至 8 位，超过 8 位时按实际长度返回。
    pub current_change_id_prefix: String,
    /// 当前 commit 的 description（原文，保留换行）。空 description 返回空串，
    /// TS 侧据此决定 tooltip 是否渲染该行。
    pub current_description: String,
    /// 当前 working-copy commit 上贴着的所有 local bookmark 名。顺序来自
    /// jj-lib 的 `View::local_bookmarks_for_commit`，TS 侧根据 pin 列表再排序。
    pub current_bookmarks: Vec<String>,
    /// 第一个父 commit id（十六进制）。merge commit 只取第一个父；
    /// `parent_tree` 也是从这个父 commit 读出，保证 diff 左侧与 TS 侧收到
    /// 的 parent_commit_id 指向同一棵 tree。
    pub parent_commit_id: String,
    /// 本次 snapshot 固化所用的 operation id——也就是 `finish(op_id)` 的参数。
    /// Fresh 分支下等于 repo head op；`Updated(wc_op)` 分支下等于 wc_op（因为
    /// 已按 wc 视角 reload repo，`repo.op_id() == wc_op.id()`）。TS 侧不应据此
    /// 做跨刷新的新鲜度判断，因为并发另一进程推进 head 后，wc 未 update 前
    /// 我们会反复回报同一个 wc_op。
    pub operation_id: String,
    /// 变更列表。列表按 diff stream 返回顺序排列，TS 侧若需展示顺序可再排序。
    pub changes: Vec<FileChange>,
}

pub struct ListChangesTask {
    workspace_path: PathBuf,
}

impl Task for ListChangesTask {
    type Output = ListChangesOutcome;
    type JsValue = ListChangesOutcome;

    fn compute(&mut self) -> Result<Self::Output> {
        let (mut workspace, repo) = load_workspace_and_repo(&self.workspace_path)?;
        let workspace_root = workspace.workspace_root().to_string_lossy().into_owned();

        let ws_name = workspace.workspace_name().to_owned();
        let initial_wc_commit_id = repo
            .view()
            .get_wc_commit_id(&ws_name)
            .ok_or_else(|| {
                Error::from_reason(format!(
                    "jj view 中未找到 workspace `{}` 的 working-copy commit",
                    ws_name.as_str()
                ))
            })?
            .clone();
        let initial_wc_commit = repo
            .store()
            .get_commit_async(&initial_wc_commit_id)
            .block_on()
            .map_err(|err| Error::from_reason(format!("读取当前 commit 失败: {err}")))?;

        // 先锁 wc，再跑 freshness 检测：check_stale 需要 `&dyn LockedWorkingCopy`
        // 形态的 wc 句柄。锁本身只是文件锁，不会真写磁盘；freshness 为 stale 时
        // 直接 drop locked_ws，锁会在作用域结束随之释放，wc 状态保持原样。
        let mut locked_ws = workspace
            .start_working_copy_mutation()
            .map_err(|err| Error::from_reason(format!("锁定 working copy 失败: {err}")))?;

        let freshness = WorkingCopyFreshness::check_stale(
            locked_ws.locked_wc(),
            &initial_wc_commit,
            repo.as_ref(),
        )
        .block_on()
        .map_err(|err| Error::from_reason(format!("检查 working copy 新鲜度失败: {err}")))?;

        // 对齐 jj CLI 的 snapshot_working_copy：
        //   Fresh                 → 以当前 repo 视角继续；
        //   Updated(wc_op)        → 并发另一个进程已把 wc checkpoint 到更新的
        //                           op，用 wc_op reload repo 后以 wc 视角继续，
        //                           避免用 head 的 op 覆写 wc.old_operation_id
        //                           而丢失对方进度；
        //   WorkingCopyStale      → wc 落后 repo，且 tree 不一致，直接返回 stale
        //                           outcome 让用户跑 `jj workspace update-stale`；
        //   SiblingOperation      → wc 与 repo head 是 sibling ops，同样返回 stale
        //                           让用户用 `jj op log` 处理。
        // 后两种分支：提前返回，Drop locked_ws 不调用 finish，磁盘零写入。
        let (repo, current_commit) = match freshness {
            WorkingCopyFreshness::Fresh => (repo, initial_wc_commit),
            WorkingCopyFreshness::Updated(wc_op) => {
                // locked_ws 持有 &mut workspace，不能再借 workspace.repo_loader()；
                // 改走 ReadonlyRepo::loader()，与 workspace 侧拿到的 loader 是
                // 同一个（RepoLoader clone 语义），语义等价。
                let new_repo = repo
                    .loader()
                    .load_at(&wc_op)
                    .block_on()
                    .map_err(|err| {
                        Error::from_reason(format!(
                            "按 wc 的 operation 重新加载 repo 失败: {err}"
                        ))
                    })?;
                let new_wc_commit_id = new_repo
                    .view()
                    .get_wc_commit_id(&ws_name)
                    .ok_or_else(|| {
                        Error::from_reason(format!(
                            "按 wc op reload 后，jj view 中未找到 workspace `{}` 的 working-copy commit",
                            ws_name.as_str()
                        ))
                    })?
                    .clone();
                let new_wc_commit = new_repo
                    .store()
                    .get_commit_async(&new_wc_commit_id)
                    .block_on()
                    .map_err(|err| {
                        Error::from_reason(format!("reload 后读取 wc commit 失败: {err}"))
                    })?;
                (new_repo, new_wc_commit)
            }
            WorkingCopyFreshness::WorkingCopyStale => {
                return Ok(ListChangesOutcome {
                    stale: Some(ListChangesStale {
                        kind: STALE_KIND_WC_STALE.to_string(),
                        message: "workspace 的 working copy 落后于 repo 当前 operation，请运行 `jj workspace update-stale` 同步。".to_string(),
                    }),
                    data: None,
                });
            }
            WorkingCopyFreshness::SiblingOperation => {
                return Ok(ListChangesOutcome {
                    stale: Some(ListChangesStale {
                        kind: STALE_KIND_SIBLING.to_string(),
                        message: "workspace 的 operation 与 repo head 是并行 sibling，请通过 `jj op log` 检查并合并。".to_string(),
                    }),
                    data: None,
                });
            }
        };

        let current_commit_id = current_commit.id().clone();

        // change_id 用 reverse_hex（字符集 k-z）——对齐 jj CLI 的展示约定：
        // commit_id 用标准 hex（0-9a-f），change_id 用 reverse hex 以避免与
        // commit_id 混淆。jj-lib 的 IdPrefixContext::shortest_change_prefix_len
        // 内部基于 ChangeId::to_string() 的 reverse_hex 形式计算字符长度，所以
        // 返回的 len 可直接作为 reverse_hex 字符串的截取位置。
        //
        // 状态栏前缀对齐 jj CLI 默认模板 `shortest(change_id, 8)`：最短唯一
        // 前缀不足 8 字符时补齐至 8。
        let current_change_id = current_commit.change_id().reverse_hex();
        let prefix_ctx = IdPrefixContext::new(Arc::new(RevsetExtensions::default()));
        let prefix_index = prefix_ctx
            .populate(repo.as_ref())
            .map_err(|err| Error::from_reason(format!("构建 IdPrefixIndex 失败: {err}")))?;
        let prefix_len_min = prefix_index
            .shortest_change_prefix_len(repo.as_ref(), current_commit.change_id())
            .map_err(|err| Error::from_reason(format!("计算 change id 前缀失败: {err}")))?;
        let effective_len = prefix_len_min.max(MIN_CHANGE_ID_PREFIX_LEN);
        // reverse_hex 字符集 k-z 是纯 ASCII，按字符切片等价于按字节切片；
        // shortest_change_prefix_len 返回长度不超过 change_id 的 reverse_hex
        // 总长，故 effective_len ≤ current_change_id.len() 成立。
        let current_change_id_prefix = current_change_id[..effective_len].to_string();

        // 当前 commit 贴着的 local bookmark 名字。顺序来自 jj-lib 的迭代器，
        // TS 侧按配置 pin 列表再排序。
        let current_bookmarks: Vec<String> = repo
            .view()
            .local_bookmarks_for_commit(&current_commit_id)
            .map(|(name, _)| name.as_str().to_owned())
            .collect();

        // description 以单一字符串返回，可能为空、可能含嵌入换行。状态栏
        // tooltip 自行决定是否/如何截断渲染。
        let current_description = current_commit.description().to_owned();

        let parent_commit_id = current_commit
            .parent_ids()
            .first()
            .cloned()
            .ok_or_else(|| Error::from_reason("当前 commit 没有父 commit".to_string()))?;
        let parent_commit = repo
            .store()
            .get_commit_async(&parent_commit_id)
            .block_on()
            .map_err(|err| Error::from_reason(format!("读取父 commit 失败: {err}")))?;
        let parent_tree = parent_commit.tree();

        let options = SnapshotOptions {
            base_ignores: GitIgnoreFile::empty(),
            progress: None,
            start_tracking_matcher: &EverythingMatcher,
            force_tracking_matcher: &NothingMatcher,
            max_new_file_size: u64::MAX,
        };
        // locked_ws 已在 freshness 分支之前取得，这里直接复用。
        let (wc_tree, _stats) = locked_ws
            .locked_wc()
            .snapshot(&options)
            .block_on()
            .map_err(|err| Error::from_reason(format!("snapshot working copy 失败: {err}")))?;

        let mut diff_stream = parent_tree.diff_stream(&wc_tree, &EverythingMatcher);
        let mut changes: Vec<FileChange> = Vec::new();
        while let Some(entry) = diff_stream.next().block_on() {
            let values = entry
                .values
                .map_err(|err| Error::from_reason(format!("解析 diff 条目失败: {err}")))?;
            let before_absent = values.before.is_absent();
            let after_absent = values.after.is_absent();
            let kind: &'static str = match (before_absent, after_absent) {
                // diff stream 不会产出两侧都缺失的条目
                (true, true) => continue,
                (true, false) => "added",
                (false, true) => "removed",
                (false, false) => "modified",
            };
            changes.push(FileChange {
                kind: kind.to_string(),
                path: entry.path.as_internal_file_string().to_string(),
            });
        }

        // 把 snapshot 固化回 .jj/working_copy/tree_state。此时并未 rewrite @，
        // 下次 jj CLI 运行时会基于 tree_state != wc_commit.tree() 的判断自行
        // rewrite @，用户磁盘状态不会丢失。
        let op_id = repo.op_id().clone();
        locked_ws
            .finish(op_id.clone())
            .block_on()
            .map_err(|err| Error::from_reason(format!("保存 working copy 状态失败: {err}")))?;

        Ok(ListChangesOutcome {
            stale: None,
            data: Some(ListChangesResult {
                workspace_root,
                current_commit_id: current_commit_id.hex(),
                current_change_id,
                current_change_id_prefix,
                current_description,
                current_bookmarks,
                parent_commit_id: parent_commit_id.hex(),
                operation_id: op_id.hex(),
                changes,
            }),
        })
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

#[napi]
pub fn list_changes(workspace_path: String) -> AsyncTask<ListChangesTask> {
    AsyncTask::new(ListChangesTask {
        workspace_path: PathBuf::from(workspace_path),
    })
}
