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

/** 装饰 URI 广播形式：`undefined` 表示整棵树需要刷新（如 .gitignore 变更）。 */
export type DecorationChange = vscode.Uri[] | undefined;

export class JjSourceControl implements vscode.Disposable {
	private readonly sourceControl: vscode.SourceControl;
	private readonly changesGroup: vscode.SourceControlResourceGroup;
	private readonly disposables: vscode.Disposable[] = [];
	private refreshTimer: ReturnType<typeof setTimeout> | undefined;
	private refreshInFlight: Promise<void> | undefined;
	private refreshPending = false;

	/**
	 * 已改动文件的索引：绝对 fsPath → 改动类型。M2 的 SCM 面板直接把改动写进
	 * resourceStates，但 M2.1 的 FileDecorationProvider 需要按 URI 查询改动类型，
	 * 不能再从 resourceStates 反推（会丢失 kind）。
	 */
	private readonly changeIndex = new Map<string, FileChangeKind>();

	private readonly decorationEmitter =
		new vscode.EventEmitter<DecorationChange>();
	/** FileDecorationProvider 订阅此事件；undefined 表示全量刷新。 */
	readonly onDidChangeDecorations = this.decorationEmitter.event;

	constructor(public readonly folder: vscode.WorkspaceFolder) {
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

		this.disposables.push(
			this.changesGroup,
			this.sourceControl,
			this.decorationEmitter,
		);

		const watcher = vscode.workspace.createFileSystemWatcher(
			new vscode.RelativePattern(folder, "**"),
		);
		const onEvent = (uri: vscode.Uri) => {
			if (!this.shouldReactToChange(uri.fsPath)) {
				return;
			}
			// .gitignore 变更先于刷新：清掉 native ignore 缓存并广播全量装饰刷新。
			// SCM 面板数据（listChanges 结果）也会在 scheduleRefresh 之后重算，
			// 本次事件仅负责 ignore 装饰那一侧。
			if (this.isGitignorePath(uri.fsPath)) {
				loadNativeBinding().invalidateIgnoreCache(this.folder.uri.fsPath);
				this.decorationEmitter.fire(undefined);
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

	/** 判断给定 URI 是否落在本仓库内。FileDecorationProvider 路由时使用。 */
	containsUri(uri: vscode.Uri): boolean {
		if (uri.scheme !== "file") {
			return false;
		}
		const rel = path.relative(this.folder.uri.fsPath, uri.fsPath);
		return rel.length > 0 && !rel.startsWith("..") && !path.isAbsolute(rel);
	}

	/** 查询 URI 对应的改动类型；未改动返回 undefined。 */
	getChangeKind(uri: vscode.Uri): FileChangeKind | undefined {
		return this.changeIndex.get(uri.fsPath);
	}

	/**
	 * 把 URI 转成仓库内相对路径并调 native 判断是否 ignored。不做缓存——
	 * Rust 侧已经维护 GitIgnoreFile 链缓存，TS 侧再缓存会让 .gitignore 变更
	 * 后的失效传播更复杂。
	 */
	async isPathIgnored(uri: vscode.Uri): Promise<boolean> {
		if (uri.scheme !== "file") {
			return false;
		}
		const rel = path.relative(this.folder.uri.fsPath, uri.fsPath);
		if (rel.length === 0 || rel.startsWith("..") || path.isAbsolute(rel)) {
			return false;
		}
		const repoPath = rel.split(path.sep).join("/");
		return loadNativeBinding().isPathIgnored(this.folder.uri.fsPath, repoPath);
	}

	private isGitignorePath(fsPath: string): boolean {
		return path.basename(fsPath) === ".gitignore";
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

		// 维护 changeIndex 并广播装饰刷新：
		//   - 新进入改动集合的路径：需要出现徽标；
		//   - 离开改动集合的路径：需要去掉徽标；
		//   - 集合内但 kind 变了（modified → removed 等）：需要换徽标。
		// 合并成统一的 "影响 URI 列表" 发给 FileDecorationProvider。
		const previous = new Map(this.changeIndex);
		this.changeIndex.clear();
		for (const change of result.changes) {
			const fsPath = repoPathToFsPath(result.workspaceRoot, change.path);
			this.changeIndex.set(fsPath, change.kind);
		}

		const affected = new Set<string>();
		for (const [fsPath, kind] of previous) {
			if (this.changeIndex.get(fsPath) !== kind) {
				affected.add(fsPath);
			}
		}
		for (const [fsPath, kind] of this.changeIndex) {
			if (previous.get(fsPath) !== kind) {
				affected.add(fsPath);
			}
		}
		if (affected.size > 0) {
			this.decorationEmitter.fire(
				Array.from(affected, (fsPath) => vscode.Uri.file(fsPath)),
			);
		}
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
	// 仓库级装饰事件的订阅 disposable：每个 JjSourceControl 进入 manager 时
	// 订阅一次，仓库从 workspace 移除时单独 dispose 订阅；不依赖 repo.dispose
	// 去级联，因为订阅的接收方是 manager 自身的 emitter。
	private readonly repoDecorationSubs = new Map<string, vscode.Disposable>();

	private readonly decorationEmitter =
		new vscode.EventEmitter<DecorationChange>();
	/** 聚合所有仓库的装饰事件；FileDecorationProvider 订阅此事件。 */
	readonly onDidChangeDecorations = this.decorationEmitter.event;

	start(): void {
		this.syncAll();
		this.disposables.push(
			this.decorationEmitter,
			vscode.workspace.onDidChangeWorkspaceFolders(() => this.syncAll()),
		);
	}

	/** 在所有已识别仓库中查找包含给定 URI 的那一个。 */
	findRepoFor(uri: vscode.Uri): JjSourceControl | undefined {
		for (const repo of this.repositories.values()) {
			if (repo.containsUri(uri)) {
				return repo;
			}
		}
		return undefined;
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
				const repo = new JjSourceControl(folder);
				this.repositories.set(key, repo);
				const sub = repo.onDidChangeDecorations((change) =>
					this.decorationEmitter.fire(change),
				);
				this.repoDecorationSubs.set(key, sub);
			}
		}

		for (const key of Array.from(this.repositories.keys())) {
			if (!desired.has(key)) {
				this.repoDecorationSubs.get(key)?.dispose();
				this.repoDecorationSubs.delete(key);
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
		for (const sub of this.repoDecorationSubs.values()) {
			sub.dispose();
		}
		this.repoDecorationSubs.clear();
		for (const repo of this.repositories.values()) {
			repo.dispose();
		}
		this.repositories.clear();
	}
}
