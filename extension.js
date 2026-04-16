const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const vscode = require("vscode");

const CONTEXT_KEY = "codexHud.contextItems";
const INSTALL_PROMPT_KEY = "codexHud.hasShownInstallPrompt";
const OPEN_PANEL_COMMAND = "codexHud.openPanel";
const REFRESH_USAGE_COMMAND = "codexHud.refreshUsage";
const VIEW_FOCUS_COMMAND = "codexHud.dashboard.focus";
const PANEL_CONTAINER_COMMAND = "workbench.view.extension.codexHudPanel";
const MINUTES_IN_WEEK = 7 * 24 * 60;

function activate(context) {
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 98);
  statusBar.command = OPEN_PANEL_COMMAND;
  context.subscriptions.push(statusBar);

  const store = new CodexHudStore(context);
  const provider = new CodexHudViewProvider(context.extensionUri, store, refreshAll);
  let refreshTimer = undefined;

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("codexHud.dashboard", provider, {
      webviewOptions: {
        retainContextWhenHidden: true
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(OPEN_PANEL_COMMAND, async () => {
      await revealHudPanel();
    }),
    vscode.commands.registerCommand(REFRESH_USAGE_COMMAND, async () => {
      await store.refreshAutoUsage();
      refreshAll();
      vscode.window.showInformationMessage("Codex HUD usage refreshed from the latest Codex rollout.");
    }),
    vscode.commands.registerCommand("codexHud.captureSelection", async () => {
      const item = await captureSelectionAsContext(store);
      if (item) {
        refreshAll();
        vscode.window.showInformationMessage(`Saved context: ${item.title}`);
        await revealHudPanel();
      }
    }),
    vscode.commands.registerCommand("codexHud.setSessionUsage", async () => {
      const snapshot = store.getSnapshot();
      const value = await askForPercent("Session remaining percent", snapshot.usage.session.remainingPercent);
      if (value === undefined) {
        return;
      }

      const resetAt = await vscode.window.showInputBox({
        prompt: "Session reset label",
        value: snapshot.usage.session.resetAt
      });
      if (resetAt === undefined) {
        return;
      }

      await store.updateUsage({
        sessionUsedPercent: 100 - value,
        sessionResetAt: resetAt
      });
      refreshAll();
    }),
    vscode.commands.registerCommand("codexHud.setWeeklyUsage", async () => {
      const snapshot = store.getSnapshot();
      const value = await askForPercent("Weekly remaining percent", snapshot.usage.weekly.remainingPercent);
      if (value === undefined) {
        return;
      }

      const resetAt = await vscode.window.showInputBox({
        prompt: "Weekly reset label",
        value: snapshot.usage.weekly.resetAt
      });
      if (resetAt === undefined) {
        return;
      }

      await store.updateUsage({
        weeklyUsedPercent: 100 - value,
        weeklyResetAt: resetAt
      });
      refreshAll();
    }),
    vscode.commands.registerCommand("codexHud.clearContext", async () => {
      const choice = await vscode.window.showWarningMessage(
        "Clear all stored background context items?",
        { modal: true },
        "Clear"
      );
      if (choice !== "Clear") {
        return;
      }

      await store.setContextItems([]);
      refreshAll();
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("codexHud")) {
        void store.refreshAutoUsage();
        resetUsageRefreshTimer();
        refreshAll();
      }
    })
  );

  context.subscriptions.push({
    dispose: () => {
      if (refreshTimer) {
        clearInterval(refreshTimer);
      }
      statusBar.dispose();
    }
  });

  void initialize();
  void maybeShowInstallPrompt(context);

  async function initialize() {
    await store.refreshAutoUsage();
    resetUsageRefreshTimer();
    refreshAll();
  }

  function resetUsageRefreshTimer() {
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = undefined;
    }

    const refreshSeconds = clampNumber(
      vscode.workspace.getConfiguration("codexHud").get("rolloutRefreshSeconds", 30),
      10,
      3600
    );

    refreshTimer = setInterval(async () => {
      await store.refreshAutoUsage();
      refreshAll();
    }, refreshSeconds * 1000);
  }

  function refreshAll() {
    const snapshot = store.getSnapshot();
    renderStatusBar(statusBar, snapshot);
    provider.refresh(snapshot);
  }
}

function deactivate() {}

class CodexHudStore {
  constructor(context) {
    this.context = context;
    this.autoUsage = null;
    this.autoUsageError = null;
  }

  getSnapshot() {
    const config = vscode.workspace.getConfiguration("codexHud");
    const items = this.getContextItems();
    const totalManagedTokens = items.reduce((sum, item) => sum + item.tokens, 0);
    const autoUsage = this.autoUsage;
    const contextBaseTokens = nonNegativeNumber(config.get("contextWindow.baseTokens", 0));
    const configuredContextLimit = Math.max(1, nonNegativeNumber(config.get("contextWindow.limitTokens", 32000)));
    const contextLimitTokens = autoUsage?.modelContextWindow ?? configuredContextLimit;
    const contextUsedTokens = contextBaseTokens + totalManagedTokens;
    const contextUsedPercent = clampNumber((contextUsedTokens / contextLimitTokens) * 100, 0, 999);
    const contextRemainingTokens = Math.max(0, contextLimitTokens - contextUsedTokens);
    const contextRemainingPercent = clampNumber((contextRemainingTokens / contextLimitTokens) * 100, 0, 100);
    const sessionUsedPercent = clampNumber(autoUsage?.session.usedPercent ?? config.get("session.usedPercent", 0), 0, 100);
    const weeklyUsedPercent = clampNumber(autoUsage?.weekly.usedPercent ?? config.get("weekly.usedPercent", 0), 0, 100);
    const sessionRemainingPercent = clampNumber(100 - sessionUsedPercent, 0, 100);
    const weeklyRemainingPercent = clampNumber(100 - weeklyUsedPercent, 0, 100);
    const warnAtPercent = clampNumber(config.get("contextWindow.warnAtPercent", 75), 1, 100);
    const sortedItems = [...items].sort(sortContextItems);
    const longestItem = sortedItems.reduce((current, item) => {
      if (!current || item.tokens > current.tokens) {
        return item;
      }
      return current;
    }, undefined);

    return {
      generatedAt: new Date().toISOString(),
      usage: {
        session: {
          usedPercent: sessionUsedPercent,
          remainingPercent: sessionRemainingPercent,
          resetAt: autoUsage?.session.resetAtLabel ?? config.get("session.resetAt", ""),
          status: severityForPercent(sessionUsedPercent, 90)
        },
        weekly: {
          usedPercent: weeklyUsedPercent,
          remainingPercent: weeklyRemainingPercent,
          resetAt: autoUsage?.weekly.resetAtLabel ?? config.get("weekly.resetAt", ""),
          status: severityForPercent(weeklyUsedPercent, 80)
        },
        extraUsageEnabled: Boolean(config.get("extraUsageEnabled", false)),
        extraUsageLabel: config.get("extraUsageLabel", "Extra usage not enabled"),
        source: {
          mode: autoUsage ? "codex-rollout" : "manual",
          description: autoUsage
            ? `Auto-synced from ${path.basename(autoUsage.filePath)}`
            : "Manual values from Codex HUD settings",
          lastSyncedAt: autoUsage?.syncedAt ?? null,
          planType: autoUsage?.planType ?? null,
          filePath: autoUsage?.filePath ?? null,
          latestThreadTokenTotal: autoUsage?.threadTotalTokens ?? null,
          error: this.autoUsageError
        }
      },
      contextWindow: {
        baseTokens: contextBaseTokens,
        managedTokens: totalManagedTokens,
        usedTokens: contextUsedTokens,
        remainingTokens: contextRemainingTokens,
        limitTokens: contextLimitTokens,
        usedPercent: contextUsedPercent,
        remainingPercent: contextRemainingPercent,
        warnAtPercent,
        status: severityForPercent(contextUsedPercent, warnAtPercent),
        source: autoUsage ? "rollout" : "manual"
      },
      context: {
        totalItems: sortedItems.length,
        pinnedItems: sortedItems.filter((item) => item.pinned).length,
        totalTokens: totalManagedTokens,
        items: sortedItems
      },
      stats: {
        averageTokens: sortedItems.length ? Math.round(totalManagedTokens / sortedItems.length) : 0,
        longestItemTitle: longestItem ? longestItem.title : "None",
        longestItemTokens: longestItem ? longestItem.tokens : 0,
        compiledContext: buildCompiledContext(sortedItems)
      }
    };
  }

  getContextItems() {
    const items = this.context.workspaceState.get(CONTEXT_KEY, []);
    if (!Array.isArray(items)) {
      return [];
    }
    return items.map((item) => sanitizeContextItem(item, this.getCharsPerToken()));
  }

  async setContextItems(items) {
    await this.context.workspaceState.update(CONTEXT_KEY, items.map((item) => sanitizeContextItem(item, this.getCharsPerToken())));
  }

  async addContextItem(item) {
    const items = this.getContextItems();
    items.unshift(sanitizeContextItem(item, this.getCharsPerToken()));
    await this.setContextItems(items);
    return items[0];
  }

  async removeContextItem(id) {
    const items = this.getContextItems().filter((item) => item.id !== id);
    await this.setContextItems(items);
  }

  async togglePin(id) {
    const items = this.getContextItems().map((item) => {
      if (item.id !== id) {
        return item;
      }
      return {
        ...item,
        pinned: !item.pinned,
        updatedAt: new Date().toISOString()
      };
    });
    await this.setContextItems(items);
  }

  async updateUsage(payload) {
    const config = vscode.workspace.getConfiguration("codexHud");
    const updates = [];

    if (payload.sessionUsedPercent !== undefined) {
      updates.push(config.update("session.usedPercent", clampNumber(payload.sessionUsedPercent, 0, 100), vscode.ConfigurationTarget.Workspace));
    }
    if (payload.sessionResetAt !== undefined) {
      updates.push(config.update("session.resetAt", payload.sessionResetAt, vscode.ConfigurationTarget.Workspace));
    }
    if (payload.weeklyUsedPercent !== undefined) {
      updates.push(config.update("weekly.usedPercent", clampNumber(payload.weeklyUsedPercent, 0, 100), vscode.ConfigurationTarget.Workspace));
    }
    if (payload.weeklyResetAt !== undefined) {
      updates.push(config.update("weekly.resetAt", payload.weeklyResetAt, vscode.ConfigurationTarget.Workspace));
    }
    if (payload.extraUsageEnabled !== undefined) {
      updates.push(config.update("extraUsageEnabled", Boolean(payload.extraUsageEnabled), vscode.ConfigurationTarget.Workspace));
    }
    if (payload.extraUsageLabel !== undefined) {
      updates.push(config.update("extraUsageLabel", payload.extraUsageLabel, vscode.ConfigurationTarget.Workspace));
    }

    await Promise.all(updates);
  }

  async updateConfig(payload) {
    const config = vscode.workspace.getConfiguration("codexHud");
    const updates = [];

    if (payload.contextLimitTokens !== undefined) {
      updates.push(
        config.update(
          "contextWindow.limitTokens",
          Math.max(1, Math.round(nonNegativeNumber(payload.contextLimitTokens))),
          vscode.ConfigurationTarget.Workspace
        )
      );
    }
    if (payload.contextBaseTokens !== undefined) {
      updates.push(
        config.update(
          "contextWindow.baseTokens",
          Math.max(0, Math.round(nonNegativeNumber(payload.contextBaseTokens))),
          vscode.ConfigurationTarget.Workspace
        )
      );
    }
    if (payload.contextWarnAtPercent !== undefined) {
      updates.push(
        config.update(
          "contextWindow.warnAtPercent",
          clampNumber(Math.round(payload.contextWarnAtPercent), 1, 100),
          vscode.ConfigurationTarget.Workspace
        )
      );
    }

    await Promise.all(updates);
  }

  async refreshAutoUsage() {
    const config = vscode.workspace.getConfiguration("codexHud");
    const shouldAutoSync = config.get("autoSyncFromCodexRollouts", true);
    if (!shouldAutoSync) {
      this.autoUsage = null;
      this.autoUsageError = null;
      return null;
    }

    try {
      const codexHomePath = expandHomeDirectory(config.get("codexHomePath", "~/.codex"));
      const usage = await readLatestCodexUsage(codexHomePath);
      this.autoUsage = usage;
      this.autoUsageError = null;
      return usage;
    } catch (error) {
      this.autoUsage = null;
      this.autoUsageError = error instanceof Error ? error.message : String(error);
      return null;
    }
  }

  getCharsPerToken() {
    return clampNumber(vscode.workspace.getConfiguration("codexHud").get("tokenEstimateCharsPerToken", 4), 1, 12);
  }
}

class CodexHudViewProvider {
  constructor(extensionUri, store, onChange) {
    this.extensionUri = extensionUri;
    this.store = store;
    this.onChange = onChange;
    this.view = undefined;
  }

  resolveWebviewView(webviewView) {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")]
    };
    webviewView.webview.html = this.getHtml(webviewView.webview);
    webviewView.webview.onDidReceiveMessage(async (message) => {
      await this.handleMessage(message);
    });
    this.refresh(this.store.getSnapshot());
  }

  refresh(snapshot) {
    if (!this.view) {
      return;
    }

    this.view.webview.postMessage({
      type: "snapshot",
      payload: snapshot
    });
  }

  async handleMessage(message) {
    if (!message || typeof message !== "object") {
      return;
    }

    switch (message.type) {
      case "addContext": {
        const body = String(message.body || "").trim();
        if (!body) {
          return;
        }
        const title = String(message.title || "").trim() || deriveTitleFromText(body);
        await this.store.addContextItem({
          id: createId(),
          title,
          body,
          source: "manual",
          pinned: false,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        });
        this.onChange();
        return;
      }
      case "removeContext":
        await this.store.removeContextItem(String(message.id || ""));
        this.onChange();
        return;
      case "togglePin":
        await this.store.togglePin(String(message.id || ""));
        this.onChange();
        return;
      case "copyCompiledContext": {
        const compiledContext = this.store.getSnapshot().stats.compiledContext;
        await vscode.env.clipboard.writeText(compiledContext);
        vscode.window.showInformationMessage("Compiled background context copied.");
        return;
      }
      case "copyItem": {
        const snapshot = this.store.getSnapshot();
        const item = snapshot.context.items.find((entry) => entry.id === String(message.id || ""));
        if (item) {
          await vscode.env.clipboard.writeText(item.body);
          vscode.window.showInformationMessage(`Copied: ${item.title}`);
        }
        return;
      }
      case "captureSelection": {
        const item = await captureSelectionAsContext(this.store);
        if (item) {
          vscode.window.showInformationMessage(`Saved context: ${item.title}`);
        }
        this.onChange();
        return;
      }
      case "saveUsage":
        await this.store.updateUsage({
          sessionUsedPercent: toNumber(message.sessionUsedPercent),
          sessionResetAt: String(message.sessionResetAt || ""),
          weeklyUsedPercent: toNumber(message.weeklyUsedPercent),
          weeklyResetAt: String(message.weeklyResetAt || ""),
          extraUsageEnabled: Boolean(message.extraUsageEnabled),
          extraUsageLabel: String(message.extraUsageLabel || "")
        });
        this.onChange();
        return;
      case "saveConfig":
        await this.store.updateConfig({
          contextLimitTokens: toNumber(message.contextLimitTokens),
          contextBaseTokens: toNumber(message.contextBaseTokens),
          contextWarnAtPercent: toNumber(message.contextWarnAtPercent)
        });
        this.onChange();
        return;
      case "openSettings":
        await vscode.commands.executeCommand("workbench.action.openSettings", "@ext:local.codex-hud");
        return;
      case "revealPanel":
        await revealHudPanel();
        return;
      case "refreshUsage":
        await this.store.refreshAutoUsage();
        this.onChange();
        return;
      default:
        return;
    }
  }

  getHtml(webview) {
    const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "view.css"));
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "view.js"));
    const nonce = createNonce();
    const initialData = JSON.stringify(this.store.getSnapshot()).replace(/</g, "\\u003c");

    return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="${cssUri}" />
    <title>Codex HUD</title>
  </head>
  <body>
    <div id="app"></div>
    <script nonce="${nonce}">
      window.__CODEX_HUD_INITIAL_STATE__ = ${initialData};
    </script>
    <script nonce="${nonce}" src="${scriptUri}"></script>
  </body>
</html>`;
  }
}

async function captureSelectionAsContext(store) {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage("Open a file and select text to capture background context.");
    return undefined;
  }

  const selection = editor.selection;
  const text = editor.document.getText(selection).trim();
  if (!text) {
    vscode.window.showWarningMessage("Select some text first.");
    return undefined;
  }

  const source = buildSelectionSource(editor);
  const item = await store.addContextItem({
    id: createId(),
    title: deriveTitleFromText(text),
    body: text,
    source,
    pinned: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });

  return item;
}

async function revealHudPanel() {
  await tryCommand("workbench.action.positionPanelBottom");
  await tryCommand("workbench.action.focusPanel");
  await tryCommand(PANEL_CONTAINER_COMMAND);
  const focused = await tryCommand(VIEW_FOCUS_COMMAND);

  if (!focused) {
    await tryCommand("workbench.action.focusPanel");
    await tryCommand(PANEL_CONTAINER_COMMAND);
  }
}

async function maybeShowInstallPrompt(context) {
  const config = vscode.workspace.getConfiguration("codexHud");
  const shouldPrompt = config.get("openPanelOnFirstRun", true);
  const hasShownPrompt = context.globalState.get(INSTALL_PROMPT_KEY, false);

  if (!shouldPrompt || hasShownPrompt) {
    return;
  }

  await context.globalState.update(INSTALL_PROMPT_KEY, true);
  const choice = await vscode.window.showInformationMessage("Codex HUD installed. Open the bottom panel now?", "Open Panel");
  if (choice === "Open Panel") {
    await revealHudPanel();
  }
}

async function tryCommand(command, ...args) {
  try {
    await vscode.commands.executeCommand(command, ...args);
    return true;
  } catch (error) {
    console.error(error);
    return false;
  }
}

function renderStatusBar(statusBar, snapshot) {
  const session = `${Math.round(snapshot.usage.session.remainingPercent)}%`;
  const week = `${Math.round(snapshot.usage.weekly.remainingPercent)}%`;
  const context = `${Math.round(snapshot.contextWindow.remainingPercent)}%`;

  statusBar.text = `$(pulse) Codex S:${session} W:${week} Ctx:${context}`;
  statusBar.tooltip = [
    "Codex HUD",
    `Session remaining: ${session}${snapshot.usage.session.resetAt ? ` · resets ${snapshot.usage.session.resetAt}` : ""}`,
    `Week remaining: ${week}${snapshot.usage.weekly.resetAt ? ` · resets ${snapshot.usage.weekly.resetAt}` : ""}`,
    `Context remaining: ${snapshot.contextWindow.remainingTokens}/${snapshot.contextWindow.limitTokens} tokens`,
    `Background items: ${snapshot.context.totalItems}`,
    snapshot.usage.source.description
  ].join("\n");

  const hasDanger =
    snapshot.usage.session.status === "danger" ||
    snapshot.usage.weekly.status === "danger" ||
    snapshot.contextWindow.status === "danger";
  const hasWarn =
    snapshot.usage.session.status === "warn" ||
    snapshot.usage.weekly.status === "warn" ||
    snapshot.contextWindow.status === "warn";

  if (hasDanger) {
    statusBar.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
  } else if (hasWarn) {
    statusBar.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
  } else {
    statusBar.backgroundColor = undefined;
  }

  statusBar.show();
}

function sanitizeContextItem(item, charsPerToken) {
  const title = String(item.title || "Untitled");
  const body = String(item.body || "").trim();
  const source = String(item.source || "manual");
  const createdAt = item.createdAt || new Date().toISOString();
  const updatedAt = item.updatedAt || createdAt;

  return {
    id: String(item.id || createId()),
    title,
    body,
    source,
    pinned: Boolean(item.pinned),
    createdAt,
    updatedAt,
    charCount: body.length,
    tokens: estimateTokens(body, charsPerToken)
  };
}

function estimateTokens(text, charsPerToken) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (!normalized) {
    return 0;
  }
  return Math.max(1, Math.ceil(normalized.length / charsPerToken));
}

function buildCompiledContext(items) {
  if (!items.length) {
    return "";
  }

  return items
    .map((item, index) => {
      return [`[${index + 1}] ${item.title}`, `Source: ${item.source}`, item.body].join("\n");
    })
    .join("\n\n");
}

function sortContextItems(a, b) {
  if (a.pinned !== b.pinned) {
    return a.pinned ? -1 : 1;
  }
  return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
}

function severityForPercent(value, warnThreshold) {
  if (value >= 100) {
    return "danger";
  }
  if (value >= warnThreshold) {
    return "warn";
  }
  return "ok";
}

function clampNumber(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || 0));
}

function nonNegativeNumber(value) {
  return Math.max(0, Number(value) || 0);
}

function toNumber(value) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  return Number(value);
}

function deriveTitleFromText(text) {
  const firstLine = String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) {
    return "Background note";
  }
  return firstLine.length > 56 ? `${firstLine.slice(0, 53)}...` : firstLine;
}

function buildSelectionSource(editor) {
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
  const relativePath = workspaceFolder ? vscode.workspace.asRelativePath(editor.document.uri, false) : editor.document.uri.fsPath;
  const lineStart = editor.selection.start.line + 1;
  const lineEnd = editor.selection.end.line + 1;
  return `${relativePath}:${lineStart}-${lineEnd}`;
}

async function askForPercent(prompt, initialValue) {
  const rawValue = await vscode.window.showInputBox({
    prompt,
    value: String(initialValue)
  });
  if (rawValue === undefined) {
    return undefined;
  }

  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed)) {
    vscode.window.showErrorMessage("Enter a valid number between 0 and 100.");
    return undefined;
  }

  return clampNumber(parsed, 0, 100);
}

function createId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function createNonce() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let value = "";
  for (let index = 0; index < 32; index += 1) {
    value += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return value;
}

async function readLatestCodexUsage(codexHomePath) {
  const sessionsPath = path.join(codexHomePath, "sessions");
  const latestRollouts = await listLatestRolloutFiles(sessionsPath, 6);
  if (!latestRollouts.length) {
    throw new Error(`No Codex rollout files found in ${sessionsPath}`);
  }

  for (const filePath of latestRollouts) {
    const usage = await extractUsageFromRollout(filePath);
    if (usage) {
      return usage;
    }
  }

  throw new Error(`No token_count event with rate limits found in ${sessionsPath}`);
}

async function listLatestRolloutFiles(sessionsPath, limit) {
  const candidates = [];
  const yearDirs = await readDirectoryEntries(sessionsPath);

  for (const yearDir of yearDirs) {
    if (!yearDir.isDirectory()) {
      continue;
    }

    const yearPath = path.join(sessionsPath, yearDir.name);
    const monthDirs = await readDirectoryEntries(yearPath);
    for (const monthDir of monthDirs) {
      if (!monthDir.isDirectory()) {
        continue;
      }

      const monthPath = path.join(yearPath, monthDir.name);
      const dayDirs = await readDirectoryEntries(monthPath);
      for (const dayDir of dayDirs) {
        if (!dayDir.isDirectory()) {
          continue;
        }

        const dayPath = path.join(monthPath, dayDir.name);
        const files = await readDirectoryEntries(dayPath);
        for (const file of files) {
          if (!file.isFile() || !file.name.startsWith("rollout-") || !file.name.endsWith(".jsonl")) {
            continue;
          }

          const filePath = path.join(dayPath, file.name);
          try {
            const stat = await fsp.stat(filePath);
            candidates.push({
              filePath,
              mtimeMs: stat.mtimeMs
            });
          } catch (error) {
            console.error(error);
          }
        }
      }
    }
  }

  return candidates
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(0, limit)
    .map((entry) => entry.filePath);
}

async function readDirectoryEntries(targetPath) {
  try {
    return await fsp.readdir(targetPath, { withFileTypes: true });
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function extractUsageFromRollout(filePath) {
  const raw = await fsp.readFile(filePath, "utf8");
  const lines = raw.split(/\r?\n/);

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (!line) {
      continue;
    }

    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }

    if (event?.type !== "event_msg" || event?.payload?.type !== "token_count") {
      continue;
    }

    const rateLimits = event.payload.rate_limits;
    const usageInfo = event.payload.info;
    if (!rateLimits || !usageInfo) {
      continue;
    }

    const windows = [rateLimits.primary, rateLimits.secondary]
      .filter(Boolean)
      .map((window) => ({
        usedPercent: clampNumber(window.used_percent ?? 0, 0, 100),
        windowMinutes: nonNegativeNumber(window.window_minutes ?? 0),
        resetsAt: window.resets_at ?? null
      }))
      .filter((window) => window.windowMinutes > 0);

    if (!windows.length) {
      continue;
    }

    const sessionWindow = pickSessionWindow(windows);
    const weeklyWindow = pickWeeklyWindow(windows, sessionWindow);
    const totalUsage = usageInfo.total_token_usage ?? {};

    return {
      syncedAt: new Date().toISOString(),
      filePath,
      planType: rateLimits.plan_type ?? null,
      session: {
        usedPercent: sessionWindow.usedPercent,
        resetAt: sessionWindow.resetsAt,
        resetAtLabel: formatResetLabel(sessionWindow.resetsAt)
      },
      weekly: {
        usedPercent: weeklyWindow.usedPercent,
        resetAt: weeklyWindow.resetsAt,
        resetAtLabel: formatResetLabel(weeklyWindow.resetsAt)
      },
      threadTotalTokens: nonNegativeNumber(totalUsage.total_tokens ?? 0),
      modelContextWindow: nonNegativeNumber(usageInfo.model_context_window ?? 0) || null,
      lastTokenUsage: usageInfo.last_token_usage ?? null
    };
  }

  return null;
}

function pickSessionWindow(windows) {
  return [...windows].sort((left, right) => left.windowMinutes - right.windowMinutes)[0];
}

function pickWeeklyWindow(windows, sessionWindow) {
  const weeklyCandidate = [...windows].sort((left, right) => {
    return Math.abs(left.windowMinutes - MINUTES_IN_WEEK) - Math.abs(right.windowMinutes - MINUTES_IN_WEEK);
  })[0];

  return weeklyCandidate || sessionWindow;
}

function formatResetLabel(unixSeconds) {
  if (!unixSeconds) {
    return "";
  }

  const target = new Date(unixSeconds * 1000);
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "Local";
  const now = new Date();
  const isSameDay = target.toDateString() === now.toDateString();
  const dateFormatter = new Intl.DateTimeFormat(undefined, isSameDay ? { hour: "numeric", minute: "2-digit" } : { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  return `${dateFormatter.format(target)} (${timezone})`;
}

function expandHomeDirectory(targetPath) {
  if (!targetPath || targetPath === "~") {
    return os.homedir();
  }

  if (targetPath.startsWith("~/")) {
    return path.join(os.homedir(), targetPath.slice(2));
  }

  return targetPath;
}

module.exports = {
  activate,
  deactivate
};
