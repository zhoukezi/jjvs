import type * as vscode from "vscode";

import { JjRepositoryManager } from "./scm";

export function activate(context: vscode.ExtensionContext): void {
	const manager = new JjRepositoryManager();
	context.subscriptions.push(manager);
	manager.start();
}

export function deactivate(): void {
	// noop: disposables 由 context.subscriptions 统一释放
}
