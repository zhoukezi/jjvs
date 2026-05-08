import * as vscode from "vscode";

import type { FileChangeKind } from "./native";
import type { JjRepositoryManager, JjSourceControl } from "./scm";

// Explorer / 打开的编辑器 tab 上的文件装饰。两类来源：
//   - M2.1 工作副本改动（A / M / D 字母 + 对应色）：来自 M2 的 listChanges
//     结果，在 JjSourceControl.changeIndex 里按绝对路径索引。
//   - M2.4 ignored 文件（暗化颜色）：调 native isPathIgnored 查 jj 的
//     gitignore 链。ignored 装饰不显示徽标，避免与 git 的 "I" 徽标撞车。
//
// 优先级：改动态优先于 ignored。理由：jj 会把 tracked 文件的改动记录下来，
// 即便同路径同时被 .gitignore 规则命中（比如先 track 再加 ignore 规则，jj
// 仍然保留追踪），此时状态应以改动为准。未被任何 kind 命中才查 ignored。

const CHANGE_DECORATIONS: Readonly<
	Record<FileChangeKind, vscode.FileDecoration>
> = {
	added: {
		badge: "A",
		color: new vscode.ThemeColor("gitDecoration.addedResourceForeground"),
		tooltip: "Jujutsu：新增",
		// propagate：让父目录继承颜色（不继承徽标，这是 VSCode 默认语义），与
		// 内置 Git 扩展对齐——让包含改动的目录在 Explorer 里一眼可见。
		propagate: true,
	},
	modified: {
		badge: "M",
		color: new vscode.ThemeColor("gitDecoration.modifiedResourceForeground"),
		tooltip: "Jujutsu：修改",
		propagate: true,
	},
	removed: {
		badge: "D",
		color: new vscode.ThemeColor("gitDecoration.deletedResourceForeground"),
		tooltip: "Jujutsu：删除",
		propagate: true,
	},
};

const IGNORED_DECORATION: vscode.FileDecoration = {
	color: new vscode.ThemeColor("gitDecoration.ignoredResourceForeground"),
	tooltip: "Jujutsu：已忽略",
	// ignored 不向上 propagate：一个 ignored 子节点不应让父目录被染成忽略色；
	// node_modules 目录本身若被 gitignore 直接命中会自己返回 ignored，不需要
	// 依赖 propagation。
};

export class JjFileDecorationProvider
	implements vscode.FileDecorationProvider, vscode.Disposable
{
	private readonly emitter = new vscode.EventEmitter<
		vscode.Uri | vscode.Uri[] | undefined
	>();
	readonly onDidChangeFileDecorations = this.emitter.event;

	private readonly disposables: vscode.Disposable[] = [];

	constructor(private readonly manager: JjRepositoryManager) {
		this.disposables.push(
			this.emitter,
			manager.onDidChangeDecorations((change) => {
				// change === undefined 直接透传（全量刷新），Uri[] 也直接透传。
				this.emitter.fire(change);
			}),
		);
	}

	async provideFileDecoration(
		uri: vscode.Uri,
	): Promise<vscode.FileDecoration | undefined> {
		// FileDecorationProvider 会对所有 scheme 的 URI（包括我们自己的 jjvs://、
		// git:// 等）发起查询。只处理磁盘文件，避免把 diff 视图左右两侧的虚拟
		// URI 也染色。
		if (uri.scheme !== "file") {
			return undefined;
		}

		const repo = this.manager.findRepoFor(uri);
		if (!repo) {
			return undefined;
		}

		const kind = repo.getChangeKind(uri);
		if (kind) {
			return CHANGE_DECORATIONS[kind];
		}

		if (await safeIsIgnored(repo, uri)) {
			return IGNORED_DECORATION;
		}
		return undefined;
	}

	dispose(): void {
		for (const d of this.disposables) {
			d.dispose();
		}
		this.disposables.length = 0;
	}
}

async function safeIsIgnored(
	repo: JjSourceControl,
	uri: vscode.Uri,
): Promise<boolean> {
	// isPathIgnored 失败（如 native 抛错）不应让 Explorer 的装饰查询整体挂掉；
	// 单个 URI 的查询失败回退为"未命中"，日志里保留上下文供排查。provider
	// 的调用节奏是按需、大批量的，连续弹窗或抛错会让 UI 噪声失控。
	try {
		return await repo.isPathIgnored(uri);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.error(`[jjvs] isPathIgnored 失败 ${uri.fsPath}: ${message}`);
		return false;
	}
}
