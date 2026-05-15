const childProcess = require("child_process");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");

const DEFAULT_DESKTOP_PET_EXECUTABLE = path.join("desktop-pet", "DuoTuanPet");
const DEFAULT_PET_PID_FILE = "duotuan-pet.pid";
const DEFAULT_PET_SLUG = "duotuan";
const DEFAULT_PET_NAME = "多多团团";

async function startDesktopPet(options = {}) {
  const dependencies = getDependencies(options);
  const extensionPath = options.extensionPath;
  if (!extensionPath) {
    throw new Error("Missing extensionPath for desktop pet.");
  }

  const petSlug = normalizePetSlug(options.petSlug);
  const codexHomePath = expandHomeDirectory(options.codexHomePath || "~/.codex", dependencies);
  const executablePath = options.executablePath || dependencies.pathModule.join(extensionPath, DEFAULT_DESKTOP_PET_EXECUTABLE);
  const petPackage = await resolveDefaultPetPackage({
    codexHomePath,
    extensionPath,
    petSlug
  }, dependencies);
  const spritesheetPath = options.spritesheetPath || petPackage.spritesheetPath;
  const petName = String(options.petName || petPackage.metadata.displayName || DEFAULT_PET_NAME);
  const pidFilePath = options.pidFilePath || dependencies.pathModule.join(codexHomePath, DEFAULT_PET_PID_FILE);
  const runningPid = await readRunningPid(pidFilePath, dependencies);

  if (runningPid) {
    return {
      executablePath,
      spritesheetPath,
      petName,
      pid: runningPid,
      alreadyRunning: true
    };
  }

  await dependencies.fsApi.access(executablePath);
  await dependencies.fsApi.access(spritesheetPath);

  const args = [
    "--spritesheet", spritesheetPath,
    "--pet-name", petName,
    "--pet-slug", petSlug,
    "--pid-file", pidFilePath,
    "--codex-home", codexHomePath,
    "--extension-path", extensionPath,
    "--notification-mode", normalizeNotificationMode(options.notificationMode),
    "--pet-size", String(normalizePetSize(options.petSize))
  ];

  if (options.codexUri) {
    args.push("--codex-uri", String(options.codexUri));
  }
  if (options.switchPetUriPrefix) {
    args.push("--switch-pet-uri-prefix", String(options.switchPetUriPrefix));
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
    petName,
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
  const petPackage = await resolveDefaultPetPackage(
    { codexHomePath, extensionPath, petSlug },
    { fsApi, pathModule }
  );
  return petPackage.spritesheetPath;
}

async function resolveDefaultPetPackage({ codexHomePath, extensionPath, petSlug }, { fsApi, pathModule }) {
  const normalizedSlug = normalizePetSlug(petSlug);
  const installedDirectory = pathModule.join(codexHomePath, "pets", normalizedSlug);
  const bundledDirectory = pathModule.join(extensionPath, "pets", normalizedSlug);

  const installedPackage = await readPetPackageAtDirectory(installedDirectory, { fsApi, pathModule });
  if (installedPackage) {
    return installedPackage;
  }

  const bundledPackage = await readPetPackageAtDirectory(bundledDirectory, { fsApi, pathModule });
  if (bundledPackage) {
    return bundledPackage;
  }

  return {
    directory: installedDirectory,
    petJsonPath: pathModule.join(installedDirectory, "pet.json"),
    spritesheetPath: pathModule.join(installedDirectory, "spritesheet.webp"),
    metadata: {
      id: normalizedSlug,
      displayName: normalizedSlug,
      spritesheetPath: "spritesheet.webp"
    }
  };
}

async function readPetPackageAtDirectory(directory, { fsApi, pathModule }) {
  const petJsonPath = pathModule.join(directory, "pet.json");
  let metadata = {};

  try {
    metadata = JSON.parse(await fsApi.readFile(petJsonPath, "utf8"));
  } catch (error) {
    if (!error || error.code !== "ENOENT") {
      throw error;
    }
  }

  const configuredSpritesheetPath = String(metadata.spritesheetPath || "spritesheet.webp");
  const spritesheetPath = pathModule.isAbsolute(configuredSpritesheetPath)
    ? configuredSpritesheetPath
    : pathModule.join(directory, configuredSpritesheetPath);

  if (!(await canAccess(spritesheetPath, fsApi))) {
    return null;
  }

  return {
    directory,
    petJsonPath,
    spritesheetPath,
    metadata
  };
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

function normalizePetSlug(value) {
  const rawValue = String(value || DEFAULT_PET_SLUG).trim();
  const withoutCustomPrefix = rawValue.startsWith("custom:") ? rawValue.slice("custom:".length) : rawValue;
  return withoutCustomPrefix || DEFAULT_PET_SLUG;
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
  DEFAULT_PET_NAME,
  DEFAULT_PET_SLUG,
  normalizeNotificationMode,
  normalizePetSize,
  resolveDefaultPetPackage,
  resolveDefaultSpritesheetPath,
  startDesktopPet,
  stopDesktopPet
};
