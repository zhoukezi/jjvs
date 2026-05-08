import * as vscode from "vscode";

import { JjFileDecorationProvider } from "./decorations";
import { registerDiffIntegration } from "./diff";
import { loadNativeBinding } from "./native";
import { isJjRepository } from "./repository";
import { JjRepositoryManager } from "./scm";

export function activate(context: vscode.ExtensionContext): void {
	// 提前触发原生绑定加载：任何失败立即抛出，让扩展激活显式失败，
	// 而非推迟到 SCM 面板刷新或打开 diff 时才暴露问题。
	const native = loadNativeBinding();

	// 健康检查：nativeVersion 确认 .node 可正常 dispatch 且返回值结构正确；
	// probeWorkspace 对每个识别为 jj 仓库的 workspace folder 真跑一次
	// Workspace::load，把平台 / 依赖不兼容问题前置到激活期——否则要等用户
	// 触发 SCM 刷新才暴露出来。
	native.nativeVersion();
	for (const folder of vscode.workspace.workspaceFolders ?? []) {
		if (!isJjRepository(folder.uri)) {
			continue;
		}
		native.probeWorkspace(folder.uri.fsPath);
	}

	registerDiffIntegration(context);
	const manager = new JjRepositoryManager();
	context.subscriptions.push(manager);

	// FileDecorationProvider 依赖 manager 聚合的装饰事件：provider 在构造时
	// 直接订阅 manager.onDidChangeDecorations，因此必须在 manager 实例化之后
	// 构造。start() 触发的首次 refresh 走 AsyncTask，会在本同步帧返回后才完成
	// 并发事件，顺序上不存在"漏掉首批事件"的风险。
	const decorationProvider = new JjFileDecorationProvider(manager);
	context.subscriptions.push(
		decorationProvider,
		vscode.window.registerFileDecorationProvider(decorationProvider),
	);

	manager.start();
}

export function deactivate(): void {
	// noop: disposables 由 context.subscriptions 统一释放
}
