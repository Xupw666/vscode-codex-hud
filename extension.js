const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const vscode = require("vscode");
const {
  appendPetEvent,
  createNotificationEventFromCodexEvent
} = require("./codexNotifications");
const {
  startDesktopPet,
  stopDesktopPet
} = require("./desktopPet");
const {
  CODEX_CUSTOM_EDITOR_VIEW_TYPE,
  CODEX_PANEL_AUTHORITY,
  CODEX_PANEL_ROUTE_PATH,
  CODEX_PANEL_SCHEME,
  choosePostLaunchFocusCommand,
  createCodexPanelQuery,
  formatLaunchErrorMessage,
  shouldAutoLaunch
} = require("./quickLauncher");
const {
  DEFAULT_PET_ID,
  DEFAULT_PET_SLUG,
  disablePetAutoWake,
  enablePetAutoWake
} = require("./petAutoWake");

const CONTEXT_KEY = "codexHud.contextItems";
const INSTALL_PROMPT_KEY = "codexHud.hasShownInstallPrompt";
const OPEN_PANEL_COMMAND = "codexHud.openPanel";
const QUICK_OPEN_CODEX_AGENT_COMMAND = "codexHud.quickOpenCodexAgent";
const OPEN_THREE_CODEX_AGENTS_COMMAND = "codexHud.openThreeCodexAgents";
const OPEN_FOUR_CODEX_AGENTS_COMMAND = "codexHud.openFourCodexAgents";
const ENABLE_PET_AUTO_WAKE_COMMAND = "codexHud.enablePetAutoWake";
const DISABLE_PET_AUTO_WAKE_COMMAND = "codexHud.disablePetAutoWake";
const REPAIR_PET_AUTO_WAKE_COMMAND = "codexHud.repairPetAutoWake";
const REFRESH_USAGE_COMMAND = "codexHud.refreshUsage";
const PET_OPEN_CODEX_URI_PATH = "/open-codex";
const PET_SWITCH_URI_PATH = "/switch-pet";
const VIEW_FOCUS_COMMAND = "codexHud.dashboard.focus";
const PANEL_CONTAINER_COMMAND = "workbench.view.extension.codexHudPanel";
const CODEX_NEW_AGENT_COMMAND = "chatgpt.newCodexPanel";
const QUICK_LAUNCH_VIEW_ID = "codexHud.quickLauncher";
const MINUTES_IN_WEEK = 7 * 24 * 60;

function activate(context) {
  const activatedAt = Date.now();
  const statusBar = createStatusBarGroup();
  Object.values(statusBar).forEach((item) => {
    item.command = OPEN_PANEL_COMMAND;
    context.subscriptions.push(item);
  });

  // Claude Code status bar items (left side, 3 colored items + 2 separators)
  const ccContextBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10.2);
  const ccSep1       = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10.1);
  const ccSessionBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10.0);
  const ccSep2       = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 9.9);
  const ccWeeklyBar  = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 9.8);
  [ccContextBar, ccSep1, ccSessionBar, ccSep2, ccWeeklyBar].forEach(b => context.subscriptions.push(b));
  ccContextBar.command = "codexHud.refreshFromClipboard";
  ccSessionBar.command = "codexHud.refreshFromClipboard";
  ccWeeklyBar.command  = "codexHud.refreshFromClipboard";
  ccSep1.text = "│"; ccSep1.color = "#555555";
  ccSep2.text = "│"; ccSep2.color = "#555555";
  let ccRefreshTimer = undefined;
  let jsonlWatcher = null;

  // Cache for data pasted from /usage output (accurate, zero token cost)
  const ccTerminalCache = { sessionUsedPercent: null, weeklyUsedPercent: null, capturedAt: 0 };

  const store = new CodexHudStore(context);
  const provider = new CodexHudViewProvider(context.extensionUri, store, refreshAll);
  const quickLaunchProvider = new CodexQuickLaunchProvider();
  const quickLaunchView = vscode.window.createTreeView(QUICK_LAUNCH_VIEW_ID, {
    treeDataProvider: quickLaunchProvider,
    showCollapseAll: false
  });
  let refreshTimer = undefined;
  let petNotificationTimer = undefined;
  let petAutoWakeWarningShown = false;
  const petNotificationOffsets = new Map();
  const petNotificationFileStates = new Map();

  context.subscriptions.push(
    quickLaunchView,
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
    vscode.commands.registerCommand(QUICK_OPEN_CODEX_AGENT_COMMAND, async () => {
      await openCodexAgents(1);
    }),
    vscode.commands.registerCommand(OPEN_THREE_CODEX_AGENTS_COMMAND, async () => {
      await openCodexAgents(3);
    }),
    vscode.commands.registerCommand(OPEN_FOUR_CODEX_AGENTS_COMMAND, async () => {
      await openCodexAgents(4);
    }),
    vscode.commands.registerCommand(ENABLE_PET_AUTO_WAKE_COMMAND, async () => {
      await runPetAutoWakeCommand("enable");
    }),
    vscode.commands.registerCommand(DISABLE_PET_AUTO_WAKE_COMMAND, async () => {
      await runPetAutoWakeCommand("disable");
    }),
    vscode.commands.registerCommand(REPAIR_PET_AUTO_WAKE_COMMAND, async () => {
      await runPetAutoWakeCommand("repair");
    }),
    vscode.commands.registerCommand(REFRESH_USAGE_COMMAND, async () => {
      await store.refreshAutoUsage();
      refreshAll();
      vscode.window.showInformationMessage("Codex HUD usage refreshed from the latest Codex rollout.");
    }),
    vscode.window.registerUriHandler({
      async handleUri(uri) {
        if (uri.path === PET_OPEN_CODEX_URI_PATH) {
          const focused = await focusExistingCodexTab();
          if (!focused) {
            await openCodexAgents(1);
          }
          return;
        }

        if (uri.path === PET_SWITCH_URI_PATH) {
          await switchPetFromUri(uri);
        }
      }
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
    quickLaunchView.onDidChangeVisibility(async (event) => {
      if (!event.visible) {
        quickLaunchProvider.resetCurrentReveal();
        return;
      }

      if (!shouldAutoLaunch({
        visible: event.visible,
        launchConsumedForCurrentReveal: quickLaunchProvider.launchConsumedForCurrentReveal,
        now: Date.now(),
        activatedAt
      })) {
        return;
      }

      quickLaunchProvider.markCurrentRevealConsumed();
      const launched = await openCodexAgents(1);
      if (!launched) {
        quickLaunchProvider.resetCurrentReveal();
      }
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("codexHud")) {
        void store.refreshAutoUsage();
        resetUsageRefreshTimer();
        refreshAll();
        void refreshClaudeCodeBars();
        resetClaudeCodeRefreshTimer();
        resetJSONLWatcher();
      }

      if (event.affectsConfiguration("codexHud.petAutoWake")) {
        void repairPetAutoWakeIfEnabled({ quiet: true });
        resetPetNotificationMonitor();
      }
    })
  );

  // Clipboard command: user runs /usage in terminal, copies the output, then clicks CC bar
  context.subscriptions.push(
    vscode.commands.registerCommand("codexHud.refreshFromClipboard", async () => {
      const text = await vscode.env.clipboard.readText();
      const sessionMatch = text.match(/Current session[:\s]+(\d+(?:\.\d+)?)%\s+used/i);
      const weekMatch = text.match(/Current week[^:]*[:\s]+(\d+(?:\.\d+)?)%\s+used/i);
      if (sessionMatch && weekMatch) {
        ccTerminalCache.sessionUsedPercent = parseFloat(sessionMatch[1]);
        ccTerminalCache.weeklyUsedPercent = parseFloat(weekMatch[1]);
        ccTerminalCache.capturedAt = Date.now();
        void refreshClaudeCodeBars();
        vscode.window.showInformationMessage("CC usage updated from /usage output.");
      } else {
        vscode.window.showWarningMessage("No /usage data found in clipboard. Run /usage in Claude Code terminal, copy the output, then click the CC bar.");
      }
    })
  );

  context.subscriptions.push({
    dispose: () => {
      if (refreshTimer) {
        clearInterval(refreshTimer);
      }
      if (petNotificationTimer) {
        clearInterval(petNotificationTimer);
      }
      if (ccRefreshTimer) {
        clearInterval(ccRefreshTimer);
      }
      if (jsonlWatcher) {
        jsonlWatcher.close();
        jsonlWatcher = null;
      }
    }
  });

  void initialize();
  void maybeShowInstallPrompt(context);

  async function initialize() {
    await store.refreshAutoUsage();
    await repairPetAutoWakeIfEnabled({ quiet: true });
    resetUsageRefreshTimer();
    resetPetNotificationMonitor();
    refreshAll();
    void refreshClaudeCodeBars();
    resetClaudeCodeRefreshTimer();
    resetJSONLWatcher();
  }

  async function refreshClaudeCodeBars() {
    const config = vscode.workspace.getConfiguration("codexHud");
    if (!config.get("claudeCode.enabled", true)) {
      ccContextBar.hide(); ccSep1.hide(); ccSessionBar.hide(); ccSep2.hide(); ccWeeklyBar.hide();
      return;
    }

    try {
      const ccHomePath = expandHomeDirectory(config.get("claudeCode.homePath", "~/.claude"));
      const sessionLimit = nonNegativeNumber(config.get("claudeCode.sessionTokenLimit", 8000000)) || 8000000;
      const contextWindow = nonNegativeNumber(config.get("claudeCode.contextWindowTokens", 200000)) || 200000;
      const weeklyLimit = nonNegativeNumber(config.get("claudeCode.weeklyTokenLimit", 50000000)) || 50000000;
      const usage = await readLatestClaudeCodeUsage(ccHomePath, sessionLimit, contextWindow, weeklyLimit);
      const ctxRemaining = clampNumber(100 - (usage.currentContextTokens / contextWindow) * 100, 0, 100);

      // Use clipboard /usage data for S+W when fresh (< 10 min), else fall back to JSONL estimate
      const terminalFresh = ccTerminalCache.capturedAt > 0 && (Date.now() - ccTerminalCache.capturedAt) < 10 * 60 * 1000;
      const sessRemaining = terminalFresh
        ? clampNumber(100 - ccTerminalCache.sessionUsedPercent, 0, 100)
        : clampNumber(100 - usage.session.usedPercent, 0, 100);
      const weekRemaining = terminalFresh
        ? clampNumber(100 - ccTerminalCache.weeklyUsedPercent, 0, 100)
        : clampNumber(100 - usage.weekly.usedPercent, 0, 100);

      const ctxSeverity  = severityForPercent(100 - ctxRemaining, 75);
      const sessSeverity = severityForPercent(100 - sessRemaining, 90);
      const weekSeverity = severityForPercent(100 - weekRemaining, 80);

      const ctxMeter  = formatStatusMeter(ctxRemaining, ctxSeverity);
      const sessMeter = formatStatusMeter(sessRemaining, sessSeverity);
      const weekMeter = formatStatusMeter(weekRemaining, weekSeverity);

      const sourceLabel = terminalFresh ? "from /usage" : "estimated";
      const sharedTooltip = [
        `Claude Code usage (S+W: ${sourceLabel})`,
        `Context: ${usage.currentContextTokens.toLocaleString()} / ${contextWindow.toLocaleString()} tokens (${Math.round(ctxRemaining)}% left)`,
        `Session 5h: ${Math.round(sessRemaining)}% left`,
        `Weekly: ${Math.round(weekRemaining)}% left`,
        terminalFresh
          ? `  ↑ from /usage at ${new Date(ccTerminalCache.capturedAt).toLocaleTimeString()}`
          : `  ↑ estimated — click to paste /usage output for accurate data`
      ].join("\n");

      ccContextBar.text    = `C:${ctxMeter} ${Math.round(ctxRemaining)}%`;
      ccContextBar.color   = themeColorForMetric(ctxSeverity, "charts.blue");
      ccContextBar.tooltip = sharedTooltip;

      ccSessionBar.text    = `S:${sessMeter} ${Math.round(sessRemaining)}%`;
      ccSessionBar.color   = themeColorForMetric(sessSeverity, "charts.green");
      ccSessionBar.tooltip = sharedTooltip;

      ccWeeklyBar.text    = `W:${weekMeter} ${Math.round(weekRemaining)}%`;
      ccWeeklyBar.color   = themeColorForMetric(weekSeverity, "charts.purple");
      ccWeeklyBar.tooltip = sharedTooltip;

      ccContextBar.show(); ccSep1.show(); ccSessionBar.show(); ccSep2.show(); ccWeeklyBar.show();
    } catch {
      ccContextBar.hide(); ccSep1.hide(); ccSessionBar.hide(); ccSep2.hide(); ccWeeklyBar.hide();
    }
  }

  function resetClaudeCodeRefreshTimer() {
    if (ccRefreshTimer) {
      clearInterval(ccRefreshTimer);
      ccRefreshTimer = undefined;
    }

    const config = vscode.workspace.getConfiguration("codexHud");
    if (!config.get("claudeCode.enabled", true)) {
      return;
    }

    const refreshSeconds = clampNumber(
      config.get("rolloutRefreshSeconds", 30),
      10,
      3600
    );

    ccRefreshTimer = setInterval(() => {
      void refreshClaudeCodeBars();
    }, refreshSeconds * 1000);
  }

  function startJSONLWatcher() {
    const config = vscode.workspace.getConfiguration("codexHud");
    if (!config.get("claudeCode.enabled", true)) return null;
    const ccHomePath = expandHomeDirectory(config.get("claudeCode.homePath", "~/.claude"));
    const projectsPath = path.join(ccHomePath, "projects");
    let debounce;
    try {
      const watcher = fs.watch(projectsPath, { recursive: true }, (_, filename) => {
        if (filename && filename.endsWith(".jsonl")) {
          clearTimeout(debounce);
          debounce = setTimeout(() => void refreshClaudeCodeBars(), 800);
        }
      });
      return watcher;
    } catch {
      return null;
    }
  }

  function resetJSONLWatcher() {
    if (jsonlWatcher) { jsonlWatcher.close(); jsonlWatcher = null; }
    jsonlWatcher = startJSONLWatcher();
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

  function resetPetNotificationMonitor() {
    if (petNotificationTimer) {
      clearInterval(petNotificationTimer);
      petNotificationTimer = undefined;
    }

    const config = vscode.workspace.getConfiguration("codexHud");
    if (!config.get("petAutoWake.enabled", false) || !config.get("petAutoWake.desktopPet.enabled", true)) {
      return;
    }

    petNotificationTimer = setInterval(() => {
      void pollCodexPetNotifications();
    }, 3000);
    void pollCodexPetNotifications();
  }

  async function pollCodexPetNotifications() {
    const config = vscode.workspace.getConfiguration("codexHud");
    if (!config.get("petAutoWake.enabled", false) || !config.get("petAutoWake.desktopPet.enabled", true)) {
      return;
    }

    const codexHomePath = expandHomePath(config.get("codexHomePath", "~/.codex"));
    const sessionsPath = path.join(codexHomePath, "sessions");
    let files;
    try {
      files = await findJsonlFiles(sessionsPath);
    } catch {
      return;
    }

    const nowMs = Date.now();
    for (const filePath of files) {
      let stat;
      try {
        stat = await fsp.stat(filePath);
      } catch {
        continue;
      }

      let offset = petNotificationOffsets.get(filePath);
      if (offset === undefined && stat.mtimeMs < nowMs - 10_000) {
        petNotificationOffsets.set(filePath, stat.size);
        continue;
      }

      offset = offset ?? 0;
      if (stat.size <= offset) {
        continue;
      }

      try {
        const handle = await fsp.open(filePath, "r");
        const length = stat.size - offset;
        const buffer = Buffer.alloc(length);
        await handle.read(buffer, 0, length, offset);
        await handle.close();
        petNotificationOffsets.set(filePath, stat.size);

        const state = petNotificationFileStates.get(filePath) || {};
        petNotificationFileStates.set(filePath, state);
        for (const line of buffer.toString("utf8").split(/\r?\n/)) {
          if (!line.trim()) {
            continue;
          }
          const event = createNotificationEventFromCodexEvent(JSON.parse(line), state, {
            fileKey: filePath,
            nowMs
          });
          if (event) {
            await appendPetEvent(codexHomePath, event);
          }
        }
      } catch {
        petNotificationOffsets.set(filePath, stat.size);
      }
    }
  }

  function refreshAll() {
    const snapshot = store.getSnapshot();
    renderStatusBar(statusBar, snapshot);
    provider.refresh(snapshot);
  }

  async function openCodexAgents(count) {
    await repairPetAutoWakeIfEnabled({ quiet: true });

    const availableCommands = await vscode.commands.getCommands(true);
    if (!availableCommands.includes(CODEX_NEW_AGENT_COMMAND)) {
      vscode.window.showErrorMessage("Codex quick launcher could not find the OpenAI Codex command.");
      return false;
    }

    const targetCount = Math.max(1, Math.floor(Number(count) || 1));

    for (let index = 0; index < targetCount; index += 1) {
      try {
        await vscode.commands.executeCommand(
          "vscode.openWith",
          createCodexPanelUri(),
          CODEX_CUSTOM_EDITOR_VIEW_TYPE,
          {
            viewColumn: vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.Active,
            preserveFocus: false,
            preview: false
          }
        );
      } catch (error) {
        vscode.window.showErrorMessage(
          `Failed to open Codex Agent ${index + 1} of ${targetCount}: ${formatLaunchErrorMessage(error)}`
        );
        return false;
      }
    }

    const focusCommand = choosePostLaunchFocusCommand(availableCommands);
    if (focusCommand) {
      try {
        await vscode.commands.executeCommand(focusCommand);
      } catch (error) {
        vscode.window.showWarningMessage(
          `Opened ${targetCount} Codex Agent${targetCount === 1 ? "" : "s"}, but could not switch away from Codex+: ${formatLaunchErrorMessage(error)}`
        );
      }
    }

    return true;
  }

  function createCodexPanelUri() {
    return vscode.Uri.file(CODEX_PANEL_ROUTE_PATH).with({
      scheme: CODEX_PANEL_SCHEME,
      authority: CODEX_PANEL_AUTHORITY,
      query: createCodexPanelQuery(createId())
    });
  }

  async function focusExistingCodexTab() {
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (
          tab.input instanceof vscode.TabInputCustom &&
          tab.input.viewType === CODEX_CUSTOM_EDITOR_VIEW_TYPE
        ) {
          try {
            await vscode.commands.executeCommand(
              "vscode.openWith",
              tab.input.uri,
              CODEX_CUSTOM_EDITOR_VIEW_TYPE,
              { viewColumn: group.viewColumn, preserveFocus: false, preview: false }
            );
            return true;
          } catch {
            return false;
          }
        }
      }
    }
    return false;
  }

  async function repairPetAutoWakeIfEnabled({ quiet } = { quiet: true }) {
    const config = vscode.workspace.getConfiguration("codexHud");
    if (!config.get("petAutoWake.enabled", false)) {
      return false;
    }

    try {
      await enablePetAutoWake(getPetAutoWakeOptions());
      await startDesktopPetIfEnabled();
      return true;
    } catch (error) {
      if (!quiet || !petAutoWakeWarningShown) {
        petAutoWakeWarningShown = true;
        vscode.window.showWarningMessage(`Codex pet auto wake could not be repaired: ${formatLaunchErrorMessage(error)}`);
      }
      return false;
    }
  }

  async function runPetAutoWakeCommand(action) {
    const config = vscode.workspace.getConfiguration("codexHud");
    try {
      if (action === "disable") {
        const result = await disablePetAutoWake(getPetAutoWakeOptions());
        await stopDesktopPet(getDesktopPetOptions());
        await config.update("petAutoWake.enabled", false, vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage(
          `Codex pet auto wake disabled${result.changed ? "" : " (already disabled)"}. chatgpt.openOnStartup was not changed.`
        );
        return;
      }

      const result = await enablePetAutoWake(getPetAutoWakeOptions());
      const desktopPet = await startDesktopPetIfEnabled();
      await config.update("petAutoWake.enabled", true, vscode.ConfigurationTarget.Global);
      const verb = action === "repair" ? "repaired" : "enabled";
      const state = result.changed ? "patched" : "already patched";
      const startup = result.openOnStartupChanged ? "chatgpt.openOnStartup enabled." : "chatgpt.openOnStartup already enabled.";
      const desktopState = desktopPet ? "Desktop pet launched." : "Desktop pet launch is disabled.";
      vscode.window.showInformationMessage(
        `Codex pet auto wake ${verb}: ${result.petId} is ${state}. ${startup} ${desktopState}`
      );
    } catch (error) {
      vscode.window.showErrorMessage(`Codex pet auto wake failed: ${formatLaunchErrorMessage(error)}`);
    }
  }

  function getPetAutoWakeOptions() {
    const config = vscode.workspace.getConfiguration("codexHud");
    return {
      vscodeApi: vscode,
      codexHomePath: config.get("codexHomePath", "~/.codex"),
      petSlug: config.get("petAutoWake.petSlug", DEFAULT_PET_SLUG),
      petId: config.get("petAutoWake.petId", DEFAULT_PET_ID),
      webviewOverlayEnabled: config.get("petAutoWake.webviewOverlay.enabled", false)
    };
  }

  async function startDesktopPetIfEnabled() {
    const config = vscode.workspace.getConfiguration("codexHud");
    if (!config.get("petAutoWake.desktopPet.enabled", true)) {
      return null;
    }

    return startDesktopPet(getDesktopPetOptions());
  }

  function getDesktopPetOptions() {
    const config = vscode.workspace.getConfiguration("codexHud");
    return {
      extensionPath: context.extensionPath,
      codexHomePath: config.get("codexHomePath", "~/.codex"),
      petSlug: config.get("petAutoWake.petSlug", DEFAULT_PET_SLUG),
      codexUri: createPetOpenCodexUri(),
      switchPetUriPrefix: createPetSwitchUriPrefix(),
      notificationMode: config.get("petAutoWake.notificationMode", "critical"),
      petSize: config.get("petAutoWake.desktopPet.size", 160)
    };
  }

  function createPetOpenCodexUri() {
    const extensionId = context.extension?.id || "local.codex-hud";
    return vscode.Uri.from({
      scheme: vscode.env.uriScheme || "vscode",
      authority: extensionId,
      path: PET_OPEN_CODEX_URI_PATH
    }).toString();
  }

  function createPetSwitchUriPrefix() {
    const extensionId = context.extension?.id || "local.codex-hud";
    return vscode.Uri.from({
      scheme: vscode.env.uriScheme || "vscode",
      authority: extensionId,
      path: PET_SWITCH_URI_PATH,
      query: "slug="
    }).toString();
  }

  async function switchPetFromUri(uri) {
    const params = new URLSearchParams(uri.query || "");
    const petSlug = normalizePetSlugForConfig(params.get("slug"));
    if (!petSlug) {
      vscode.window.showWarningMessage("Codex pet switch ignored: missing or invalid pet slug.");
      return;
    }

    const config = vscode.workspace.getConfiguration("codexHud");
    await Promise.all([
      config.update("petAutoWake.petSlug", petSlug, vscode.ConfigurationTarget.Global),
      config.update("petAutoWake.petId", `custom:${petSlug}`, vscode.ConfigurationTarget.Global)
    ]);
    vscode.window.showInformationMessage(`Codex pet switched to ${petSlug}.`);
  }
}

function deactivate() {}

async function findJsonlFiles(rootPath) {
  const entries = await fsp.readdir(rootPath, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(rootPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...await findJsonlFiles(entryPath));
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(entryPath);
    }
  }
  return files;
}

function expandHomePath(targetPath) {
  if (!targetPath || targetPath === "~") {
    return os.homedir();
  }
  if (targetPath.startsWith("~/")) {
    return path.join(os.homedir(), targetPath.slice(2));
  }
  return targetPath;
}

function normalizePetSlugForConfig(value) {
  const rawValue = String(value || "").trim();
  const withoutCustomPrefix = rawValue.startsWith("custom:") ? rawValue.slice("custom:".length) : rawValue;
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(withoutCustomPrefix)) {
    return "";
  }
  return withoutCustomPrefix;
}

function createStatusBarGroup() {
  return {
    pulse: vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 102),
    context: vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 101),
    session: vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100),
    week: vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99)
  };
}

class CodexQuickLaunchProvider {
  constructor() {
    this.launchConsumedForCurrentReveal = false;
  }

  getTreeItem(element) {
    return element;
  }

  getChildren() {
    return [
      createQuickLaunchItem({
        label: "Open new Codex tab",
        tooltip: "Open one new Codex Agent editor tab.",
        command: QUICK_OPEN_CODEX_AGENT_COMMAND,
        title: "Open new Codex tab"
      }),
      createQuickLaunchItem({
        label: "Open 3 Codex tabs",
        tooltip: "Open three independent Codex Agent editor tabs.",
        command: OPEN_THREE_CODEX_AGENTS_COMMAND,
        title: "Open 3 Codex tabs"
      }),
      createQuickLaunchItem({
        label: "Open 4 Codex tabs",
        tooltip: "Open four independent Codex Agent editor tabs.",
        command: OPEN_FOUR_CODEX_AGENTS_COMMAND,
        title: "Open 4 Codex tabs"
      })
    ];
  }

  markCurrentRevealConsumed() {
    this.launchConsumedForCurrentReveal = true;
  }

  resetCurrentReveal() {
    this.launchConsumedForCurrentReveal = false;
  }
}

function createQuickLaunchItem({ label, tooltip, command, title }) {
  const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
  item.tooltip = tooltip;
  item.command = {
    command,
    title
  };
  item.iconPath = new vscode.ThemeIcon("add");
  return item;
}

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
    const contextUsedTokens = Math.max(0, autoUsage?.currentContextTokens ?? (contextBaseTokens + totalManagedTokens));
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
          mode: autoUsage ? (autoUsage.planType === "claude-code" ? "claude-code" : "codex-rollout") : "manual",
          description: autoUsage
            ? (autoUsage.planType === "claude-code"
                ? `Claude Code · ${path.basename(autoUsage.filePath)}`
                : `Auto-synced from ${path.basename(autoUsage.filePath)}`)
            : "Manual values from Codex HUD settings",
          lastSyncedAt: autoUsage?.syncedAt ?? null,
          planType: autoUsage?.planType ?? null,
          filePath: autoUsage?.filePath ?? null,
          currentContextTokens: autoUsage?.currentContextTokens ?? null,
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
  await tryCommand("workbench.action.setPanelAlignmentRight");
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
  const sessionBar = formatStatusMeter(snapshot.usage.session.remainingPercent, snapshot.usage.session.status);
  const weekBar = formatStatusMeter(snapshot.usage.weekly.remainingPercent, snapshot.usage.weekly.status);
  const contextBar = formatStatusMeter(snapshot.contextWindow.remainingPercent, snapshot.contextWindow.status);
  const tooltip = buildStatusTooltip(snapshot);

  statusBar.pulse.text = "$(pulse)";
  statusBar.pulse.tooltip = tooltip;
  statusBar.context.text = `C:${contextBar} ${context}`;
  statusBar.context.tooltip = tooltip;
  statusBar.context.color = themeColorForStatus(snapshot.contextWindow.status);
  statusBar.session.text = `S:${sessionBar} ${session}`;
  statusBar.session.tooltip = tooltip;
  statusBar.session.color = themeColorForStatus(snapshot.usage.session.status);
  statusBar.week.text = `W:${weekBar} ${week}`;
  statusBar.week.tooltip = tooltip;
  statusBar.week.color = themeColorForStatus(snapshot.usage.weekly.status);

  const hasDanger =
    snapshot.usage.session.status === "danger" ||
    snapshot.usage.weekly.status === "danger" ||
    snapshot.contextWindow.status === "danger";
  const hasWarn =
    snapshot.usage.session.status === "warn" ||
    snapshot.usage.weekly.status === "warn" ||
    snapshot.contextWindow.status === "warn";

  const backgroundColor = hasDanger
    ? new vscode.ThemeColor("statusBarItem.errorBackground")
    : hasWarn
      ? new vscode.ThemeColor("statusBarItem.warningBackground")
      : undefined;

  Object.values(statusBar).forEach((item) => {
    item.backgroundColor = backgroundColor;
    item.show();
  });
}

function formatStatusMeter(value, status) {
  const percent = clampNumber(Math.round(Number(value) || 0), 0, 100);
  const slots = 5;
  const filled = Math.round((percent / 100) * slots);
  const palette = meterPaletteForStatus(status);
  return `${palette.filled.repeat(filled)}${palette.empty.repeat(slots - filled)}`;
}

function meterPaletteForStatus(status) {
  switch (status) {
    case "danger":
      return { filled: "●", empty: "○" };
    case "warn":
      return { filled: "●", empty: "○" };
    default:
      return { filled: "●", empty: "○" };
  }
}

function themeColorForStatus(status) {
  switch (status) {
    case "danger":
      return new vscode.ThemeColor("charts.red");
    case "warn":
      return new vscode.ThemeColor("charts.yellow");
    default:
      return new vscode.ThemeColor("charts.green");
  }
}

function themeColorForMetric(status, okThemeColor) {
  if (status === "danger") return new vscode.ThemeColor("charts.red");
  if (status === "warn") return new vscode.ThemeColor("charts.yellow");
  return new vscode.ThemeColor(okThemeColor);
}

function buildStatusTooltip(snapshot) {
  const session = `${Math.round(snapshot.usage.session.remainingPercent)}%`;
  const week = `${Math.round(snapshot.usage.weekly.remainingPercent)}%`;
  return [
    "Codex HUD",
    `Context remaining: ${snapshot.contextWindow.remainingTokens}/${snapshot.contextWindow.limitTokens} tokens`,
    `Session remaining: ${session}${snapshot.usage.session.resetAt ? ` · resets ${snapshot.usage.session.resetAt}` : ""}`,
    `Week remaining: ${week}${snapshot.usage.weekly.resetAt ? ` · resets ${snapshot.usage.weekly.resetAt}` : ""}`,
    `Background items: ${snapshot.context.totalItems}`,
    snapshot.usage.source.description
  ].join("\n");
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
      currentContextTokens: nonNegativeNumber(usageInfo.last_token_usage?.input_tokens ?? 0),
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

// ── Claude Code data source ────────────────────────────────────────────────

async function findLatestClaudeProjectJsonl(projectsPath, limit) {
  const candidates = [];
  const projectDirs = await readDirectoryEntries(projectsPath);

  for (const projectDir of projectDirs) {
    if (!projectDir.isDirectory()) {
      continue;
    }

    const projectPath = path.join(projectsPath, projectDir.name);
    const files = await readDirectoryEntries(projectPath);
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith(".jsonl")) {
        continue;
      }

      const filePath = path.join(projectPath, file.name);
      try {
        const stat = await fsp.stat(filePath);
        candidates.push({ filePath, mtimeMs: stat.mtimeMs });
      } catch (error) {
        console.error(error);
      }
    }
  }

  return candidates
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(0, limit)
    .map((entry) => entry.filePath);
}

async function extractLatestContextFromClaudeJsonl(filePath) {
  let raw;
  try {
    raw = await fsp.readFile(filePath, "utf8");
  } catch {
    return null;
  }

  const lines = raw.split(/\r?\n/);
  const seenIds = new Set();

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

    if (event?.type !== "assistant") {
      continue;
    }

    const msg = event.message;
    if (!msg) {
      continue;
    }

    const msgId = msg.id;
    if (!msgId || seenIds.has(msgId)) {
      continue;
    }

    seenIds.add(msgId);

    const usage = msg.usage;
    if (!usage || !("input_tokens" in usage)) {
      continue;
    }

    const totalContext =
      nonNegativeNumber(usage.input_tokens || 0) +
      nonNegativeNumber(usage.cache_creation_input_tokens || 0) +
      nonNegativeNumber(usage.cache_read_input_tokens || 0);

    if (totalContext > 0) {
      return { contextTokens: totalContext, filePath };
    }
  }

  return null;
}

async function calculateClaudeCodeSessionUsedPercent(projectsPath, sessionTokenLimit) {
  const fiveHoursAgoMs = Date.now() - 5 * 60 * 60 * 1000;
  const projectDirs = await readDirectoryEntries(projectsPath);
  const seenMsgIds = new Set();
  let totalSessionTokens = 0;

  for (const projectDir of projectDirs) {
    if (!projectDir.isDirectory()) {
      continue;
    }

    const projectPath = path.join(projectsPath, projectDir.name);
    const files = await readDirectoryEntries(projectPath);

    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith(".jsonl")) {
        continue;
      }

      const filePath = path.join(projectPath, file.name);
      try {
        const stat = await fsp.stat(filePath);
        if (stat.mtimeMs < fiveHoursAgoMs) {
          continue;
        }

        const raw = await fsp.readFile(filePath, "utf8");
        for (const line of raw.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (!trimmed) {
            continue;
          }

          let event;
          try {
            event = JSON.parse(trimmed);
          } catch {
            continue;
          }

          if (event?.type !== "assistant") {
            continue;
          }

          const msg = event.message;
          if (!msg?.id || !msg?.usage) {
            continue;
          }

          if (seenMsgIds.has(msg.id)) {
            continue;
          }

          seenMsgIds.add(msg.id);

          const { output_tokens = 0, input_tokens = 0, cache_creation_input_tokens = 0 } = msg.usage;
          totalSessionTokens += output_tokens + input_tokens + cache_creation_input_tokens;
        }
      } catch (error) {
        console.error(error);
      }
    }
  }

  return clampNumber((totalSessionTokens / Math.max(1, sessionTokenLimit)) * 100, 0, 100);
}

function getMostRecentThursdayResetMs() {
  // Anthropic weekly resets every Thursday 10:00am Asia/Shanghai (UTC+8 = 02:00 UTC)
  const now = Date.now();
  const utc8Now = new Date(now + 8 * 3600 * 1000);
  const dayOfWeek = utc8Now.getUTCDay(); // 0=Sun, 4=Thu
  const daysSinceThursday = (dayOfWeek + 3) % 7; // 0 on Thu, 1 on Fri, ..., 6 on Wed
  const resetUtc8 = new Date(utc8Now);
  resetUtc8.setUTCDate(utc8Now.getUTCDate() - daysSinceThursday);
  resetUtc8.setUTCHours(10, 0, 0, 0); // 10:00am UTC+8
  const resetMs = resetUtc8.getTime() - 8 * 3600 * 1000; // back to UTC ms
  // If reset time is in the future (shouldn't happen but guard), go back 7 days
  return resetMs > now ? resetMs - 7 * 24 * 3600 * 1000 : resetMs;
}

async function calculateClaudeCodeWeeklyUsedPercent(projectsPath, weeklyTokenLimit) {
  const weekStartMs = getMostRecentThursdayResetMs();
  const projectDirs = await readDirectoryEntries(projectsPath);
  const seenMsgIds = new Set();
  let totalWeeklyTokens = 0;

  for (const projectDir of projectDirs) {
    if (!projectDir.isDirectory()) {
      continue;
    }

    const projectPath = path.join(projectsPath, projectDir.name);
    const files = await readDirectoryEntries(projectPath);

    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith(".jsonl")) {
        continue;
      }

      const filePath = path.join(projectPath, file.name);
      try {
        const stat = await fsp.stat(filePath);
        if (stat.mtimeMs < weekStartMs) {
          continue;
        }

        const raw = await fsp.readFile(filePath, "utf8");
        for (const line of raw.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (!trimmed) {
            continue;
          }

          let event;
          try {
            event = JSON.parse(trimmed);
          } catch {
            continue;
          }

          if (event?.type !== "assistant") {
            continue;
          }

          const msg = event.message;
          if (!msg?.id || !msg?.usage) {
            continue;
          }

          if (seenMsgIds.has(msg.id)) {
            continue;
          }

          seenMsgIds.add(msg.id);

          const { output_tokens = 0, input_tokens = 0, cache_creation_input_tokens = 0 } = msg.usage;
          totalWeeklyTokens += output_tokens + input_tokens + cache_creation_input_tokens;
        }
      } catch (error) {
        console.error(error);
      }
    }
  }

  return clampNumber((totalWeeklyTokens / Math.max(1, weeklyTokenLimit)) * 100, 0, 100);
}

async function readLatestClaudeCodeUsage(claudeHomePath, sessionTokenLimit, contextWindowTokens, weeklyTokenLimit) {
  const projectsPath = path.join(claudeHomePath, "projects");

  const latestFiles = await findLatestClaudeProjectJsonl(projectsPath, 6);
  if (!latestFiles.length) {
    throw new Error(`No Claude Code project JSONL files found in ${projectsPath}`);
  }

  let contextResult = null;
  for (const filePath of latestFiles) {
    contextResult = await extractLatestContextFromClaudeJsonl(filePath);
    if (contextResult) {
      break;
    }
  }

  if (!contextResult) {
    throw new Error(`No Claude Code usage data found in ${projectsPath}`);
  }

  const [sessionUsedPercent, weeklyUsedPercent] = await Promise.all([
    calculateClaudeCodeSessionUsedPercent(projectsPath, sessionTokenLimit),
    calculateClaudeCodeWeeklyUsedPercent(projectsPath, weeklyTokenLimit || sessionTokenLimit * 7)
  ]);

  return {
    syncedAt: new Date().toISOString(),
    filePath: contextResult.filePath,
    planType: "claude-code",
    session: {
      usedPercent: sessionUsedPercent,
      resetAt: null,
      resetAtLabel: "5h window (estimated)"
    },
    weekly: {
      usedPercent: weeklyUsedPercent,
      resetAt: null,
      resetAtLabel: "7 days (estimated)"
    },
    currentContextTokens: contextResult.contextTokens,
    threadTotalTokens: 0,
    modelContextWindow: contextWindowTokens
  };
}

// ── end Claude Code ────────────────────────────────────────────────────────

module.exports = {
  activate,
  deactivate
};
