const AUTO_LAUNCH_SUPPRESSION_MS = 4000;
const CODEX_CUSTOM_EDITOR_VIEW_TYPE = "chatgpt.conversationEditor";
const CODEX_OPEN_SIDEBAR_COMMAND = "chatgpt.openSidebar";
const CODEX_PANEL_AUTHORITY = "route";
const CODEX_PANEL_ROUTE_PATH = "/extension/panel/new";
const CODEX_PANEL_SCHEME = "openai-codex";
const EXPLORER_VIEW_COMMAND = "workbench.view.explorer";

function shouldAutoLaunch({ visible, launchConsumedForCurrentReveal, now, activatedAt }) {
  if (!visible || launchConsumedForCurrentReveal) {
    return false;
  }

  return now - activatedAt >= AUTO_LAUNCH_SUPPRESSION_MS;
}

function formatLaunchErrorMessage(error) {
  if (typeof error?.message === "string" && error.message.trim()) {
    return error.message.trim();
  }

  if (typeof error === "string" && error.trim()) {
    return error.trim();
  }

  return "Unknown error";
}

function choosePostLaunchFocusCommand(availableCommands) {
  const commandSet = new Set(Array.isArray(availableCommands) ? availableCommands : []);
  if (commandSet.has(CODEX_OPEN_SIDEBAR_COMMAND)) {
    return CODEX_OPEN_SIDEBAR_COMMAND;
  }

  if (commandSet.has(EXPLORER_VIEW_COMMAND)) {
    return EXPLORER_VIEW_COMMAND;
  }

  return undefined;
}

function createCodexPanelQuery(instanceId) {
  return `codexHudInstance=${encodeURIComponent(String(instanceId))}`;
}

module.exports = {
  AUTO_LAUNCH_SUPPRESSION_MS,
  CODEX_CUSTOM_EDITOR_VIEW_TYPE,
  CODEX_PANEL_AUTHORITY,
  CODEX_PANEL_ROUTE_PATH,
  CODEX_PANEL_SCHEME,
  choosePostLaunchFocusCommand,
  createCodexPanelQuery,
  shouldAutoLaunch,
  formatLaunchErrorMessage
};
