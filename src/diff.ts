import * as path from "node:path";

import * as vscode from "vscode";

import * as logger from "./logger";
import { type FileChangeKind, loadNativeBinding } from "./native";

// 自定义 URI scheme，用于把 "某 commit 里的某文件内容" 暴露给 VSCode diff
// 编辑器。scheme 选 `jjvs` 而非 `jj`，避免与其他可能的 jj 生态工具冲突。
// 参数以 JSON 串写在 query 上：{ workspace, commit, repoPath }。
//   - commit === "" 表示空内容（用于 added / deleted diff 的另一侧占位）；
//   - repoPath 是 jj 内部格式的仓库内路径（正斜杠分隔）。
// 保留 uri.path 为文件原路径，便于 VSCode 根据扩展名启用语法高亮。

export const JJVS_DIFF_SCHEME = "jjvs";

export interface JjvsUriParams {
	workspace: string;
	commit: string;
	repoPath: string;
}

export function buildDiffUri(
	fileUriPath: string,
	params: JjvsUriParams,
): vscode.Uri {
	return vscode.Uri.from({
		scheme: JJVS_DIFF_SCHEME,
		path: fileUriPath,
		query: JSON.stringify(params),
	});
}

function parseDiffUri(uri: vscode.Uri): JjvsUriParams {
	const params = JSON.parse(uri.query) as Partial<JjvsUriParams>;
	if (
		typeof params.workspace !== "string" ||
		typeof params.commit !== "string" ||
		typeof params.repoPath !== "string"
	) {
		throw new Error(`无效的 jjvs diff URI：${uri.toString()}`);
	}
	return params as JjvsUriParams;
}

// 默认与 package.json 的 "jjvs.diff.maxFileSize" default 字段对齐（50 MiB）。
// 这里的常量仅作为 getConfiguration 读不到值时的兜底，正常路径由配置驱动。
const DEFAULT_MAX_FILE_SIZE = 52_428_800;

function readMaxFileSize(): number {
	const raw = vscode.workspace
		.getConfiguration("jjvs.diff")
		.get<number>("maxFileSize", DEFAULT_MAX_FILE_SIZE);
	// 用户手工编辑 settings.json 可能写入 NaN / 负值；package.json 的 minimum
	// 只拦 UI 输入，这里再做一次防呆：非有限或小于 0 时回落到默认。
	if (!Number.isFinite(raw) || raw < 0) {
		return DEFAULT_MAX_FILE_SIZE;
	}
	return raw;
}

// 选 FileSystemProvider 而非 TextDocumentContentProvider：后者只能返回 string，
// 被迫把字节解成 UTF-8，二进制文件会被替换字符污染；前者吐 Uint8Array，
// VSCode 内置 diff editor 自行判定二进制并渲染占位视图。对齐 VSCode 内置 Git
// 扩展的 extensions/git/src/fileSystemProvider.ts。
class JjvsFileSystemProvider implements vscode.FileSystemProvider {
	private readonly _onDidChangeFile = new vscode.EventEmitter<
		vscode.FileChangeEvent[]
	>();
	readonly onDidChangeFile = this._onDidChangeFile.event;

	watch(): vscode.Disposable {
		return new vscode.Disposable(() => {});
	}

	async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
		const { workspace, commit, repoPath } = parseDiffUri(uri);
		if (commit === "") {
			return { type: vscode.FileType.File, ctime: 0, mtime: 0, size: 0 };
		}
		// stat 只要精确 size：传 maxFileSize=0 让 native 对任何非空文件都短路，
		// 不把字节投进 NAPI Buffer。jj-lib 没有独立的 size API，Rust 侧仍需扫完
		// 整个 blob，但 JS heap 不会因此分配——这是对 VSCode 频繁 stat 的省内存
		// 路径，不与 readFile 竞争缓存语义。
		const { size } = await loadNativeBinding().readFileAtCommit(
			workspace,
			commit,
			repoPath,
			0,
		);
		return { type: vscode.FileType.File, ctime: 0, mtime: 0, size };
	}

	async readFile(uri: vscode.Uri): Promise<Uint8Array> {
		const { workspace, commit, repoPath } = parseDiffUri(uri);
		if (commit === "") {
			return new Uint8Array(0);
		}
		const maxFileSize = readMaxFileSize();
		const { bytes, size } = await loadNativeBinding().readFileAtCommit(
			workspace,
			commit,
			repoPath,
			maxFileSize,
		);
		if (bytes === null) {
			// 超限：native 未把字节 load 进 NAPI Buffer，这里构造占位文本让 VSCode
			// diff editor 以文本形式呈现"为何没加载"——文案面向用户，不是二进制
			// 占位（VSCode 针对 FileSystemProvider 的二进制占位层只在检测到 NUL /
			// 非法 UTF-8 时触发，而这里我们主动短路，走不了那条检测路径）。
			logger.debug("fsprovider", "readFile 超过 maxFileSize 阈值", {
				repoPath,
				size,
				maxFileSize,
			});
			return new TextEncoder().encode(
				`(文件超过 jjvs.diff.maxFileSize 阈值，未加载；${size} 字节)`,
			);
		}
		return bytes;
	}

	readDirectory(): never {
		throw vscode.FileSystemError.FileNotFound();
	}
	createDirectory(): never {
		throw vscode.FileSystemError.NoPermissions();
	}
	writeFile(): never {
		throw vscode.FileSystemError.NoPermissions();
	}
	delete(): never {
		throw vscode.FileSystemError.NoPermissions();
	}
	rename(): never {
		throw vscode.FileSystemError.NoPermissions();
	}
}

export interface FileChangeForDiff {
	kind: FileChangeKind;
	workspaceRoot: string;
	parentCommitId: string;
	/** 目标文件的绝对路径。 */
	fsPath: string;
	/** 目标文件相对仓库根、正斜杠分隔。 */
	repoPath: string;
}

async function openDiff(change: FileChangeForDiff): Promise<void> {
	const { workspaceRoot, parentCommitId, kind, fsPath, repoPath } = change;
	const basename = path.basename(fsPath);
	logger.debug("fsprovider", "openDiff", { kind, repoPath });

	let leftUri: vscode.Uri;
	let rightUri: vscode.Uri;
	let title: string;

	switch (kind) {
		case "added": {
			leftUri = buildDiffUri(fsPath, {
				workspace: workspaceRoot,
				commit: "",
				repoPath,
			});
			rightUri = vscode.Uri.file(fsPath);
			title = `${basename} (新增)`;
			break;
		}
		case "modified": {
			leftUri = buildDiffUri(fsPath, {
				workspace: workspaceRoot,
				commit: parentCommitId,
				repoPath,
			});
			rightUri = vscode.Uri.file(fsPath);
			title = `${basename} (修改)`;
			break;
		}
		case "removed": {
			leftUri = buildDiffUri(fsPath, {
				workspace: workspaceRoot,
				commit: parentCommitId,
				repoPath,
			});
			rightUri = buildDiffUri(fsPath, {
				workspace: workspaceRoot,
				commit: "",
				repoPath,
			});
			title = `${basename} (删除)`;
			break;
		}
	}

	await vscode.commands.executeCommand(
		"vscode.diff",
		leftUri,
		rightUri,
		title,
		{
			preview: true,
		} satisfies vscode.TextDocumentShowOptions,
	);
}

/**
 * `jjvs.openFile` 的命令入口。接受两类调用：
 *   - SCM inline 按钮：VSCode 传入 `SourceControlResourceState`，直接取 `resourceUri`；
 *   - Diff editor title 按钮：VSCode 传入当前 editor 的 `Uri`，若是 `jjvs://`
 *     则把它视作"父 change 下的原始路径"，转换成 `file://` 打开 working copy。
 * 文件真实不存在（如 removed diff 的两侧）时交给 `vscode.open` 自然失败的
 * 内置提示，不自行再加一层。
 */
async function openFile(
	arg: vscode.Uri | vscode.SourceControlResourceState | undefined,
): Promise<void> {
	let uri: vscode.Uri | undefined;
	let fromScmResource = false;
	if (arg instanceof vscode.Uri) {
		uri = arg;
	} else if (arg && typeof arg === "object" && "resourceUri" in arg) {
		uri = arg.resourceUri;
		fromScmResource = true;
	} else {
		const active = vscode.window.activeTextEditor;
		uri = active?.document.uri;
	}
	if (!uri) {
		return;
	}
	if (uri.scheme === JJVS_DIFF_SCHEME) {
		uri = vscode.Uri.file(uri.path);
	}
	// 必须显式传 options：不传时 vscode.open 走 openerService → EditorOpener，
	// 以 getFocusedCodeEditor() 去重，焦点在 diff modified 侧时与目标 URI 匹配
	// 会 no-op（按钮"点了没反应"）。传 options 则改走 editorService。
	await vscode.commands.executeCommand("vscode.open", uri, {
		preserveFocus: fromScmResource,
		preview: false,
		viewColumn: vscode.ViewColumn.Active,
	} satisfies vscode.TextDocumentShowOptions);
}

/**
 * 维护自定义 context key `jjvs.diffEditorActive`：仅当当前 active tab 是
 * 一个 diff editor 且任一侧 URI scheme 为 `jjvs` 时为 true。用于 package.json
 * 里 `editor/title` 菜单的 when 条件，精确限定"打开文件"按钮只在 jjvs 打开的
 * diff 视图出现，避免误挂到内置 Git 或其他扩展的 diff 上。
 */
const DIFF_ACTIVE_CONTEXT = "jjvs.diffEditorActive";

function registerDiffEditorActiveTracker(): vscode.Disposable {
	let lastValue: boolean | undefined;
	const update = () => {
		const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
		const input = tab?.input;
		const isJjvsDiff =
			input instanceof vscode.TabInputTextDiff &&
			(input.original.scheme === JJVS_DIFF_SCHEME ||
				input.modified.scheme === JJVS_DIFF_SCHEME);
		if (lastValue === isJjvsDiff) {
			return;
		}
		lastValue = isJjvsDiff;
		logger.trace("fsprovider", "diff active 变化", { active: isJjvsDiff });
		void vscode.commands.executeCommand(
			"setContext",
			DIFF_ACTIVE_CONTEXT,
			isJjvsDiff,
		);
	};

	const subs: vscode.Disposable[] = [
		vscode.window.tabGroups.onDidChangeTabs(update),
		vscode.window.tabGroups.onDidChangeTabGroups(update),
	];
	update();

	return new vscode.Disposable(() => {
		for (const s of subs) {
			s.dispose();
		}
		// 扩展停用时把 context 归零，避免菜单残留假阳性状态。
		void vscode.commands.executeCommand(
			"setContext",
			DIFF_ACTIVE_CONTEXT,
			false,
		);
	});
}

export function registerDiffIntegration(
	context: vscode.ExtensionContext,
): void {
	context.subscriptions.push(
		vscode.workspace.registerFileSystemProvider(
			JJVS_DIFF_SCHEME,
			new JjvsFileSystemProvider(),
			{ isReadonly: true, isCaseSensitive: true },
		),
		vscode.commands.registerCommand(
			"jjvs.openDiff",
			(change: FileChangeForDiff) => openDiff(change),
		),
		vscode.commands.registerCommand("jjvs.openFile", openFile),
		registerDiffEditorActiveTracker(),
	);
}
