import * as vscode from "vscode";

import type { NativeBinding } from "./native";
import type { JjRepositoryManager } from "./scm";

// jjvs 的日志核心。单一 OutputChannel("jjvs") 承载所有来源（TS 业务打点、
// native 侧 log crate 回调、panic hook），对外暴露五个级别函数 +
// setLevel / attachNative / showLog / copyDiagnostics。
//
// 模块加载时即创建 OutputChannel——VSCode 扩展宿主在 require 时 vscode API
// 已可用，这是社区惯例。**模块顶层只做创建 channel** 这一件副作用，不读
// 配置、不挂 onDidChangeConfiguration，避免 import 顺序把副作用传染到测试
// 或加载失败路径。
//
// 级别过滤两端都做：TS 端在各导出函数入口按 `currentLevel` 短路；同时
// setLevel 把数值同步给 native（attachNative 之后），让 Rust 侧 log crate
// 也能在 trace 级别早期丢弃高频条目，避免每条都跨 ThreadsafeFunction。

const CHANNEL_NAME = "jjvs";
const channel = vscode.window.createOutputChannel(CHANNEL_NAME);

export type LogLevel = "error" | "warn" | "info" | "debug" | "trace";

const LEVEL_TO_NUMBER: Record<LogLevel, number> = {
	error: 0,
	warn: 1,
	info: 2,
	debug: 3,
	trace: 4,
};

const LEVEL_LABELS: readonly string[] = [
	"ERROR",
	"WARN ",
	"INFO ",
	"DEBUG",
	"TRACE",
];

interface LogEntry {
	/** epoch ms 统一由 TS 侧打时间戳，避免 Rust/TS 时钟差。 */
	time: number;
	level: number;
	tag: string;
	msg: string;
}

const RING_CAPACITY = 500;
const ring: (LogEntry | undefined)[] = new Array(RING_CAPACITY);
let ringHead = 0;
let ringSize = 0;

let currentLevel: number = LEVEL_TO_NUMBER.info;
/** 持有 native binding 引用，attachNative 之后才有值。setLevel 需要它。 */
let nativeBinding: Pick<NativeBinding, "setNativeLogLevel"> | undefined;

/** `formatEntry` 结果入 channel + ring。TS / Rust 源头共用一条路径。 */
function append(entry: LogEntry): void {
	// channel 已过滤；ring 也按当前级别存——copyDiagnostics 下用户切到 error
	// 级别后再导出，历史 debug/trace 会被折叠丢弃，换来诊断输出简短可读。
	// 若未来需要"无论当前级别总保留全量最近 N 条"，把级别判断移到 write channel
	// 一侧即可，ring 不做过滤。本轮按简洁路径实现。
	ring[ringHead] = entry;
	ringHead = (ringHead + 1) % RING_CAPACITY;
	if (ringSize < RING_CAPACITY) {
		ringSize += 1;
	}
	channel.appendLine(formatEntry(entry));
}

function formatEntry(entry: LogEntry): string {
	const iso = new Date(entry.time).toISOString();
	const label = LEVEL_LABELS[entry.level] ?? "?????";
	return `${iso} [${label}] [${entry.tag}] ${entry.msg}`;
}

function emit(level: number, tag: string, msg: string, extra: unknown): void {
	if (level > currentLevel) {
		return;
	}
	const suffix = extra === undefined ? "" : ` ${safeStringify(extra)}`;
	append({ time: Date.now(), level, tag, msg: `${msg}${suffix}` });
}

/**
 * 把任意值安全转成可读字符串。WeakSet 防循环；对 Error 特化为 name/message/
 * stack；bigint / function / symbol 退化为 String(...)；最后兜底一层
 * try-catch，拒绝让 logger 反噬调用方。
 */
function safeStringify(value: unknown): string {
	const seen = new WeakSet<object>();
	try {
		return (
			JSON.stringify(value, (_key, v) => {
				if (v instanceof Error) {
					return { name: v.name, message: v.message, stack: v.stack };
				}
				// 文件字节 / diff 内容不得进日志（见 CLAUDE.md 日志约定）。这里做深防御：
				// 任何 Buffer 作为 extra 传入时只留尺寸标记，绝不序列化成字节数组。
				// 正常路径上 `readFileAtCommit` 的 Buffer 也不经 logger，此守卫是兜底。
				if (Buffer.isBuffer(v)) {
					return `<Buffer ${v.length} bytes>`;
				}
				if (typeof v === "bigint") {
					return v.toString();
				}
				if (typeof v === "function" || typeof v === "symbol") {
					return String(v);
				}
				if (typeof v === "object" && v !== null) {
					if (seen.has(v)) {
						return "<cycle>";
					}
					seen.add(v);
				}
				return v;
			}) ?? "<unserializable>"
		);
	} catch {
		try {
			return String(value);
		} catch {
			return "<unserializable>";
		}
	}
}

export function error(tag: string, msg: string, extra?: unknown): void {
	emit(LEVEL_TO_NUMBER.error, tag, msg, extra);
}

export function warn(tag: string, msg: string, extra?: unknown): void {
	emit(LEVEL_TO_NUMBER.warn, tag, msg, extra);
}

export function info(tag: string, msg: string, extra?: unknown): void {
	emit(LEVEL_TO_NUMBER.info, tag, msg, extra);
}

export function debug(tag: string, msg: string, extra?: unknown): void {
	emit(LEVEL_TO_NUMBER.debug, tag, msg, extra);
}

export function trace(tag: string, msg: string, extra?: unknown): void {
	emit(LEVEL_TO_NUMBER.trace, tag, msg, extra);
}

/**
 * 设定级别。调用方负责保证传入的是受限联合 `LogLevel`——package.json
 * schema 已限死配置项枚举，越界只可能来自手动构造的字符串，属于编程错误，
 * 不在此处做兜底。同步把数值级别推给 native：attachNative 之前调用时 native
 * 尚未装，这里的下推跳过；attachNative 内部会把当前级别重推一次。
 */
export function setLevel(level: LogLevel): void {
	const numeric = LEVEL_TO_NUMBER[level];
	currentLevel = numeric;
	nativeBinding?.setNativeLogLevel(numeric);
}

/**
 * Rust 侧 ThreadsafeFunction 回调入口。native 的 `log::Record::target()` 直
 * 接作为 tag 透出（panic hook 用 "panic"）。时间戳在本函数里打，与 TS 侧
 * 其它源头统一。
 *
 * 此函数必须对任何异常免疫——`logger.nativeLog` 抛错会让 TSFN 投递链路出现
 * "异常回吐 Rust"的诡异路径。emit 内部已吞过格式化异常，这里再包一层 try/catch
 * 兜底防御。
 */
export function nativeLog(payload: {
	level: number;
	tag: string;
	msg: string;
}): void {
	try {
		if (payload.level > currentLevel) {
			return;
		}
		append({
			time: Date.now(),
			level: Math.max(0, Math.min(4, Math.floor(payload.level))),
			tag: payload.tag || "native",
			msg: payload.msg,
		});
	} catch {
		// 静默：native 日志回调不能把扩展搞崩。
	}
}

/**
 * 命令 `jjvs.showLog` 的实现：把 OutputChannel 面板展示出来并保留当前焦点
 * （preserveFocus=true），避免用户输入途中被抢焦。
 */
export function showLog(): void {
	channel.show(true);
}

/**
 * 把 OutputChannel 的生命周期挂到扩展 context 上，让 deactivate 时 VSCode
 * 能一并回收、避免 UI 里残留空通道。`extension.ts` 在 activate 头部调一次。
 */
export function register(context: vscode.ExtensionContext): void {
	context.subscriptions.push(channel);
}

/**
 * 装配 native binding。`extension.ts` 在 `loadNativeBinding()` 之后调一次：
 * 装 TSFN 回调 + 把当前 level 同步给 native。调用两次会被 Rust 侧
 * `OnceLock::set` 挡下并抛错（向上传播让激活失败显式暴露）。
 */
export function attachNative(
	binding: Pick<NativeBinding, "setNativeLogger" | "setNativeLogLevel">,
): void {
	binding.setNativeLogger(nativeLog);
	binding.setNativeLogLevel(currentLevel);
	nativeBinding = binding;
}

/**
 * 返回当前 ring buffer 的只读快照，按时间正序（oldest → newest）排列。
 * `copyDiagnostics` 使用；不对外暴露内部数组引用。
 */
function getRingSnapshot(): LogEntry[] {
	const result: LogEntry[] = [];
	if (ringSize === 0) {
		return result;
	}
	const start = (ringHead - ringSize + RING_CAPACITY) % RING_CAPACITY;
	for (let i = 0; i < ringSize; i += 1) {
		const entry = ring[(start + i) % RING_CAPACITY];
		if (entry) {
			result.push(entry);
		}
	}
	return result;
}

/**
 * 组装诊断文本并写入剪贴板，供用户贴 issue 用。包含：
 *   - 环境版本：扩展版本、native 版本、VSCode 版本、平台。
 *   - 配置：jjvs.* 已知项的当前值与默认值。
 *   - 仓库摘要：逐 folder 的 change id / bookmarks / stale 状态。
 *   - 最近日志：ring buffer 全量快照。
 *
 * 严格遵循 ROADMAP 的敏感信息边界：ring buffer 内容不含 diff 字节或文件内
 * 容（由 logger 所有调用点自行保证，见 CLAUDE.md 日志约定）；`readFileAtCommit`
 * 的返回 Buffer 在整个代码库中不经过 logger。
 */
export async function copyDiagnostics(
	context: vscode.ExtensionContext,
	manager: JjRepositoryManager | undefined,
	nativeVersion: string,
): Promise<void> {
	const lines: string[] = [];
	lines.push("== jjvs 诊断信息 ==");
	lines.push(`生成时间：${new Date().toISOString()}`);
	lines.push(
		`扩展版本：${String(context.extension.packageJSON.version ?? "<unknown>")}`,
	);
	lines.push(`原生绑定版本：${nativeVersion}`);
	lines.push(`VSCode：${vscode.version}`);
	lines.push(
		`平台：${process.platform}/${process.arch}，Node ${process.version}`,
	);
	lines.push("");

	lines.push("== 配置 ==");
	const cfg = vscode.workspace.getConfiguration("jjvs");
	const configKeys = [
		"log.level",
		"quickDiff.mode",
		"statusBar.pinnedBookmarks",
		"statusBar.maxBookmarks",
	];
	for (const key of configKeys) {
		const inspected = cfg.inspect<unknown>(key);
		const effective = cfg.get<unknown>(key);
		// inspect 可能为 undefined（配置 schema 未声明时）；此处 schema 固定，
		// 理论不会发生，但保留一条健壮分支以便未来新增 key 时的临时过渡期。
		if (!inspected) {
			lines.push(`jjvs.${key} = ${safeStringify(effective)}`);
			continue;
		}
		lines.push(
			`jjvs.${key} = ${safeStringify(effective)} (default ${safeStringify(
				inspected.defaultValue,
			)})`,
		);
	}
	lines.push("");

	lines.push("== 仓库摘要 ==");
	if (!manager || manager.folders.length === 0) {
		lines.push("(无 jj 仓库)");
	} else {
		for (const folder of manager.folders) {
			const summary = manager.getSummary(folder);
			if (!summary) {
				lines.push(`[${folder.name}] ${folder.uri.fsPath} (无摘要)`);
				continue;
			}
			const staleTag = summary.stale ? ` stale=${summary.stale.kind}` : "";
			const bookmarks = summary.bookmarks.length
				? summary.bookmarks.join(",")
				: "<none>";
			lines.push(
				`[${folder.name}] ${folder.uri.fsPath} change=${
					summary.changeIdPrefix || "<empty>"
				} commit=${summary.commitId || "<empty>"} bookmarks=[${bookmarks}]${staleTag}`,
			);
		}
	}
	lines.push("");

	const snapshot = getRingSnapshot();
	lines.push(`== 最近日志 (${snapshot.length}/${RING_CAPACITY} 条) ==`);
	for (const entry of snapshot) {
		lines.push(formatEntry(entry));
	}

	const text = lines.join("\n");
	try {
		await vscode.env.clipboard.writeText(text);
	} catch (err) {
		// 写剪贴板在无头环境 / 权限受限时可能失败；诊断命令的目的就是辅助排查
		// 问题，失败必须显式反馈而不是让 VSCode 弹一个没有上下文的默认错误框。
		const message = err instanceof Error ? err.message : String(err);
		error("command", "copyDiagnostics 写剪贴板失败", { error: message });
		void vscode.window.showErrorMessage(
			`写入剪贴板失败：${message}。可在 jjvs 输出通道查看详情。`,
		);
		return;
	}
	void vscode.window.showInformationMessage("已复制 jjvs 诊断信息到剪贴板");
}
