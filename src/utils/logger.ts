import * as vscode from 'vscode';

export class Logger implements vscode.Disposable {
  private readonly channel: vscode.OutputChannel;

  public constructor(channelName = 'VSContext') {
    this.channel = vscode.window.createOutputChannel(channelName);
  }

  public info(message: string): void {
    this.channel.appendLine(`[INFO] ${new Date().toISOString()} ${message}`);
  }

  public warn(message: string): void {
    this.channel.appendLine(`[WARN] ${new Date().toISOString()} ${message}`);
  }

  public error(message: string, error?: unknown): void {
    const detail = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error ?? '');
    const suffix = detail.trim().length > 0 ? `\n${detail}` : '';
    this.channel.appendLine(`[ERROR] ${new Date().toISOString()} ${message}${suffix}`);
  }

  public show(preserveFocus = true): void {
    this.channel.show(preserveFocus);
  }

  public dispose(): void {
    this.channel.dispose();
  }
}
