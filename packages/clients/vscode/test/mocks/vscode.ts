// Minimal in-memory `vscode` API stub for unit tests. The Vitest config aliases
// the `vscode` module to this file, so no real extension host is required
// (docs/009 §1: "客户端改动额外跑 test，不要求 CI 启动真实 VSCode").
//
// Keep this file dependency-free and typed loosely: it only has to behave like
// the API surface our extension touches at runtime.

export interface Disposable {
  dispose(): void;
}

export class EventEmitter<T> {
  private readonly listeners = new Set<(value: T) => void>();

  readonly event = (listener: (value: T) => void): Disposable => {
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      },
    };
  };

  fire(value: T): void {
    for (const listener of [...this.listeners]) {
      listener(value);
    }
  }

  dispose(): void {
    this.listeners.clear();
  }
}

export const StatusBarAlignment = { Left: 1, Right: 2 } as const;
export const TreeItemCollapsibleState = { None: 0, Collapsed: 1, Expanded: 2 } as const;
export const ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 } as const;
export const ViewColumn = { Active: -1, One: 1, Two: 2 } as const;

export class ThemeIcon {
  readonly id: string;
  constructor(id: string) {
    this.id = id;
  }
}

export class TreeItem {
  label: string | undefined;
  collapsibleState: number | undefined;
  id: string | undefined;
  description: string | boolean | undefined;
  tooltip: string | undefined;
  contextValue: string | undefined;
  iconPath: unknown;
  command: unknown;
  accessibilityInformation: { label: string; role?: string } | undefined;

  constructor(label?: string, collapsibleState?: number) {
    this.label = label;
    this.collapsibleState = collapsibleState;
  }
}

export class Uri {
  readonly scheme: string;
  readonly fsPath: string;

  private constructor(scheme: string, fsPath: string) {
    this.scheme = scheme;
    this.fsPath = fsPath;
  }

  static file(fsPath: string): Uri {
    return new Uri('file', fsPath);
  }

  static parse(value: string): Uri {
    const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/(.*)$/.exec(value);
    if (match === null) {
      return new Uri('file', value);
    }
    return new Uri(match[1] ?? 'file', decodeURIComponent(match[2] ?? ''));
  }

  static joinPath(base: Uri, ...segments: string[]): Uri {
    return new Uri(base.scheme, [base.fsPath.replace(/\/+$/, ''), ...segments].join('/'));
  }

  with(change: { path?: string; scheme?: string }): Uri {
    return new Uri(change.scheme ?? this.scheme, change.path ?? this.fsPath);
  }

  toString(): string {
    const suffix = this.scheme === 'file' ? '' : `${this.fsPath.split('/').slice(-1)[0] ?? ''}`;
    return `${this.scheme}://${this.fsPath}${suffix === '' ? '' : ''}`;
  }
}

export interface MockState {
  registeredCommands: Map<string, (...args: unknown[]) => unknown>;
  executedCommands: { command: string; args: unknown[] }[];
  statusBarItems: MockStatusBarItem[];
  treeViews: MockTreeView[];
  inputBoxResponses: (string | undefined)[];
  quickPickResponses: unknown[];
  informationMessages: { message: string; items: string[] }[];
  warningMessages: string[];
  errorMessages: string[];
  informationMessageResponse: string | undefined;
  activeTextEditor: unknown;
  configuration: Record<string, unknown>;
  configUpdates: { section: string; value: unknown; target?: number }[];
  openedDocuments: { path?: string; content?: string }[];
  outputLines: string[];
  workspaceFolders: MockWorkspaceFolder[] | undefined;
  workspaceTrusted: boolean;
}

export const mockState: MockState = {
  registeredCommands: new Map(),
  executedCommands: [],
  statusBarItems: [],
  treeViews: [],
  inputBoxResponses: [],
  quickPickResponses: [],
  informationMessages: [],
  warningMessages: [],
  errorMessages: [],
  informationMessageResponse: undefined,
  activeTextEditor: undefined,
  configuration: {},
  configUpdates: [],
  openedDocuments: [],
  outputLines: [],
  workspaceFolders: undefined,
  workspaceTrusted: true,
};

export function resetVscodeMock(): void {
  mockState.registeredCommands.clear();
  mockState.executedCommands.length = 0;
  mockState.statusBarItems.length = 0;
  mockState.treeViews.length = 0;
  mockState.inputBoxResponses.length = 0;
  mockState.quickPickResponses.length = 0;
  mockState.informationMessages.length = 0;
  mockState.warningMessages.length = 0;
  mockState.errorMessages.length = 0;
  mockState.informationMessageResponse = undefined;
  mockState.activeTextEditor = undefined;
  mockState.configuration = {};
  mockState.configUpdates.length = 0;
  mockState.openedDocuments.length = 0;
  mockState.outputLines.length = 0;
  mockState.workspaceFolders = undefined;
  mockState.workspaceTrusted = true;
}

export interface MockWorkspaceFolder {
  uri: Uri;
  name: string;
  index: number;
}

export interface MockStatusBarItem extends Disposable {
  text: string;
  tooltip: string | undefined;
  command: string | undefined;
  name: string | undefined;
  accessibilityInformation: { label: string; role?: string } | undefined;
  visible: boolean;
  show(): void;
  hide(): void;
}

export interface MockTreeView extends Disposable {
  visible: boolean;
  message: string | undefined;
  title: string | undefined;
  /** The provider passed to createTreeView, so tests can inspect inbox nodes. */
  treeDataProvider: unknown;
  reveal(): Promise<void>;
}

function createStatusBarItem(alignment: number, priority: number): MockStatusBarItem {
  const item: MockStatusBarItem = {
    text: '',
    tooltip: undefined,
    command: undefined,
    name: undefined,
    accessibilityInformation: undefined,
    visible: false,
    show() {
      item.visible = true;
    },
    hide() {
      item.visible = false;
    },
    dispose() {
      item.visible = false;
    },
    // Alignment/priority are not asserted by unit tests but keep them visible.
    ...({ alignment, priority } as Record<string, unknown>),
  };
  mockState.statusBarItems.push(item);
  return item;
}

function createTreeView(options?: unknown): MockTreeView {
  const view: MockTreeView = {
    visible: true,
    message: undefined,
    title: undefined,
    treeDataProvider: (options as { treeDataProvider?: unknown } | undefined)?.treeDataProvider,
    reveal: async () => undefined,
    dispose: () => {
      view.visible = false;
    },
  };
  mockState.treeViews.push(view);
  return view;
}

export interface MockConfiguration {
  get<T>(section: string, defaultValue?: T): T | undefined;
  has(section: string): boolean;
  update(section: string, value: unknown, target?: number): Promise<void>;
  inspect(section: string): unknown;
}

function createConfiguration(prefix?: string): MockConfiguration {
  const fullKey = (section: string): string => (prefix === undefined ? section : `${prefix}.${section}`);
  return {
    get<T>(section: string, defaultValue?: T): T | undefined {
      const key = fullKey(section);
      const value = mockState.configuration[key];
      return value === undefined ? defaultValue : (value as T);
    },
    has(section: string): boolean {
      return mockState.configuration[fullKey(section)] !== undefined;
    },
    async update(section: string, value: unknown, target?: number): Promise<void> {
      mockState.configuration[fullKey(section)] = value;
      mockState.configUpdates.push({
        section: fullKey(section),
        value,
        ...(target === undefined ? {} : { target }),
      });
    },
    inspect: (section: string) => ({ key: fullKey(section), globalValue: mockState.configuration[fullKey(section)] }),
  };
}

export interface MockTextDocument {
  uri: Uri;
  languageId: string;
  getText(): string;
}

function createTextDocument(content: string, languageId = 'markdown', path?: string): MockTextDocument {
  const uri = path === undefined ? Uri.parse('untitled:Untitled-1') : Uri.file(path);
  return { uri, languageId, getText: () => content };
}

export const window = {
  createStatusBarItem: (alignment: number, priority: number): MockStatusBarItem =>
    createStatusBarItem(alignment, priority),
  createTreeView: (_viewId: string, options?: unknown): MockTreeView => createTreeView(options),
  async showInputBox(_options?: unknown): Promise<string | undefined> {
    return mockState.inputBoxResponses.shift();
  },
  async showQuickPick<T>(items: T[] | Promise<T[]>, _options?: unknown): Promise<T | undefined> {
    const resolved = await items;
    const queued = mockState.quickPickResponses.shift();
    if (queued !== undefined) {
      return queued as T;
    }
    return resolved[0];
  },
  async showInformationMessage(message: string, ...items: string[]): Promise<string | undefined> {
    mockState.informationMessages.push({ message, items });
    return mockState.informationMessageResponse;
  },
  async showWarningMessage(message: string, ..._items: string[]): Promise<string | undefined> {
    mockState.warningMessages.push(message);
    return undefined;
  },
  async showErrorMessage(message: string, ..._items: string[]): Promise<string | undefined> {
    mockState.errorMessages.push(message);
    return undefined;
  },
  async showTextDocument(document: MockTextDocument, _options?: unknown): Promise<MockTextDocument> {
    mockState.openedDocuments.push({ path: document.uri.fsPath });
    return document;
  },
  createOutputChannel(name: string): {
    name: string;
    appendLine(value: string): void;
    append(value: string): void;
    show(): void;
    dispose(): void;
  } {
    return {
      name,
      appendLine: (value: string) => {
        mockState.outputLines.push(value);
      },
      append: (value: string) => {
        mockState.outputLines.push(value);
      },
      show: () => undefined,
      dispose: () => undefined,
    };
  },
  get activeTextEditor(): unknown {
    return mockState.activeTextEditor;
  },
};

export const commands = {
  registerCommand(name: string, callback: (...args: unknown[]) => unknown): Disposable {
    mockState.registeredCommands.set(name, callback);
    return {
      dispose: () => {
        mockState.registeredCommands.delete(name);
      },
    };
  },
  async executeCommand<T = unknown>(name: string, ...args: unknown[]): Promise<T | undefined> {
    mockState.executedCommands.push({ command: name, args });
    const callback = mockState.registeredCommands.get(name);
    if (callback === undefined) {
      return undefined;
    }
    return (await callback(...args)) as T;
  },
  async getCommands(): Promise<string[]> {
    return [...mockState.registeredCommands.keys()];
  },
};

const workspaceFoldersEmitter = new EventEmitter<unknown>();

/** Test helper: fire `onDidChangeWorkspaceFolders` (folder switch / removal). */
export function fireWorkspaceFoldersChanged(): void {
  workspaceFoldersEmitter.fire(undefined);
}

export const workspace = {
  get workspaceFolders(): MockWorkspaceFolder[] | undefined {
    return mockState.workspaceFolders;
  },
  get isTrusted(): boolean {
    return mockState.workspaceTrusted;
  },
  getConfiguration(prefix?: string): MockConfiguration {
    return createConfiguration(prefix);
  },
  onDidChangeConfiguration: new EventEmitter<unknown>().event,
  onDidChangeWorkspaceFolders: workspaceFoldersEmitter.event,
  async openTextDocument(arg: { content: string; language?: string } | Uri): Promise<MockTextDocument> {
    if (arg instanceof Uri) {
      const opened = mockState.openedDocuments.find((entry) => entry.path === arg.fsPath);
      return createTextDocument(opened?.content ?? '', 'markdown', arg.fsPath);
    }
    return createTextDocument(arg.content, arg.language ?? 'markdown');
  },
  fs: {
    async readFile(): Promise<Uint8Array> {
      return new Uint8Array();
    },
    async writeFile(): Promise<void> {
      // no-op
    },
    async createDirectory(): Promise<void> {
      // no-op
    },
  },
};

export const env = {
  machineId: 'mock-machine-id',
  appName: 'Visual Studio Code',
  language: 'en',
  async openExternal(_uri: Uri): Promise<boolean> {
    return true;
  },
  clipboard: {
    async writeText(_value: string): Promise<void> {
      // no-op
    },
    async readText(): Promise<string> {
      return '';
    },
  },
};

export const version = '1.90.0';
export const ViewColumn1 = ViewColumn;

export class InMemorySecretStorage {
  private readonly values = new Map<string, string>();

  async get(key: string): Promise<string | undefined> {
    return this.values.get(key);
  }

  async store(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }

  onDidChange = new EventEmitter<{ key: string }>().event;
}

export class InMemoryMemento {
  private readonly values = new Map<string, unknown>();

  get<T>(key: string, defaultValue?: T): T | undefined {
    return this.values.has(key) ? (this.values.get(key) as T) : defaultValue;
  }

  async update(key: string, value: unknown): Promise<void> {
    if (value === undefined) {
      this.values.delete(key);
      return;
    }
    this.values.set(key, value);
  }

  keys(): readonly string[] {
    return [...this.values.keys()];
  }

  setKeysForSync(): void {
    // no-op
  }
}

export interface MockExtensionContext {
  subscriptions: Disposable[];
  secrets: InMemorySecretStorage;
  workspaceState: InMemoryMemento;
  globalState: InMemoryMemento;
  extensionPath: string;
  extensionUri: Uri;
}

export function createMockExtensionContext(): MockExtensionContext {
  return {
    subscriptions: [],
    secrets: new InMemorySecretStorage(),
    workspaceState: new InMemoryMemento(),
    globalState: new InMemoryMemento(),
    extensionPath: '/mock-extension',
    extensionUri: Uri.file('/mock-extension'),
  };
}
