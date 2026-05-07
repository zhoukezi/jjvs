import * as vscode from "vscode";

import { isJjRepository } from "./repository";

class JjSourceControl implements vscode.Disposable {
	private readonly sourceControl: vscode.SourceControl;
	private readonly placeholderGroup: vscode.SourceControlResourceGroup;

	constructor(folder: vscode.WorkspaceFolder) {
		this.sourceControl = vscode.scm.createSourceControl(
			"jjvs",
			"Jujutsu",
			folder.uri,
		);
		this.sourceControl.inputBox.placeholder = "暂未实现提交输入";

		this.placeholderGroup = this.sourceControl.createResourceGroup(
			"jjvs.placeholder",
			"工作副本（M1 占位）",
		);
		this.placeholderGroup.hideWhenEmpty = false;
	}

	dispose(): void {
		this.placeholderGroup.dispose();
		this.sourceControl.dispose();
	}
}

export class JjRepositoryManager implements vscode.Disposable {
	private readonly repositories = new Map<string, JjSourceControl>();
	private readonly disposables: vscode.Disposable[] = [];

	start(): void {
		this.syncAll();
		this.disposables.push(
			vscode.workspace.onDidChangeWorkspaceFolders(() => this.syncAll()),
		);
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
				this.repositories.set(key, new JjSourceControl(folder));
			}
		}

		for (const key of Array.from(this.repositories.keys())) {
			if (!desired.has(key)) {
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
		for (const repo of this.repositories.values()) {
			repo.dispose();
		}
		this.repositories.clear();
	}
}
