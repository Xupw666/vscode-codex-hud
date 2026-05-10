const fsp = require("fs/promises");
const os = require("os");
const path = require("path");

const PET_EVENT_LOG_FILE = "duotuan-pet-events.jsonl";

function createNotificationEventFromCodexEvent(codexEvent, state = {}, options = {}) {
  const payload = codexEvent?.payload;
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const fileKey = options.fileKey || "codex";
  const outerType = String(codexEvent.type || "");
  const payloadType = String(payload.type || "");
  const rawTurnId = cleanText(payload.turn_id);
  if (rawTurnId) {
    state.taskKey = rawTurnId;
  }
  const taskKey = state.taskKey || fileKey;
  const turnId = taskKey;

  if (payloadType === "thread_name_updated") {
    const threadName = cleanText(payload.thread_name);
    if (threadName) {
      state.title = threadName;
    }
    return null;
  }

  if (payloadType === "user_message" && !state.firstMessage) {
    state.firstMessage = truncate(cleanText(payload.message), 28);
    return null;
  }

  const taskTitle = truncate(state.title || state.firstMessage || "Codex 任务", 26);

  if (outerType === "response_item" && payloadLooksLikeNeedsApproval(payload)) {
    return {
      id: `${turnId}:needs-approval:${payload.call_id || ""}`,
      taskKey,
      type: "needs_approval",
      title: `${taskTitle} 需要你同意`,
      body: approvalBodyFromPayload(payload)
    };
  }

  if (payloadType === "task_started") {
    return {
      id: `${turnId}:started`,
      taskKey,
      type: "started",
      title: `${taskTitle} 已开始执行`,
      body: "Codex 正在处理这个任务。"
    };
  }

  if (payloadType === "agent_message") {
    const nowMs = options.nowMs || Date.now();
    if (state.lastProgressAtMs && nowMs - state.lastProgressAtMs < 45_000) {
      return null;
    }
    state.lastProgressAtMs = nowMs;
    return {
      id: `${turnId}:progress:${Math.floor(nowMs / 45_000)}`,
      taskKey,
      type: "progress",
      title: `${taskTitle} 有新进度`,
      body: truncate(cleanText(payload.message) || "Codex 有新的执行进展。", 72)
    };
  }

  if (payloadType === "task_complete") {
    return {
      id: `${turnId}:complete`,
      taskKey,
      type: "completed",
      title: `${taskTitle} 已经完成作业`,
      body: truncate(cleanText(payload.last_agent_message) || "点击打开 Codex 查看结果。", 78)
    };
  }

  return null;
}

async function appendPetEvent(codexHomePath, event, dependencies = {}) {
  const fsApi = dependencies.fsApi || fsp;
  const pathModule = dependencies.pathModule || path;
  const homePath = expandHomeDirectory(codexHomePath || "~/.codex", dependencies);
  const eventPath = pathModule.join(homePath, PET_EVENT_LOG_FILE);
  await fsApi.mkdir(pathModule.dirname(eventPath), { recursive: true });
  await fsApi.appendFile(eventPath, `${JSON.stringify({ ...event, emittedAt: new Date().toISOString() })}\n`, "utf8");
  return eventPath;
}

function payloadLooksLikeNeedsApproval(payload) {
  const payloadType = String(payload.type || "");
  if (payloadType !== "function_call" && payloadType !== "custom_tool_call") {
    return false;
  }

  const source = JSON.stringify(payload);
  return [
    "\"sandbox_permissions\":\"require_escalated\"",
    "request_user_input",
    "requestUserInput",
    "approval_request",
    "permission_request",
    "request_plugin_install"
  ].some((needle) => source.includes(needle));
}

function approvalBodyFromPayload(payload) {
  const args = parseArguments(payload.arguments);
  const justification = cleanText(args?.justification);
  return truncate(justification || "Codex 正在等待你确认，点击打开处理。", 84);
}

function parseArguments(value) {
  if (!value) {
    return null;
  }
  if (typeof value === "object") {
    return value;
  }
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }
  return null;
}

function cleanText(value) {
  return String(value || "")
    .replace(/\r?\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function truncate(value, maxLength) {
  const text = String(value || "");
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function expandHomeDirectory(targetPath, { osModule = os, pathModule = path } = {}) {
  if (!targetPath || targetPath === "~") {
    return osModule.homedir();
  }
  if (targetPath.startsWith("~/")) {
    return pathModule.join(osModule.homedir(), targetPath.slice(2));
  }
  return targetPath;
}

module.exports = {
  PET_EVENT_LOG_FILE,
  appendPetEvent,
  createNotificationEventFromCodexEvent,
  payloadLooksLikeNeedsApproval
};
