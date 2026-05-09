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

class JjvsContentProvider implements vscode.TextDocumentContentProvider {
	async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
		const { workspace, commit, repoPath } = parseDiffUri(uri);
		// 空 commit 约定为"空内容一侧"：added 文件的左侧、deleted 文件的右侧。
		// 不调用 native，避免为一个注定空的文档走 AsyncTask。
		if (commit === "") {
			return "";
		}
		const bytes = await loadNativeBinding().readFileAtCommit(
			workspace,
			commit,
			repoPath,
		);
		// 二进制文件被 VSCode 内置 diff 识别为 binary 的路径不在这里——
		// provideTextDocumentContent 只能返回 string。按 UTF-8 解码；对非 UTF-8
		// 的二进制内容会出现替换字符，后续里程碑可接入 FileDecorationProvider
		// 显式提示二进制。
		return bytes.toString("utf8");
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
		vscode.workspace.registerTextDocumentContentProvider(
			JJVS_DIFF_SCHEME,
			new JjvsContentProvider(),
		),
		vscode.commands.registerCommand(
			"jjvs.openDiff",
			(change: FileChangeForDiff) => openDiff(change),
		),
		vscode.commands.registerCommand("jjvs.openFile", openFile),
		registerDiffEditorActiveTracker(),
	);
}
