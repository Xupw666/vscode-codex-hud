const childProcess = require("child_process");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");

const DEFAULT_DESKTOP_PET_EXECUTABLE = path.join("desktop-pet", "DuoTuanPet");
const DEFAULT_PET_PID_FILE = "duotuan-pet.pid";

async function startDesktopPet(options = {}) {
  const dependencies = getDependencies(options);
  const extensionPath = options.extensionPath;
  if (!extensionPath) {
    throw new Error("Missing extensionPath for desktop pet.");
  }

  const petSlug = String(options.petSlug || "duotuan");
  const codexHomePath = expandHomeDirectory(options.codexHomePath || "~/.codex", dependencies);
  const executablePath = options.executablePath || dependencies.pathModule.join(extensionPath, DEFAULT_DESKTOP_PET_EXECUTABLE);
  const spritesheetPath = options.spritesheetPath || await resolveDefaultSpritesheetPath({
    codexHomePath,
    extensionPath,
    petSlug
  }, dependencies);
  const petName = String(options.petName || "多多团团");
  const pidFilePath = options.pidFilePath || dependencies.pathModule.join(codexHomePath, DEFAULT_PET_PID_FILE);
  const runningPid = await readRunningPid(pidFilePath, dependencies);

  if (runningPid) {
    return {
      executablePath,
      spritesheetPath,
      pid: runningPid,
      alreadyRunning: true
    };
  }

  await dependencies.fsApi.access(executablePath);
  await dependencies.fsApi.access(spritesheetPath);

  const args = [
    "--spritesheet", spritesheetPath,
    "--pet-name", petName,
    "--pid-file", pidFilePath,
    "--codex-home", codexHomePath,
    "--notification-mode", normalizeNotificationMode(options.notificationMode),
    "--pet-size", String(normalizePetSize(options.petSize))
  ];

  if (options.codexUri) {
    args.push("--codex-uri", String(options.codexUri));
  }

  const child = dependencies.childProcessApi.spawn(
    executablePath,
    args,
    {
      detached: true,
      stdio: "ignore"
    }
  );
  child.unref?.();

  return {
    executablePath,
    spritesheetPath,
    pid: child.pid || null,
    alreadyRunning: false
  };
}

async function stopDesktopPet(options = {}) {
  const dependencies = getDependencies(options);
  const codexHomePath = expandHomeDirectory(options.codexHomePath || "~/.codex", dependencies);
  const pidFilePath = options.pidFilePath || dependencies.pathModule.join(codexHomePath, DEFAULT_PET_PID_FILE);

  let pid;
  try {
    pid = Number((await dependencies.fsApi.readFile(pidFilePath, "utf8")).trim());
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }

  if (Number.isInteger(pid) && pid > 0) {
    try {
      process.kill(pid, "SIGTERM");
    } catch (error) {
      if (!error || error.code !== "ESRCH") {
        throw error;
      }
    }
  }

  await dependencies.fsApi.rm(pidFilePath, { force: true });
  return true;
}

async function resolveDefaultSpritesheetPath({ codexHomePath, extensionPath, petSlug }, { fsApi, pathModule }) {
  const installedSpritesheetPath = pathModule.join(codexHomePath, "pets", petSlug, "spritesheet.webp");
  if (await canAccess(installedSpritesheetPath, fsApi)) {
    return installedSpritesheetPath;
  }

  const bundledSpritesheetPath = pathModule.join(extensionPath, "pets", petSlug, "spritesheet.webp");
  if (await canAccess(bundledSpritesheetPath, fsApi)) {
    return bundledSpritesheetPath;
  }

  return installedSpritesheetPath;
}

async function canAccess(filePath, fsApi) {
  try {
    await fsApi.access(filePath);
    return true;
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function normalizeNotificationMode(value) {
  return value === "progress" ? "progress" : "critical";
}

function normalizePetSize(value) {
  const size = Number(value);
  if (!Number.isFinite(size)) {
    return 160;
  }
  return Math.min(280, Math.max(96, Math.round(size)));
}

function expandHomeDirectory(targetPath, { osModule, pathModule } = getDependencies()) {
  if (!targetPath || targetPath === "~") {
    return osModule.homedir();
  }

  if (targetPath.startsWith("~/")) {
    return pathModule.join(osModule.homedir(), targetPath.slice(2));
  }

  return targetPath;
}

async function readRunningPid(pidFilePath, { fsApi, processApi }) {
  let rawPid;
  try {
    rawPid = await fsApi.readFile(pidFilePath, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }

  const pid = Number(String(rawPid).trim());
  if (!Number.isInteger(pid) || pid <= 0) {
    await fsApi.rm(pidFilePath, { force: true });
    return null;
  }

  try {
    processApi.kill(pid, 0);
    return pid;
  } catch (error) {
    if (error && error.code === "ESRCH") {
      await fsApi.rm(pidFilePath, { force: true });
      return null;
    }
    throw error;
  }
}

function getDependencies(options = {}) {
  return {
    childProcessApi: options.childProcessApi || childProcess,
    fsApi: options.fsApi || fsp,
    osModule: options.osModule || os,
    pathModule: options.pathModule || path,
    processApi: options.processApi || process
  };
}

module.exports = {
  DEFAULT_DESKTOP_PET_EXECUTABLE,
  DEFAULT_PET_PID_FILE,
  normalizeNotificationMode,
  normalizePetSize,
  startDesktopPet,
  stopDesktopPet
};
