// readFileAtCommit：给定 workspace 路径 + commit id（十六进制）+ 仓库内相对
// 路径 + 字节上限，返回 { bytes, size }。作为 AsyncTask 运行。
//
// 大文件保护（对应 ROADMAP M2.5 的 OOM 保底）：Store::read_file 只吐
// Pin<Box<dyn AsyncRead + Send>>，jj-lib 不提供独立的 size API。实现策略是用
// AsyncReadExt::take 把最初的读缓冲限制在 max_file_size + 1 字节，若缓冲占满
// 说明文件超限——此时丢弃缓冲（让 Rust 侧内存峰值受 max_file_size 约束），
// 再用 64 KiB scratch 继续消耗 reader 计精确 size 但不保留字节。这样：
//   - Rust 堆占用峰值 ≈ max_file_size（用户配置的可承受值）；
//   - NAPI Buffer / JS heap 完全不 materialize 被丢弃的字节；
//   - 超限时返回的 size 是精确值，供占位文案 "(…；N 字节)" 使用。

use std::path::PathBuf;

use jj_lib::backend::{CommitId, TreeValue};
use jj_lib::repo::Repo;
use jj_lib::repo_path::RepoPathBuf;
use napi::bindgen_prelude::{AsyncTask, Buffer, Env, Error, Result, Task};
use napi_derive::napi;
use pollster::FutureExt as _;
use tokio::io::AsyncReadExt;

use crate::workspace_loader::load_workspace_and_repo;

/// TS 侧看到的 readFileAtCommit 返回形态。bytes 为 null 表示文件超过
/// maxFileSize 阈值、未加载进 NAPI Buffer；size 始终为原始文件字节数。
#[napi(object)]
pub struct FileBlob {
    pub bytes: Option<Buffer>,
    pub size: f64,
}

pub struct ReadFileAtCommitTask {
    workspace_path: PathBuf,
    commit_id_hex: String,
    repo_path: String,
    max_file_size: u64,
}

type ComputeOutput = (Option<Vec<u8>>, u64);

impl Task for ReadFileAtCommitTask {
    type Output = ComputeOutput;
    type JsValue = FileBlob;

    fn compute(&mut self) -> Result<Self::Output> {
        let (_, repo) = load_workspace_and_repo(&self.workspace_path)?;

        let commit_id = CommitId::try_from_hex(&self.commit_id_hex).ok_or_else(|| {
            Error::from_reason(format!("无效的 commit id: {}", self.commit_id_hex))
        })?;
        let repo_path: RepoPathBuf = RepoPathBuf::from_internal_string(self.repo_path.clone())
            .map_err(|err| {
                Error::from_reason(format!(
                    "无效的仓库内路径 `{}`: {err}",
                    self.repo_path
                ))
            })?;

        let commit = repo
            .store()
            .get_commit_async(&commit_id)
            .block_on()
            .map_err(|err| Error::from_reason(format!("读取 commit 失败: {err}")))?;

        let tree = commit.tree();
        let value = tree
            .path_value(&repo_path)
            .block_on()
            .map_err(|err| Error::from_reason(format!("读取 tree 条目失败: {err}")))?;

        // as_normal 对 Merge<Option<TreeValue>> 展开为 Option<&TreeValue>：
        //   - None 表示两侧存在冲突（conflicted path），M2 不处理冲突分支；
        //   - Some(&TreeValue) 下进一步按 variant 分派；非 File 变体（目录 /
        //     symlink / submodule）都不适合以 blob 字节返回，直接给 TS 侧
        //     结构化错误，由调用方决定如何向用户展示。
        let Some(tv) = value.as_normal() else {
            return Err(Error::from_reason(format!(
                "路径 `{}` 在 commit {} 下存在冲突或不存在",
                self.repo_path, self.commit_id_hex
            )));
        };

        let file_id = match tv {
            TreeValue::File { id, .. } => id.clone(),
            TreeValue::Symlink(_) => {
                return Err(Error::from_reason(format!(
                    "路径 `{}` 在 commit {} 下是 symlink，暂不支持以 blob 读取",
                    self.repo_path, self.commit_id_hex
                )));
            }
            TreeValue::Tree(_) => {
                return Err(Error::from_reason(format!(
                    "路径 `{}` 在 commit {} 下是目录",
                    self.repo_path, self.commit_id_hex
                )));
            }
            TreeValue::GitSubmodule(_) => {
                return Err(Error::from_reason(format!(
                    "路径 `{}` 在 commit {} 下是 git submodule，暂不支持读取",
                    self.repo_path, self.commit_id_hex
                )));
            }
        };

        let reader = repo
            .store()
            .read_file(&repo_path, &file_id)
            .block_on()
            .map_err(|err| Error::from_reason(format!("打开 blob 读取失败: {err}")))?;

        // take(max + 1) 让 limited.read_to_end 最多读 max+1 字节就停；若恰好
        // 读满，说明原始文件 >= max+1，即超过阈值；否则 buf 即完整内容。
        // max+1 的加法对 u64::MAX 做 saturating 防止溢出——实际用户配置到
        // u64::MAX 的可能性不存在，但保留防呆。
        let limit = self.max_file_size.saturating_add(1);
        let mut buf: Vec<u8> = Vec::new();
        let mut limited = reader.take(limit);
        limited
            .read_to_end(&mut buf)
            .block_on()
            .map_err(|err| Error::from_reason(format!("读取 blob 失败: {err}")))?;

        if buf.len() as u64 > self.max_file_size {
            // 超限：丢弃已缓冲字节，用固定 scratch 继续消耗剩余字节拿到精确
            // size。此路径不向 NAPI Buffer 投放任何字节。
            let size_read = buf.len() as u64;
            drop(buf);
            let mut inner = limited.into_inner();
            let mut scratch = [0u8; 64 * 1024];
            let mut total: u64 = size_read;
            loop {
                let n = inner
                    .read(&mut scratch)
                    .block_on()
                    .map_err(|err| Error::from_reason(format!("读取 blob 失败: {err}")))?;
                if n == 0 {
                    break;
                }
                total = total.saturating_add(n as u64);
            }
            return Ok((None, total));
        }

        let size = buf.len() as u64;
        Ok((Some(buf), size))
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        let (bytes, size) = output;
        Ok(FileBlob {
            bytes: bytes.map(Into::into),
            size: size as f64,
        })
    }
}

/// `max_file_size` 为字节数上限；0 表示"任何非空文件都判为超限"，适合 TS 侧
/// 只想拿 size 不想拿 bytes 的探测调用（stat）。napi 层接收 f64 再内部夹到
/// u64，避免 BigInt 往返但仍覆盖到 ~9 PB（f64 整数精度 2^53 字节）。
#[napi]
pub fn read_file_at_commit(
    workspace_path: String,
    commit_id: String,
    repo_path: String,
    max_file_size: f64,
) -> AsyncTask<ReadFileAtCommitTask> {
    // NaN / ±Infinity / 负数走 fallback = 0：让 native 侧把任何非空文件都判为
    // 超限，从而由调用方（TS 侧 readMaxFileSize 已过滤这些值）尽早察觉回落。
    // 合法区间内 `as u64` 按 Rust 饱和规则转换，对 > 2^64 的 f64 会落到 u64::MAX。
    let max = if max_file_size.is_finite() && max_file_size >= 0.0 {
        max_file_size as u64
    } else {
        0
    };
    AsyncTask::new(ReadFileAtCommitTask {
        workspace_path: PathBuf::from(workspace_path),
        commit_id_hex: commit_id,
        repo_path,
        max_file_size: max,
    })
}
