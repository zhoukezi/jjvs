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
