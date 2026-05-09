import * as fs from "node:fs";
import * as path from "node:path";

// TS 侧与 napi-rs 原生绑定之间的唯一边界。
// 方针：扩展强依赖原生绑定，任何加载失败（平台不符 / 产物缺失 / 导出错配 /
// require 抛错）都直接向上抛出，由 activate 让 VSCode 把"扩展激活失败"展示
// 出来——不存在任何降级路径。
// 类型定义在 TS 侧手写，不依赖构建时生成的 native/index.d.ts，避免「必须先
// 跑 build:native 才能 typecheck」的耦合。新增 #[napi] 导出时：(1) 更新
// NativeBinding 接口；(2) 在 loadNativeBinding 的导出存在性检查里加一项。

export interface WorkspaceProbe {
	isJjWorkspace: boolean;
	workspaceRoot: string;
	currentCommitId: string | null;
	parentCommitId: string | null;
	operationId: string | null;
}

export type FileChangeKind = "added" | "modified" | "removed";

export interface FileChange {
	kind: FileChangeKind;
	/** 相对仓库根、以正斜杠分隔的路径。 */
	path: string;
}

export interface ListChangesResult {
	workspaceRoot: string;
	currentCommitId: string;
	/**
	 * 当前 working-copy commit 的 change_id，reverse_hex 形式（字符集 k-z，
	 * 对齐 jj CLI 展示约定）。与 currentCommitId 的标准 hex（0-9a-f）区分开。
	 * 状态栏 tooltip 用。
	 */
	currentChangeId: string;
	/**
	 * 当前 change_id 的最短唯一前缀（同为 reverse_hex 形式）。对齐 jj CLI 默认
	 * 模板 `shortest(change_id, 8)`：不足 8 位时填充至 8 位，超过 8 位时按实际
	 * 长度展示。
	 */
	currentChangeIdPrefix: string;
	/** 当前 commit 的 description 原文（可能为空串、可能含换行）。 */
	currentDescription: string;
	/** 当前 commit 上贴着的所有 local bookmark 名（顺序来自 jj-lib）。 */
	currentBookmarks: string[];
	parentCommitId: string;
	operationId: string;
	changes: FileChange[];
}

export interface NativeBinding {
	nativeVersion(): string;
	probeWorkspace(workspacePath: string): WorkspaceProbe;
	listChanges(workspacePath: string): Promise<ListChangesResult>;
	readFileAtCommit(
		workspacePath: string,
		commitId: string,
		repoPath: string,
	): Promise<Buffer>;
	/**
	 * 判断仓库内某路径是否被 jj 的 ignore 规则命中。`repoPath` 为相对仓库根、
	 * 正斜杠分隔的路径（与 FileChange.path 形式一致）。
	 */
	isPathIgnored(workspacePath: string, repoPath: string): Promise<boolean>;
	/** 清空指定 workspace 的 ignore 链缓存。`.gitignore` 变更后调用。 */
	invalidateIgnoreCache(workspacePath: string): void;
	/**
	 * 判断指定 jj workspace 是否与 Git 仓库 colocated（.jj 与 .git 共存于同一
	 * 根）。判定逻辑对齐 `jj git colocation status`。
	 */
	isColocatedWorkspace(workspacePath: string): boolean;
}

// M1 仅构建 x86_64-unknown-linux-gnu；其他平台一律视为不可用。
const SUPPORTED_PLATFORM = "linux";
const SUPPORTED_ARCH = "x64";

function resolveWrapperPath(): string {
	// __dirname 是编译后 out/ 目录；native/ 与 out/ 同级在仓库根。
	return path.join(__dirname, "..", "native", "index.js");
}

let cached: NativeBinding | undefined;

export function loadNativeBinding(): NativeBinding {
	if (cached) {
		return cached;
	}
	cached = loadOnce();
	return cached;
}

function loadOnce(): NativeBinding {
	if (
		process.platform !== SUPPORTED_PLATFORM ||
		process.arch !== SUPPORTED_ARCH
	) {
		throw new Error(
			`jjvs 仅支持 Linux x86_64（当前：${process.platform}/${process.arch}）。`,
		);
	}

	const wrapperPath = resolveWrapperPath();
	if (!fs.existsSync(wrapperPath)) {
		throw new Error(
			`未找到原生绑定 wrapper：${wrapperPath}。请在仓库根目录运行 \`bun run build:native\` 构建后重试。`,
		);
	}

	// require 抛错（wrapper 内找不到 .node / .node 与 Node ABI 不匹配 / 动态
	// 链接失败等）直接向上冒泡——不在这里捕获伪装成结构化错误。
	const mod = require(wrapperPath) as Partial<NativeBinding>;
	if (
		typeof mod.nativeVersion !== "function" ||
		typeof mod.probeWorkspace !== "function" ||
		typeof mod.listChanges !== "function" ||
		typeof mod.readFileAtCommit !== "function" ||
		typeof mod.isPathIgnored !== "function" ||
		typeof mod.invalidateIgnoreCache !== "function" ||
		typeof mod.isColocatedWorkspace !== "function"
	) {
		throw new Error(
			`原生绑定缺少期望的导出函数，TS 与 Rust 侧 API 版本错配。wrapper：${wrapperPath}`,
		);
	}
	return mod as NativeBinding;
}
