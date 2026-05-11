import * as vscode from "vscode";

import { JjFileDecorationProvider } from "./decorations";
import { registerDiffIntegration } from "./diff";
import * as logger from "./logger";
import { loadNativeBinding } from "./native";
import { isJjRepository } from "./repository";
import { JjRepositoryManager } from "./scm";
import { JjStatusBar } from "./statusBar";

const LOG_LEVEL_CONFIG_KEY = "jjvs.log.level";

export function activate(context: vscode.ExtensionContext): void {
	// logger 模块在 import 时已创建 OutputChannel("jjvs")。先把 channel
	// 生命周期挂到 context，再把用户配置同步到 logger，之后才做可能产生日志
	// 的操作。
	//
	// 默认值一律由 package.json 的 contributes.configuration schema 提供，
	// TS 侧不重复 fallback——与 scm.ts / statusBar.ts 对其它配置项的处理
	// 一致。非法字符串由 VSCode schema + UI 校验拦截，不属于运行时需兜底的
	// 场景。
	logger.register(context);
	const cfg = vscode.workspace.getConfiguration("jjvs");
	logger.setLevel(cfg.get<string>("log.level")! as logger.LogLevel);
	logger.info("extension", "activate 开始");

	// 提前触发原生绑定加载：任何失败立即抛出，让扩展激活显式失败，而非推迟
	// 到 SCM 面板刷新或打开 diff 时才暴露问题。不在这里包 try/catch——fail-fast
	// 方针下多余的 catch 只是把错误再抛一次，还打破了"loader 失败的唯一表现
	// 是抛出"这个不变式。
	const native = loadNativeBinding();

	// 装配 native logger 桥接：TSFN 回调 + 把 TS 侧当前级别推给 Rust，让
	// `log::set_max_level` 早期短路 trace 热点。
	logger.attachNative(native);
	logger.info("native", "原生绑定已加载", { version: native.nativeVersion() });

	// 健康检查：nativeVersion 确认 .node 可正常 dispatch 且返回值结构正确；
	// probeWorkspace 对每个识别为 jj 仓库的 workspace folder 真跑一次
	// Workspace::load，把平台 / 依赖不兼容问题前置到激活期——否则要等用户
	// 触发 SCM 刷新才暴露出来。
	native.nativeVersion();
	for (const folder of vscode.workspace.workspaceFolders ?? []) {
		if (!isJjRepository(folder.uri)) {
			continue;
		}
		const probe = native.probeWorkspace(folder.uri.fsPath);
		logger.debug("extension", "probeWorkspace", {
			folder: folder.uri.fsPath,
			isJjWorkspace: probe.isJjWorkspace,
			workspaceRoot: probe.workspaceRoot,
			currentCommitId: probe.currentCommitId,
			parentCommitId: probe.parentCommitId,
			operationId: probe.operationId,
		});
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

	// 状态栏在 manager.start() 之前构造，这样 manager 触发的首次 refresh 发出
	// summary 事件时，statusBar 已经订阅上；与 FileDecorationProvider 的先后
	// 处理逻辑一致。
	const statusBar = new JjStatusBar(manager);
	context.subscriptions.push(statusBar);

	// 日志级别配置实时跟随；其它 jjvs.* 配置由各自订阅者处理，与 logger 无关。
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((event) => {
			if (!event.affectsConfiguration(LOG_LEVEL_CONFIG_KEY)) {
				return;
			}
			const level = vscode.workspace
				.getConfiguration("jjvs")
				.get<string>("log.level")! as logger.LogLevel;
			logger.setLevel(level);
			logger.debug("command", "日志级别切换", { level });
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("jjvs.showLog", () => {
			logger.debug("command", "jjvs.showLog");
			logger.showLog();
		}),
		vscode.commands.registerCommand("jjvs.copyDiagnostics", async () => {
			logger.debug("command", "jjvs.copyDiagnostics");
			await logger.copyDiagnostics(context, manager, native.nativeVersion());
		}),
		vscode.commands.registerCommand("jjvs.refresh", async () => {
			logger.debug("command", "jjvs.refresh");
			try {
				await manager.refreshAll();
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				logger.error("command", "jjvs.refresh 失败", { error: message });
				void vscode.window.showErrorMessage(`jjvs 刷新失败：${message}`);
			}
		}),
	);

	manager.start();
	logger.info("extension", "activate 完成");
}

export function deactivate(): void {
	// noop: disposables 由 context.subscriptions 统一释放
	logger.info("extension", "deactivate");
}
