// Status bar item: connection state + pending count; clicking toggles
// accepting (docs/005 §2.2).
import * as vscode from 'vscode';
import { TOGGLE_ACCEPTING_COMMAND, computeStatusBar, type PresenceSnapshot } from './presence.js';

export const STATUS_BAR_PRIORITY = 100;

export class ConnectionStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;

  constructor(initial: PresenceSnapshot) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, STATUS_BAR_PRIORITY);
    this.item.command = TOGGLE_ACCEPTING_COMMAND;
    this.item.name = 'SAP Super Agent';
    this.update(initial);
    this.item.show();
  }

  update(snapshot: PresenceSnapshot): void {
    const presentation = computeStatusBar(snapshot);
    this.item.text = presentation.text;
    this.item.tooltip = presentation.tooltip;
    this.item.command = presentation.command;
    // Codicon tokens are noise for screen readers: read the plain label instead.
    this.item.accessibilityInformation = { label: presentation.accessibilityLabel };
  }

  dispose(): void {
    this.item.dispose();
  }
}
