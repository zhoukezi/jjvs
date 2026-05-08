// readFileAtCommit：给定 workspace 路径 + commit id（十六进制）+ 仓库内
// 相对路径，返回该文件在该 commit 下的 blob 内容字节。作为 AsyncTask 运行，
// TS 侧收到 Buffer 后自行决定转码——provideTextDocumentContent 需要 string，
// 因此 TS 侧用 UTF-8 解码；VSCode diff 编辑器对于二进制会基于内容再做判断。

use std::path::PathBuf;

use jj_lib::backend::{CommitId, TreeValue};
use jj_lib::repo::Repo;
use jj_lib::repo_path::RepoPathBuf;
use napi::bindgen_prelude::{AsyncTask, Buffer, Env, Error, Result, Task};
use napi_derive::napi;
use pollster::FutureExt as _;
use tokio::io::AsyncReadExt;

use crate::workspace_loader::load_workspace_and_repo;

pub struct ReadFileAtCommitTask {
    workspace_path: PathBuf,
    commit_id_hex: String,
    repo_path: String,
}

impl Task for ReadFileAtCommitTask {
    type Output = Vec<u8>;
    type JsValue = Buffer;

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

        let mut reader = repo
            .store()
            .read_file(&repo_path, &file_id)
            .block_on()
            .map_err(|err| Error::from_reason(format!("打开 blob 读取失败: {err}")))?;
        let mut buf = Vec::new();
        reader
            .read_to_end(&mut buf)
            .block_on()
            .map_err(|err| Error::from_reason(format!("读取 blob 失败: {err}")))?;

        Ok(buf)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output.into())
    }
}

#[napi]
pub fn read_file_at_commit(
    workspace_path: String,
    commit_id: String,
    repo_path: String,
) -> AsyncTask<ReadFileAtCommitTask> {
    AsyncTask::new(ReadFileAtCommitTask {
        workspace_path: PathBuf::from(workspace_path),
        commit_id_hex: commit_id,
        repo_path,
    })
}
