import type * as vscode from "vscode";

import { loadNativeBinding } from "./native";
import { JjRepositoryManager } from "./scm";

export function activate(context: vscode.ExtensionContext): void {
	// 提前触发原生绑定加载：任何失败立即抛出，让扩展激活显式失败，
	// 而非推迟到 M2 的某个具体调用点才暴露问题。
	loadNativeBinding();
	const manager = new JjRepositoryManager();
	context.subscriptions.push(manager);
	manager.start();
}

export function deactivate(): void {
	// noop: disposables 由 context.subscriptions 统一释放
}
