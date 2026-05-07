import * as vscode from "vscode";

export function activate(context: vscode.ExtensionContext): void {
	const hello = vscode.commands.registerCommand("jjvs.helloWorld", () => {
		vscode.window.showInformationMessage("jjvs activated.");
	});

	context.subscriptions.push(hello);
}

export function deactivate(): void {
	// noop
}
