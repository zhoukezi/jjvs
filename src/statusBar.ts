import * as vscode from "vscode";

import type { ListChangesStaleKind } from "./native";
import type { JjRepoSummary, JjRepositoryManager } from "./scm";

/**
 * stale 态下状态栏主体的短标签。以 `Record<ListChangesStaleKind, string>` 强
 * 制穷尽——新增一种 kind 时 TS 类型系统会要求在这里补上对应文案，避免走到
 * 静默默认分支。与 `src/native.ts` 里 `ListChangesStaleKind` 联动演进。
 */
const STALE_KIND_LABEL: Record<ListChangesStaleKind, string> = {
	wc_stale: "wc stale",
	sibling: "sibling ops",
};

// 状态栏在 Left 侧，priority 90：VSCode 内置 Git 约 100，数值小者靠右，因此
// jjvs 紧邻 Git 右侧出现。colocated 工作区下与 Git 状态栏并列、且 Git 先被
// 看见，tooltip 单独区分身份。纯观察者语义——构造后不设置 `command` 字段。
const STATUS_BAR_PRIORITY = 90;

const CONFIG_SECTION = "jjvs.statusBar";
const CONFIG_PINNED_BOOKMARKS = "pinnedBookmarks";
const CONFIG_MAX_BOOKMARKS = "maxBookmarks";

/**
 * 纯观察者形态的状态栏项，展示"当前 jj 仓库 → 挑选出的 bookmarks + change_id
 * 前缀"，tooltip 展示完整 change_id / commit_id / description / bookmarks /
 * 仓库根路径。不贡献任何命令：`listChanges` 失败时保留上一帧快照（与 SCM
 * 面板一致）。
 *
 * 仓库选择策略：
 *   1. 若 active editor 归属某个 jj 仓库，展示该仓库。
 *   2. 否则回退到"最近展示过"的仓库快照（首帧 fallback 目标为 manager.folders
 *      中第一个被识别到的仓库）。
 *   3. 所有仓库都没有 summary 时隐藏状态栏项。
 */
export class JjStatusBar implements vscode.Disposable {
	private readonly item: vscode.StatusBarItem;
	private readonly disposables: vscode.Disposable[] = [];
	/** 每个仓库 folder 的最近一次 summary，按 folder.uri.toString() 键。 */
	private readonly summaries = new Map<string, JjRepoSummary>();
	/** folder 进入"最近展示过"顺序的计数器；值越大代表越新近。 */
	private readonly displayOrder = new Map<string, number>();
	private displayTick = 0;

	constructor(private readonly manager: JjRepositoryManager) {
		this.item = vscode.window.createStatusBarItem(
			vscode.StatusBarAlignment.Left,
			STATUS_BAR_PRIORITY,
		);
		// 不设置 `this.item.command` —— M2.2 明确纯观察者语义，点击不触发命令。

		this.disposables.push(
			this.item,
			manager.onDidChangeSummary((summary) => this.onSummary(summary)),
			manager.onDidRemoveRepo((folder) => this.onRepoRemoved(folder)),
			vscode.window.onDidChangeActiveTextEditor(() => this.render()),
			vscode.workspace.onDidChangeConfiguration((event) => {
				if (event.affectsConfiguration(CONFIG_SECTION)) {
					this.render();
				}
			}),
		);

		// 首次渲染：此时尚无 summary，状态栏项保持隐藏；首次成功刷新到来时会
		// 通过 onDidChangeSummary → render 自动显现。
		this.render();
	}

	private onSummary(summary: JjRepoSummary): void {
		const key = summary.folder.uri.toString();
		this.summaries.set(key, summary);
		this.render();
	}

	private onRepoRemoved(folder: vscode.WorkspaceFolder): void {
		const key = folder.uri.toString();
		this.summaries.delete(key);
		this.displayOrder.delete(key);
		this.render();
	}

	/** 按当前选择策略挑一个要展示的 summary；没有则返回 undefined。 */
	private pickSummary(): JjRepoSummary | undefined {
		const active = vscode.window.activeTextEditor;
		if (active) {
			const repo = this.manager.findRepoFor(active.document.uri);
			if (repo) {
				const summary = this.summaries.get(repo.folder.uri.toString());
				if (summary) {
					return summary;
				}
			}
		}

		// fallback：优先取"最近展示过"的仓库快照，它也能保障 active editor 切到
		// 非 jj folder 时状态栏继续显示上次展示的仓库而非闪烁消失。
		let best: JjRepoSummary | undefined;
		let bestTick = -1;
		for (const [key, tick] of this.displayOrder) {
			if (tick <= bestTick) {
				continue;
			}
			const summary = this.summaries.get(key);
			if (summary) {
				best = summary;
				bestTick = tick;
			}
		}
		if (best) {
			return best;
		}

		// 首帧尚未有任何显示记录：回退到 manager 中第一个有 summary 的仓库。
		for (const folder of this.manager.folders) {
			const summary = this.summaries.get(folder.uri.toString());
			if (summary) {
				return summary;
			}
		}
		return undefined;
	}

	private render(): void {
		const summary = this.pickSummary();
		if (!summary) {
			this.item.hide();
			return;
		}

		const key = summary.folder.uri.toString();
		this.displayTick += 1;
		this.displayOrder.set(key, this.displayTick);

		const config = vscode.workspace.getConfiguration(
			CONFIG_SECTION,
			summary.folder.uri,
		);
		// 默认值由 package.json 的 contributes.configuration 提供，这里不再
		// 重复写 fallback，避免"默认值多处定义"——与 scm.ts 对 quickDiff.mode
		// 的处理保持一致。配置被手改成非法类型时 VSCode 返回 undefined，此时
		// 用 non-null 断言让渲染按默认行为继续，比埋一层与 package.json 可能
		// 漂移的兜底值更稳。
		const pinned = config.get<string[]>(CONFIG_PINNED_BOOKMARKS)!;
		const maxBookmarks = config.get<number>(CONFIG_MAX_BOOKMARKS)!;

		const body = formatStatusBarText(summary, pinned, maxBookmarks);
		if (summary.stale) {
			// stale 态：主体加醒目警告图标 + 背景色，body 保留上一帧已展示过的
			// bookmarks / change id 前缀以便用户对照；首帧即 stale 时 body 会是空
			// 的 change id 前缀（scm.ts 构造的骨架 summary），此时只剩警告图标与
			// 文案，同样够表达"仓库出事了"。tooltip 用专门的 stale 版本替换。
			this.item.text =
				`$(warning) jj ${STALE_KIND_LABEL[summary.stale.kind]} ${body}`.trimEnd();
			this.item.tooltip = buildStaleTooltip(summary);
			this.item.backgroundColor = new vscode.ThemeColor(
				"statusBarItem.warningBackground",
			);
		} else {
			this.item.text = `$(source-control) ${body}`;
			this.item.tooltip = buildTooltip(summary);
			// 清零 backgroundColor，否则从 stale 恢复到 Fresh 后状态栏会留着橙底。
			this.item.backgroundColor = undefined;
		}
		this.item.show();
	}

	dispose(): void {
		for (const d of this.disposables) {
			d.dispose();
		}
		this.disposables.length = 0;
	}
}

/**
 * 状态栏主体文本格式：`<pinned & extra bookmarks...> [+K] <change_id_prefix>`
 * 规则（对齐 ROADMAP M2.2）：
 *   - pin 列表里在本 change 上实际出现的名字按 pin 列表自身顺序优先占位；
 *   - 剩余空位按 jj-lib 返回顺序补入其他 bookmark，直到达到 maxBookmarks；
 *   - 仍有剩余未展示的 bookmark 时折叠为 `+K` 附在最后一个 bookmark 后；
 *   - 无 bookmark 时 bookmark 段整体省略，只展示 change_id 前缀；
 *   - maxBookmarks == 0 时不展示任何 bookmark 名字，若有 bookmark 则以
 *     `+K` 形式展示数量（K 为 bookmark 总数），与 package.json 对该配置
 *     的说明一致。
 *
 * 导出以便后续单元测试；目前仓库无测试框架，先保留可测形态。
 */
export function formatStatusBarText(
	summary: JjRepoSummary,
	pinned: readonly string[],
	maxBookmarks: number,
): string {
	const cap = Math.max(0, Math.floor(maxBookmarks));
	const all = summary.bookmarks;
	const allSet = new Set(all);
	const picked: string[] = [];
	const seen = new Set<string>();

	if (cap > 0) {
		// 1) pin 列表按 pin 顺序筛出"本 change 上实际出现的"bookmark。
		for (const name of pinned) {
			if (picked.length >= cap) {
				break;
			}
			if (!seen.has(name) && allSet.has(name)) {
				picked.push(name);
				seen.add(name);
			}
		}
		// 2) 剩余空位按 jj-lib 返回顺序补入其余 bookmark。
		for (const name of all) {
			if (picked.length >= cap) {
				break;
			}
			if (!seen.has(name)) {
				picked.push(name);
				seen.add(name);
			}
		}
	}

	const remaining = all.length - picked.length;
	if (remaining > 0) {
		picked.push(`+${remaining}`);
	}
	picked.push(summary.changeIdPrefix);
	return picked.join(" ");
}

/**
 * stale 态专用 tooltip：顶部警告块说明原因与用户应跑的 CLI 命令；再附上一
 * 帧已知的仓库摘要（如果有）。骨架 summary（首帧即 stale）下只展示仓库根路径
 * 与警告信息，不把空字段渲染成虚假的 `Change：` 行。
 */
function buildStaleTooltip(summary: JjRepoSummary): vscode.MarkdownString {
	const stale = summary.stale!;
	const md = new vscode.MarkdownString();
	md.supportThemeIcons = true;
	md.appendMarkdown(
		`**Jujutsu** — ${inlineCode(summary.folder.uri.fsPath)}\n\n`,
	);
	md.appendMarkdown(`$(warning) **workspace ${stale.kind}**\n\n`);
	md.appendMarkdown(`${stale.message}\n\n`);
	// 若有上一帧数据（非骨架 summary），附展示一下便于用户判断这是哪个 change。
	if (summary.changeId.length > 0) {
		md.appendMarkdown(`上次刷新：\n\n`);
		md.appendMarkdown(`- Change：${inlineCode(summary.changeId)}\n`);
		md.appendMarkdown(`- Commit：${inlineCode(summary.commitId)}\n`);
		if (summary.bookmarks.length > 0) {
			const tagged = summary.bookmarks.map(inlineCode).join("、");
			md.appendMarkdown(`- Bookmark：${tagged}\n`);
		}
	}
	return md;
}

function buildTooltip(summary: JjRepoSummary): vscode.MarkdownString {
	const md = new vscode.MarkdownString();
	md.supportThemeIcons = true;
	// 身份标题：与内置 Git 状态栏并列时靠这一行区分"这是 jj 的而非 git 的"。
	// "Jujutsu" 作为技术术语 / 项目名保留英文。
	md.appendMarkdown(
		`**Jujutsu** — ${inlineCode(summary.folder.uri.fsPath)}\n\n`,
	);
	md.appendMarkdown(`Change：${inlineCode(summary.changeId)}\n\n`);
	md.appendMarkdown(`Commit：${inlineCode(summary.commitId)}\n\n`);
	const description = summary.description.trim();
	if (description.length > 0) {
		// description 可能含换行与用户输入字符；按 code block 渲染既避开 Markdown
		// 语法意外触发，又保留原始排版。用户若在 description 里写了三反引号，
		// 默认 ``` fence 会被提前闭合导致渲染错乱——按内部最长连续反引号串 + 1
		// 计算动态 fence 宽度规避。
		const fence = "`".repeat(Math.max(3, maxBacktickRun(description) + 1));
		md.appendMarkdown(`描述：\n\n${fence}\n${description}\n${fence}\n\n`);
	}
	if (summary.bookmarks.length > 0) {
		const tagged = summary.bookmarks.map(inlineCode).join("、");
		md.appendMarkdown(`Bookmark：${tagged}`);
	} else {
		md.appendMarkdown(`Bookmark：_无_`);
	}
	return md;
}

/**
 * 包裹为 CommonMark inline code span，按内容中最长反引号串动态选择分隔符
 * 长度，避免 fsPath / bookmark 名 / change id 等字段含反引号时 code span
 * 被提前闭合。内容以反引号开头或结尾时按规范在内外各补一个空格。
 */
function inlineCode(text: string): string {
	const tick = "`".repeat(maxBacktickRun(text) + 1);
	const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
	return `${tick}${pad}${text}${pad}${tick}`;
}

function maxBacktickRun(text: string): number {
	return (
		text.match(/`+/g)?.reduce((max, run) => Math.max(max, run.length), 0) ?? 0
	);
}
