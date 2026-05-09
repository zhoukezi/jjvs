import * as path from "node:path";

import * as vscode from "vscode";

import { buildDiffUri, type FileChangeForDiff } from "./diff";
import * as logger from "./logger";
import {
	type FileChange,
	type FileChangeKind,
	type ListChangesOutcome,
	type ListChangesStale,
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

/** quickDiffProvider 的启用模式，与 `jjvs.quickDiff.mode` 配置 schema 一一对应。 */
type QuickDiffMode = "auto" | "enabled" | "disabled";

const QUICK_DIFF_CONFIG_KEY = "jjvs.quickDiff.mode";

/**
 * 单个仓库的状态摘要。`JjStatusBar` 订阅此结构渲染状态栏主体与 tooltip。
 * 字段来源：`listChanges` 的扩展返回值，在 `doRefresh` 成功末尾一次性广播。
 */
export interface JjRepoSummary {
	readonly folder: vscode.WorkspaceFolder;
	readonly changeId: string;
	readonly changeIdPrefix: string;
	readonly commitId: string;
	readonly description: string;
	readonly bookmarks: readonly string[];
	/**
	 * workspace stale 状态。非 null 时表示 native 侧的 freshness 检查命中了
	 * `WorkingCopyStale` 或 `SiblingOperation`，此时上一帧 SCM 数据保留不动，
	 * 状态栏以 stale 徽记 + tooltip 引导用户通过 jj CLI 处理。null 表示一次
	 * 正常的 Fresh / Updated 刷新已成功提交到磁盘。
	 *
	 * 骨架 summary 契约：若首帧刷新就命中 stale（尚无上一帧可保留），`doRefresh`
	 * 会构造一条仅 `folder` 与 `stale` 有效、其它字段（`changeId` / `commitId`
	 * / `description` / `bookmarks` 等）全为零值的 summary；下游如 `JjStatusBar`
	 * 可据此（例如 `changeId.length === 0`）判断要不要渲染上一帧信息。
	 */
	readonly stale: ListChangesStale | null;
}

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

	/**
	 * 当前 change 的第一父 commit id，供 quickDiffProvider 构造 `jjvs://` URI
	 * 使用。首次 `doRefresh` 成功前为 undefined，此时 quickDiff 回退为「无原始
	 * 资源」，VSCode 不绘 gutter。
	 */
	private parentCommitId: string | undefined;

	/**
	 * 仓库是否与 Git colocated。构造时通过 native 判定一次，仓库生命周期内不
	 * 重查——用户极端操作（手动 `rm -rf .git` / `git init`）后需要重启窗口或
	 * 重新打开 workspace folder 才能感知。
	 */
	private readonly isColocated: boolean;

	private readonly decorationEmitter =
		new vscode.EventEmitter<DecorationChange>();
	/** FileDecorationProvider 订阅此事件；undefined 表示全量刷新。 */
	readonly onDidChangeDecorations = this.decorationEmitter.event;

	private readonly summaryEmitter = new vscode.EventEmitter<JjRepoSummary>();
	/** 每次成功刷新后广播最新的仓库摘要；`JjStatusBar` 订阅此事件。 */
	readonly onDidChangeSummary = this.summaryEmitter.event;
	private lastSummary: JjRepoSummary | undefined;
	/** 最近一次成功刷新得到的仓库摘要。新 subscriber 挂载时可用于首帧渲染。 */
	get summary(): JjRepoSummary | undefined {
		return this.lastSummary;
	}

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

		this.isColocated = loadNativeBinding().isColocatedWorkspace(
			folder.uri.fsPath,
		);
		this.updateQuickDiffProvider();

		this.disposables.push(
			this.changesGroup,
			this.sourceControl,
			this.decorationEmitter,
			this.summaryEmitter,
		);

		const watcher = vscode.workspace.createFileSystemWatcher(
			new vscode.RelativePattern(folder, "**"),
		);
		// 额外盯一个 `.jj/**` watcher：VSCode 在某些场景下对 dot-prefixed 子目录
		// 的 recursive watch 行为不稳（由 files.watcherExclude / parcel watcher
		// 内部策略决定），仅靠上面那个 `**` watcher 曾经出现过 `.jj/repo/op_heads/`
		// 下的 op 移动事件漏报的情况——表现为用户执行 `jj bookmark create` 等
		// 不触碰 working-copy 文件的命令后 SCM 面板 / 状态栏不刷新。显式再挂一
		// 个 `.jj/**` 的 watcher 兜底；重复触发由 scheduleRefresh 的 300ms 防抖
		// 合并成单次 listChanges，不会放大开销。
		const jjWatcher = vscode.workspace.createFileSystemWatcher(
			new vscode.RelativePattern(folder, ".jj/**"),
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
				logger.debug("scm", "gitignore 变更，失效 ignore 缓存", {
					path: uri.fsPath,
				});
			} else if (uri.fsPath.includes(`${path.sep}op_heads${path.sep}`)) {
				// shouldReactToChange 已确保只放行 op_heads 事件进入 .jj/ 分支。
				logger.trace("scm", "op_heads 事件", { path: uri.fsPath });
			}
			this.scheduleRefresh();
		};
		this.disposables.push(
			watcher,
			watcher.onDidChange(onEvent),
			watcher.onDidCreate(onEvent),
			watcher.onDidDelete(onEvent),
			jjWatcher,
			jjWatcher.onDidChange(onEvent),
			jjWatcher.onDidCreate(onEvent),
			jjWatcher.onDidDelete(onEvent),
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
		const refreshStart = Date.now();
		logger.debug("scm", "refresh 开始", { folder: this.folder.uri.fsPath });
		let outcome: ListChangesOutcome;
		try {
			outcome = await loadNativeBinding().listChanges(this.folder.uri.fsPath);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			// 刷新失败在 VSCode 里没有天然的展示位（SCM 面板本身没有错误状态），
			// 弹窗不合适；记录到 logger 后保持现有 resourceStates 不动，让用户感
			// 知到 diff 没变但不会卡死面板。
			logger.error("scm", "刷新失败", {
				folder: this.folder.uri.fsPath,
				error: message,
			});
			return;
		}

		if (outcome.stale) {
			// workspace 落在 stale / sibling 状态时，native 端已经有意跳过 snapshot
			// 与 finish——磁盘零写入。TS 侧此刻的正确选择是保留上一帧 SCM 面板、
			// changeIndex、装饰、quickDiff 原始资源 URI 都不动，仅通过状态栏把
			// stale 标记广播出去，引导用户去 CLI 处理。lastSummary 若已存在则就
			// 地 clone 出新引用挂上 stale；尚未首帧成功时 lastSummary 为空，构造
			// 一条"骨架" summary 让状态栏能立即显示提示。
			const stale = outcome.stale;
			const previous = this.lastSummary;
			const summary: JjRepoSummary = previous
				? { ...previous, stale }
				: {
						folder: this.folder,
						changeId: "",
						changeIdPrefix: "",
						commitId: "",
						description: "",
						bookmarks: [],
						stale,
					};
			this.lastSummary = summary;
			this.summaryEmitter.fire(summary);
			logger.info("scm", "refresh stale", {
				folder: this.folder.uri.fsPath,
				kind: stale.kind,
				message: stale.message,
			});
			return;
		}

		if (!outcome.data) {
			// Rust 侧约定 stale 与 data 互斥、且至少一侧非空；真到这里说明 ABI 错
			// 配。对齐 native loader 的 fail-fast 方针（见 CLAUDE.md 与 src/native.ts
			// 导出存在性检查），直接抛错让 VSCode 把问题显式暴露出来——静默吞掉会
			// 掩盖 Rust/TS 接口漂移。
			logger.error("scm", "listChanges 返回 stale 与 data 均为空，ABI 错配");
			throw new Error(
				"jjvs: listChanges 返回 stale 与 data 均为空，native 绑定与 TS 接口错配",
			);
		}
		const result = outcome.data;

		this.parentCommitId = result.parentCommitId;

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

		// 状态栏摘要：用不可变快照广播给订阅者，避免下游持有 bookmarks 引用后
		// 被下一次刷新就地改写。正常刷新成功 → stale 清零。
		const summary: JjRepoSummary = {
			folder: this.folder,
			stale: null,
			changeId: result.currentChangeId,
			changeIdPrefix: result.currentChangeIdPrefix,
			commitId: result.currentCommitId,
			description: result.currentDescription,
			bookmarks: [...result.currentBookmarks],
		};
		this.lastSummary = summary;
		this.summaryEmitter.fire(summary);
		logger.debug("scm", "refresh 成功", {
			folder: this.folder.uri.fsPath,
			changes: states.length,
			commitId: result.currentCommitId,
			elapsedMs: Date.now() - refreshStart,
		});
	}

	/**
	 * 根据 `jjvs.quickDiff.mode` 配置与 colocation 状态决定是否挂
	 * quickDiffProvider。构造时调用一次、`jjvs.quickDiff.mode` 变更时由
	 * `JjRepositoryManager` 再次调用。
	 */
	updateQuickDiffProvider(): void {
		// 默认值由 package.json 的 contributes.configuration 提供，这里不再重复
		// 写 fallback，避免"默认值多处定义"。配置被手改成非 enum 值时 VSCode 会
		// 让 `.get` 返回 undefined，本方法按"不挂" 处理——严格模式下不挂比挂错
		// 方向好。
		const mode = vscode.workspace
			.getConfiguration("jjvs", this.folder.uri)
			.get<QuickDiffMode>("quickDiff.mode");

		const shouldAttach =
			mode === "enabled" || (mode === "auto" && !this.isColocated);

		this.sourceControl.quickDiffProvider = shouldAttach
			? {
					provideOriginalResource: (uri) => this.provideOriginalResource(uri),
				}
			: undefined;
	}

	/**
	 * quickDiffProvider 回调：只有状态为 `modified` 的工作副本文件需要返回父
	 * change 下的原始内容，其它（未改 / added / removed / 非本仓库）返回
	 * undefined，让 VSCode 回退为「无 gutter 标记」。
	 */
	private provideOriginalResource(uri: vscode.Uri): vscode.Uri | undefined {
		if (uri.scheme !== "file") {
			return undefined;
		}
		if (!this.containsUri(uri)) {
			return undefined;
		}
		if (this.changeIndex.get(uri.fsPath) !== "modified") {
			return undefined;
		}
		if (this.parentCommitId === undefined) {
			return undefined;
		}
		const rel = path.relative(this.folder.uri.fsPath, uri.fsPath);
		const repoPath = rel.split(path.sep).join("/");
		return buildDiffUri(uri.fsPath, {
			workspace: this.folder.uri.fsPath,
			commit: this.parentCommitId,
			repoPath,
		});
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
	// 仓库级事件的订阅 disposable：每个 JjSourceControl 进入 manager 时集中
	// 订阅其所有对外事件，仓库从 workspace 移除时按 key 一次性 dispose；不
	// 依赖 repo.dispose 级联，因为订阅的接收方是 manager 自身的 emitter。
	// 用单个 Map<string, Disposable[]> 容纳所有订阅，未来新增事件种类只需
	// 改一处。
	private readonly repoSubs = new Map<string, vscode.Disposable[]>();

	private readonly decorationEmitter =
		new vscode.EventEmitter<DecorationChange>();
	/** 聚合所有仓库的装饰事件；FileDecorationProvider 订阅此事件。 */
	readonly onDidChangeDecorations = this.decorationEmitter.event;

	private readonly summaryEmitter = new vscode.EventEmitter<JjRepoSummary>();
	/** 聚合所有仓库的摘要事件；`JjStatusBar` 订阅此事件。 */
	readonly onDidChangeSummary = this.summaryEmitter.event;

	private readonly removeRepoEmitter =
		new vscode.EventEmitter<vscode.WorkspaceFolder>();
	/**
	 * 仓库从 workspace 移除（folder 被删除或 `.jj` 消失时 syncAll 检出）时广播
	 * 对应 folder。订阅者据此清理按 folder 键的缓存（如状态栏 summary 快照）。
	 */
	readonly onDidRemoveRepo = this.removeRepoEmitter.event;

	/** 当前被 manager 管理的所有仓库 folder 列表，顺序为最初识别顺序。 */
	get folders(): readonly vscode.WorkspaceFolder[] {
		return Array.from(this.repositories.values(), (repo) => repo.folder);
	}

	/**
	 * 查询指定 folder 对应仓库的最近一次 summary。`copyDiagnostics` 使用；
	 * 未识别的 folder 或尚未完成首帧刷新时返回 undefined。
	 */
	getSummary(folder: vscode.WorkspaceFolder): JjRepoSummary | undefined {
		return this.repositories.get(folder.uri.toString())?.summary;
	}

	start(): void {
		this.syncAll();
		this.disposables.push(
			this.decorationEmitter,
			this.summaryEmitter,
			this.removeRepoEmitter,
			vscode.workspace.onDidChangeWorkspaceFolders(() => this.syncAll()),
			vscode.workspace.onDidChangeConfiguration((event) => {
				for (const repo of this.repositories.values()) {
					if (
						event.affectsConfiguration(QUICK_DIFF_CONFIG_KEY, repo.folder.uri)
					) {
						repo.updateQuickDiffProvider();
					}
				}
			}),
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
				this.repoSubs.set(key, [
					repo.onDidChangeDecorations((change) =>
						this.decorationEmitter.fire(change),
					),
					repo.onDidChangeSummary((summary) =>
						this.summaryEmitter.fire(summary),
					),
				]);
				logger.info("scm", "发现 jj 仓库", { folder: folder.uri.fsPath });
			}
		}

		for (const key of Array.from(this.repositories.keys())) {
			if (!desired.has(key)) {
				const subs = this.repoSubs.get(key);
				if (!subs) {
					throw new Error(
						`repoSubs 与 repositories 不一致：缺少 ${key} 的订阅记录`,
					);
				}
				for (const sub of subs) {
					sub.dispose();
				}
				this.repoSubs.delete(key);
				const repo = this.repositories.get(key);
				this.repositories.delete(key);
				if (repo) {
					// 先通知订阅者（状态栏）清缓存，再 dispose 仓库自身——反过来会让
					// 订阅者拿不到 folder 信息去定位缓存。
					this.removeRepoEmitter.fire(repo.folder);
					repo.dispose();
					logger.info("scm", "移除仓库", { folder: repo.folder.uri.fsPath });
				}
			}
		}
	}

	dispose(): void {
		for (const d of this.disposables) {
			d.dispose();
		}
		this.disposables.length = 0;
		for (const subs of this.repoSubs.values()) {
			for (const sub of subs) {
				sub.dispose();
			}
		}
		this.repoSubs.clear();
		for (const repo of this.repositories.values()) {
			repo.dispose();
		}
		this.repositories.clear();
	}
}
