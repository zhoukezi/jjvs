import * as fs from "node:fs";
import * as path from "node:path";

import type * as vscode from "vscode";

// M0 范围：仅把 workspace folder 根是否含 `.jj` 作为是否为 jj 仓库的判据。
// 附加 workspace 场景下 `.jj/repo` 是文件而非目录，`.jj` 本身仍是目录，因此
// 这里用 existsSync 覆盖两类情况；fs 自动 follow symlinks。
// 子目录打开、colocated 下判别 native vs colocated 等，留给后续里程碑。
export function isJjRepository(folderUri: vscode.Uri): boolean {
	if (folderUri.scheme !== "file") {
		return false;
	}
	return fs.existsSync(path.join(folderUri.fsPath, ".jj"));
}

/**
 * 解析 workspace folder 对应的真实 jj repo 目录（含 `op_heads/`、`op_store/`
 * 等共享状态的那一级）。
 *
 * 布局两种：
 * - **primary / colocated**：`<folder>/.jj/repo` 是目录，直接作为 repo 目录。
 * - **secondary**：`<folder>/.jj/repo` 是文件，内容为相对于 `<folder>/.jj/`
 *   的路径字符串（jj CLI 在 `jj workspace add` 时写入），resolve 后得到主
 *   workspace 的真实 repo 目录。
 *
 * 任何不符合上述两种的情况（文件不存在 / 内容为空 / resolve 后的目标不存在
 * 或不是目录）直接抛错，对齐 native 绑定的 fail-fast 方针——repo 定位失败意
 * 味着 stale watcher / 后续功能都无法工作，让 VSCode 把"扩展激活失败"显式
 * 展示出来好过静默装 primary。
 */
export function resolveJjRepoDir(folderFsPath: string): {
	repoDir: string;
	isSecondary: boolean;
} {
	const repoEntry = path.join(folderFsPath, ".jj", "repo");
	const stat = fs.statSync(repoEntry);
	if (stat.isDirectory()) {
		return { repoDir: repoEntry, isSecondary: false };
	}
	if (!stat.isFile()) {
		throw new Error(
			`jjvs: ${repoEntry} 既不是目录也不是文件，无法解析 jj repo 位置`,
		);
	}
	const raw = fs.readFileSync(repoEntry, "utf8").trim();
	if (raw.length === 0) {
		throw new Error(
			`jjvs: ${repoEntry} 内容为空，无法解析 secondary workspace 的 repo 路径`,
		);
	}
	const resolved = path.resolve(path.join(folderFsPath, ".jj"), raw);
	const targetStat = fs.statSync(resolved);
	if (!targetStat.isDirectory()) {
		throw new Error(
			`jjvs: secondary workspace 的 .jj/repo 指向 ${resolved}，但该路径不是目录`,
		);
	}
	return { repoDir: resolved, isSecondary: true };
}
