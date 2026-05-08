import * as path from "node:path";

import * as vscode from "vscode";

import type { FileChangeForDiff } from "./diff";
import {
	type FileChange,
	type FileChangeKind,
	type ListChangesResult,
	loadNativeBinding,
} from "./native";
import { isJjRepository } from "./repository";

// 刷新防抖：批量吸收文件系统事件（编辑、保存、外部工具写入）产生的抖动，
// 避免对同一批改动连续触发多次 snapshot + diff。300 ms 足以合并 IDE 单次
// 保存引发的多条事件，又不会让用户感到面板明显滞后。
const REFRESH_DEBOUNCE_MS = 300;

const KIND_ICON: Record<FileChangeKind, string> = {
	added: "diff-added",
	modified: "diff-modified",
	removed: "diff-removed",
};

const KIND_LABEL: Record<FileChangeKind, string> = {
	added: "新增",
	modified: "修改",
	removed: "删除",
};

function repoPathToFsPath(workspaceRoot: string, repoPath: string): string {
	// jj 的内部路径永远用 `/`，VSCode / Node 在 Linux 下也用 `/`，M1 阶段仅支
	// 持 Linux x86_64，不需要 PathSeparator 转换。跨平台时在此处集中转。
	return path.join(workspaceRoot, repoPath);
}

function buildResourceState(
	workspaceRoot: string,
	parentCommitId: string,
	change: FileChange,
): vscode.SourceControlResourceState {
	const fsPath = repoPathToFsPath(workspaceRoot, change.path);

	const payload: FileChangeForDiff = {
		kind: change.kind,
		workspaceRoot,
		parentCommitId,
		fsPath,
		repoPath: change.path,
	};

	return {
		resourceUri: vscode.Uri.file(fsPath),
		decorations: {
			iconPath: new vscode.ThemeIcon(KIND_ICON[change.kind]),
			strikeThrough: change.kind === "removed",
			tooltip: KIND_LABEL[change.kind],
		},
		command: {
			command: "jjvs.openDiff",
			title: "查看文件改动",
			arguments: [payload],
		},
	};
}

class JjSourceControl implements vscode.Disposable {
	private readonly sourceControl: vscode.SourceControl;
	private readonly changesGroup: vscode.SourceControlResourceGroup;
	private readonly disposables: vscode.Disposable[] = [];
	private refreshTimer: ReturnType<typeof setTimeout> | undefined;
	private refreshInFlight: Promise<void> | undefined;
	private refreshPending = false;

	constructor(private readonly folder: vscode.WorkspaceFolder) {
		this.sourceControl = vscode.scm.createSourceControl(
			"jjvs",
			"Jujutsu",
			folder.uri,
		);
		this.sourceControl.inputBox.placeholder = "提交输入暂未实现";

		this.changesGroup = this.sourceControl.createResourceGroup(
			"jjvs.changes",
			"工作副本变更",
		);
		this.changesGroup.hideWhenEmpty = true;

		this.disposables.push(this.changesGroup, this.sourceControl);

		const watcher = vscode.workspace.createFileSystemWatcher(
			new vscode.RelativePattern(folder, "**"),
		);
		const onEvent = (uri: vscode.Uri) => {
			if (!this.shouldReactToChange(uri.fsPath)) {
				return;
			}
			this.scheduleRefresh();
		};
		this.disposables.push(
			watcher,
			watcher.onDidChange(onEvent),
			watcher.onDidCreate(onEvent),
			watcher.onDidDelete(onEvent),
		);

		void this.refresh();
	}

	private shouldReactToChange(fsPath: string): boolean {
		const rel = path.relative(this.folder.uri.fsPath, fsPath);
		if (rel.startsWith("..")) {
			return false;
		}
		const first = rel.split(path.sep, 1)[0];
		if (first !== ".jj") {
			// 工作区内的普通文件改动一律触发刷新。
			return true;
		}
		// `.jj/` 下只关心 op_heads 的移动——代表执行了 jj 操作（new / restore /
		// describe 等）。其他如 working_copy/tree_state 会被我们自己的 snapshot
		// 写入，若也触发刷新就形成循环。
		//
		// colocated 仓库下 `.jj/repo` 是 `.git` 同级的 jj 元数据目录，op_heads
		// 位于 `.jj/repo/op_heads/`；独立 jj 仓库 op_heads 直接在 `.jj/op_heads/`。
		// 两种布局都覆盖。
		return rel.includes(`${path.sep}op_heads${path.sep}`);
	}

	private scheduleRefresh(): void {
		if (this.refreshTimer) {
			clearTimeout(this.refreshTimer);
		}
		this.refreshTimer = setTimeout(() => {
			this.refreshTimer = undefined;
			void this.refresh();
		}, REFRESH_DEBOUNCE_MS);
	}

	private async refresh(): Promise<void> {
		// 串行化：同一时间只允许一次 listChanges 在飞行中（含 snapshot+finish 会
		// 写 .jj/working_copy/，并发调用会触发锁争用）。若刷新进行中又收到新请
		// 求，记一个 pending 位，完成后再跑一次即可，不排队多条。
		if (this.refreshInFlight) {
			this.refreshPending = true;
			return;
		}
		this.refreshInFlight = this.doRefresh().finally(() => {
			this.refreshInFlight = undefined;
			if (this.refreshPending) {
				this.refreshPending = false;
				void this.refresh();
			}
		});
		await this.refreshInFlight;
	}

	private async doRefresh(): Promise<void> {
		let result: ListChangesResult;
		try {
			result = await loadNativeBinding().listChanges(this.folder.uri.fsPath);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			// 刷新失败在 VSCode 里没有天然的展示位（SCM 面板本身没有错误状态），
			// 弹窗 + Output 风格都过重；先走 console，后续里程碑有 Output 通道时
			// 集中到通道。不把错误吞了——抛错会中断 promise 链，这里记录后保持
			// 现有 resourceStates 不动，让用户感知到 diff 没变但不会卡死面板。
			console.error(`[jjvs] 刷新失败：${message}`);
			return;
		}

		const states = result.changes.map((change) =>
			buildResourceState(result.workspaceRoot, result.parentCommitId, change),
		);
		this.changesGroup.resourceStates = states;
		this.sourceControl.count = states.length;
	}

	dispose(): void {
		if (this.refreshTimer) {
			clearTimeout(this.refreshTimer);
			this.refreshTimer = undefined;
		}
		for (const d of this.disposables) {
			d.dispose();
		}
		this.disposables.length = 0;
	}
}

export class JjRepositoryManager implements vscode.Disposable {
	private readonly repositories = new Map<string, JjSourceControl>();
	private readonly disposables: vscode.Disposable[] = [];

	start(): void {
		this.syncAll();
		this.disposables.push(
			vscode.workspace.onDidChangeWorkspaceFolders(() => this.syncAll()),
		);
	}

	private syncAll(): void {
		const folders = vscode.workspace.workspaceFolders ?? [];
		const desired = new Set<string>();

		for (const folder of folders) {
			if (!isJjRepository(folder.uri)) {
				continue;
			}
			const key = folder.uri.toString();
			desired.add(key);
			if (!this.repositories.has(key)) {
				this.repositories.set(key, new JjSourceControl(folder));
			}
		}

		for (const key of Array.from(this.repositories.keys())) {
			if (!desired.has(key)) {
				this.repositories.get(key)?.dispose();
				this.repositories.delete(key);
			}
		}
	}

	dispose(): void {
		for (const d of this.disposables) {
			d.dispose();
		}
		this.disposables.length = 0;
		for (const repo of this.repositories.values()) {
			repo.dispose();
		}
		this.repositories.clear();
	}
}
