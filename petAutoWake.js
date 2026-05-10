const fsp = require("fs/promises");
const os = require("os");
const path = require("path");

const DEFAULT_OPENAI_EXTENSION_ID = "openai.chatgpt";
const DEFAULT_PET_SLUG = "duotuan";
const DEFAULT_PET_ID = `custom:${DEFAULT_PET_SLUG}`;
const BACKUP_SUFFIX = ".codex-hud-pet-autowake.bak";
const CODEX_AVATAR_ASSET_PREFIX = "codex-avatar-";
const OVERLAY_OPEN_STATE_ASSET_PREFIX = "avatar-overlay-open-state-signal-";
const WEBVIEW_PET_OVERLAY_SCRIPT_NAME = "codex-hud-pet-overlay.js";

async function enablePetAutoWake(options = {}) {
  const result = await applyPetAutoWakePatch(options);
  const openOnStartupChanged = await setChatgptOpenOnStartup(options.vscodeApi, options.configTarget);

  return {
    ...result,
    openOnStartupChanged
  };
}

async function disablePetAutoWake(options = {}) {
  return removePetAutoWakePatch(options);
}

async function applyPetAutoWakePatch(options = {}) {
  const dependencies = getDependencies(options);
  const petSlug = normalizePetSlug(options.petSlug);
  const petId = normalizePetId(options.petId, petSlug);
  const webviewOverlayEnabled = options.webviewOverlayEnabled !== false;
  const extensionPath = resolveCodexExtensionPath(options);
  const codexHomePath = resolveCodexHomePath(options);
  const petPackage = webviewOverlayEnabled
    ? await readPetPackage({
      ...dependencies,
      codexHomePath,
      petSlug
    })
    : null;
  const avatarAssetPath = await findAssetFile({
    ...dependencies,
    extensionPath,
    prefix: CODEX_AVATAR_ASSET_PREFIX
  });
  const overlayAssetPath = await findAssetFile({
    ...dependencies,
    extensionPath,
    prefix: OVERLAY_OPEN_STATE_ASSET_PREFIX
  });

  const avatar = await patchFile({
    ...dependencies,
    filePath: avatarAssetPath,
    patcher: (source) => webviewOverlayEnabled
      ? patchCodexAvatarSource(source, petId)
      : unpatchCodexAvatarSource(source, petId)
  });
  const overlay = await patchFile({
    ...dependencies,
    filePath: overlayAssetPath,
    patcher: webviewOverlayEnabled ? patchOverlayOpenSource : unpatchOverlayOpenSource
  });
  const webviewOverlay = webviewOverlayEnabled
    ? await installWebviewPetOverlay({
      ...dependencies,
      extensionPath,
      petPackage,
      petSlug
    })
    : await removeWebviewPetOverlay({
      ...dependencies,
      extensionPath
    });

  return {
    petSlug,
    petId,
    webviewOverlayEnabled,
    extensionPath,
    codexHomePath,
    petPackage,
    files: {
      avatar,
      overlay,
      webviewOverlay
    },
    changed: avatar.changed || overlay.changed || webviewOverlay.changed,
    alreadyPatched: avatar.alreadyPatched && overlay.alreadyPatched && webviewOverlay.alreadyPatched
  };
}

async function removePetAutoWakePatch(options = {}) {
  const dependencies = getDependencies(options);
  const petSlug = normalizePetSlug(options.petSlug);
  const petId = normalizePetId(options.petId, petSlug);
  const extensionPath = resolveCodexExtensionPath(options);
  const avatarAssetPath = await findAssetFile({
    ...dependencies,
    extensionPath,
    prefix: CODEX_AVATAR_ASSET_PREFIX
  });
  const overlayAssetPath = await findAssetFile({
    ...dependencies,
    extensionPath,
    prefix: OVERLAY_OPEN_STATE_ASSET_PREFIX
  });

  const avatar = await patchFile({
    ...dependencies,
    filePath: avatarAssetPath,
    patcher: (source) => unpatchCodexAvatarSource(source, petId)
  });
  const overlay = await patchFile({
    ...dependencies,
    filePath: overlayAssetPath,
    patcher: unpatchOverlayOpenSource
  });
  const webviewOverlay = await removeWebviewPetOverlay({
    ...dependencies,
    extensionPath
  });

  return {
    petSlug,
    petId,
    extensionPath,
    files: {
      avatar,
      overlay,
      webviewOverlay
    },
    changed: avatar.changed || overlay.changed || webviewOverlay.changed,
    alreadyPatched: avatar.alreadyPatched && overlay.alreadyPatched && webviewOverlay.alreadyPatched
  };
}

function patchCodexAvatarSource(source, petId = DEFAULT_PET_ID) {
  const targetFallback = `g=\`${petId}\`,_=a(\`selected-avatar-id\`,null)`;
  const defaultFallback = "g=`codex`,_=a(`selected-avatar-id`,null)";

  if (source.includes(targetFallback)) {
    return {
      source,
      changed: false,
      alreadyPatched: true
    };
  }

  if (!source.includes(defaultFallback)) {
    return {
      source,
      changed: false,
      alreadyPatched: false,
      reason: "Could not find the Codex avatar fallback in the OpenAI extension asset."
    };
  }

  return {
    source: source.replace(defaultFallback, targetFallback),
    changed: true,
    alreadyPatched: false
  };
}

function unpatchCodexAvatarSource(source, petId = DEFAULT_PET_ID) {
  const targetFallback = `g=\`${petId}\`,_=a(\`selected-avatar-id\`,null)`;
  const defaultFallback = "g=`codex`,_=a(`selected-avatar-id`,null)";

  if (!source.includes(targetFallback)) {
    return {
      source,
      changed: false,
      alreadyPatched: false
    };
  }

  return {
    source: source.replace(targetFallback, defaultFallback),
    changed: true,
    alreadyPatched: true
  };
}

function patchOverlayOpenSource(source) {
  if (source.includes("=e(t,!0);")) {
    return {
      source,
      changed: false,
      alreadyPatched: true
    };
  }

  if (!source.includes("=e(t,!1);")) {
    return {
      source,
      changed: false,
      alreadyPatched: false,
      reason: "Could not find the pet overlay default-open flag in the OpenAI extension asset."
    };
  }

  return {
    source: source.replace("=e(t,!1);", "=e(t,!0);"),
    changed: true,
    alreadyPatched: false
  };
}

function unpatchOverlayOpenSource(source) {
  if (!source.includes("=e(t,!0);")) {
    return {
      source,
      changed: false,
      alreadyPatched: false
    };
  }

  return {
    source: source.replace("=e(t,!0);", "=e(t,!1);"),
    changed: true,
    alreadyPatched: true
  };
}

async function installWebviewPetOverlay({ extensionPath, petPackage, petSlug, fsApi, pathModule }) {
  const assetsPath = pathModule.join(extensionPath, "webview", "assets");
  const indexPath = pathModule.join(extensionPath, "webview", "index.html");
  const spritesheetAssetName = `codex-hud-${safeAssetName(petSlug)}-spritesheet.webp`;
  const spritesheetAssetPath = pathModule.join(assetsPath, spritesheetAssetName);
  const scriptPath = pathModule.join(assetsPath, WEBVIEW_PET_OVERLAY_SCRIPT_NAME);
  const copyResult = await copyFileIfChanged(petPackage.spritesheetPath, spritesheetAssetPath, fsApi);
  const scriptResult = await writeTextFileIfChanged(
    scriptPath,
    createWebviewPetOverlayScript({
      displayName: petPackage.metadata.displayName || petSlug,
      spritesheetAssetName
    }),
    fsApi
  );
  const indexResult = await patchFile({
    filePath: indexPath,
    fsApi,
    patcher: patchWebviewIndexSource
  });

  return {
    filePath: indexPath,
    scriptPath,
    spritesheetPath: spritesheetAssetPath,
    backupPath: indexResult.backupPath,
    backupCreated: indexResult.backupCreated,
    changed: copyResult.changed || scriptResult.changed || indexResult.changed,
    alreadyPatched: !copyResult.changed && !scriptResult.changed && Boolean(indexResult.alreadyPatched)
  };
}

async function removeWebviewPetOverlay({ extensionPath, fsApi, pathModule }) {
  const indexPath = pathModule.join(extensionPath, "webview", "index.html");
  return patchFile({
    filePath: indexPath,
    fsApi,
    patcher: unpatchWebviewIndexSource
  });
}

function patchWebviewIndexSource(source) {
  const scriptTag = getWebviewOverlayScriptTag();
  if (source.includes(scriptTag)) {
    return {
      source,
      changed: false,
      alreadyPatched: true
    };
  }

  if (!source.includes("</body>")) {
    return {
      source,
      changed: false,
      alreadyPatched: false,
      reason: "Could not find </body> in the OpenAI Codex webview index."
    };
  }

  return {
    source: source.replace("</body>", `  ${scriptTag}\n</body>`),
    changed: true,
    alreadyPatched: false
  };
}

function unpatchWebviewIndexSource(source) {
  const scriptTag = getWebviewOverlayScriptTag();
  if (!source.includes(scriptTag)) {
    return {
      source,
      changed: false,
      alreadyPatched: false
    };
  }

  return {
    source: source.replace(`  ${scriptTag}\n`, "").replace(scriptTag, ""),
    changed: true,
    alreadyPatched: true
  };
}

function getWebviewOverlayScriptTag() {
  return `<script type="module" crossorigin src="./assets/${WEBVIEW_PET_OVERLAY_SCRIPT_NAME}"></script>`;
}

function createWebviewPetOverlayScript({ displayName, spritesheetAssetName }) {
  const safeDisplayName = JSON.stringify(String(displayName || "Codex pet"));
  const safeSpritesheetAssetName = JSON.stringify(`./${spritesheetAssetName}`);

  return `(() => {
  const overlayId = "codex-hud-duotuan-pet-overlay";
  const styleId = "codex-hud-duotuan-pet-overlay-style";
  const displayName = ${safeDisplayName};
  const spritesheetUrl = new URL(${safeSpritesheetAssetName}, import.meta.url).href;
  const frames = [
    { column: 0, row: 0, durationMs: 280 },
    { column: 1, row: 0, durationMs: 110 },
    { column: 2, row: 0, durationMs: 110 },
    { column: 3, row: 0, durationMs: 140 },
    { column: 4, row: 0, durationMs: 140 },
    { column: 5, row: 0, durationMs: 320 }
  ];

  function install() {
    if (!document.body || document.getElementById(overlayId)) {
      return;
    }

    if (!document.getElementById(styleId)) {
      const style = document.createElement("style");
      style.id = styleId;
      style.textContent = \`
        #\${overlayId} {
          position: fixed;
          right: 22px;
          bottom: 112px;
          width: min(136px, 22vw);
          aspect-ratio: 192 / 208;
          z-index: 2147483647;
          pointer-events: none;
          background-image: var(--codex-hud-pet-spritesheet);
          background-repeat: no-repeat;
          background-size: 800% 900%;
          filter: drop-shadow(0 14px 24px rgba(0, 0, 0, 0.35));
          opacity: 0.98;
          transform: translateZ(0);
        }
        @media (max-width: 520px) {
          #\${overlayId} {
            right: 12px;
            bottom: 92px;
            width: 104px;
          }
        }
      \`;
      document.documentElement.append(style);
    }

    const overlay = document.createElement("div");
    overlay.id = overlayId;
    overlay.setAttribute("aria-label", \`\${displayName} Codex pet\`);
    overlay.setAttribute("role", "img");
    overlay.style.setProperty("--codex-hud-pet-spritesheet", \`url("\${spritesheetUrl}")\`);
    document.body.append(overlay);

    let frameIndex = 0;
    function renderFrame() {
      const frame = frames[frameIndex % frames.length];
      overlay.style.backgroundPosition = \`\${(frame.column / 7) * 100}% \${(frame.row / 8) * 100}%\`;
      frameIndex += 1;
      window.setTimeout(renderFrame, frame.durationMs);
    }
    renderFrame();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", install, { once: true });
  } else {
    install();
  }
})();
`;
}

async function writeTextFileIfChanged(filePath, source, fsApi) {
  try {
    const current = await fsApi.readFile(filePath, "utf8");
    if (current === source) {
      return { changed: false };
    }
  } catch (error) {
    if (!error || error.code !== "ENOENT") {
      throw error;
    }
  }

  await fsApi.writeFile(filePath, source, "utf8");
  return { changed: true };
}

async function copyFileIfChanged(sourcePath, targetPath, fsApi) {
  const source = await fsApi.readFile(sourcePath);
  try {
    const target = await fsApi.readFile(targetPath);
    if (Buffer.compare(source, target) === 0) {
      return { changed: false };
    }
  } catch (error) {
    if (!error || error.code !== "ENOENT") {
      throw error;
    }
  }

  await fsApi.writeFile(targetPath, source);
  return { changed: true };
}

async function patchFile({ filePath, fsApi, patcher }) {
  const originalSource = await fsApi.readFile(filePath, "utf8");
  const patch = patcher(originalSource);

  if (patch.reason) {
    throw new Error(`${patch.reason} File: ${filePath}`);
  }

  if (!patch.changed) {
    return {
      filePath,
      backupPath: `${filePath}${BACKUP_SUFFIX}`,
      backupCreated: false,
      changed: false,
      alreadyPatched: Boolean(patch.alreadyPatched)
    };
  }

  const backup = await backupFileOnce(filePath, fsApi);
  await fsApi.writeFile(filePath, patch.source, "utf8");

  return {
    filePath,
    backupPath: backup.backupPath,
    backupCreated: backup.created,
    changed: true,
    alreadyPatched: Boolean(patch.alreadyPatched)
  };
}

async function backupFileOnce(filePath, fsApi) {
  const backupPath = `${filePath}${BACKUP_SUFFIX}`;
  try {
    await fsApi.stat(backupPath);
    return {
      backupPath,
      created: false
    };
  } catch (error) {
    if (!error || error.code !== "ENOENT") {
      throw error;
    }
  }

  const original = await fsApi.readFile(filePath);
  await fsApi.writeFile(backupPath, original);

  return {
    backupPath,
    created: true
  };
}

async function findAssetFile({ extensionPath, prefix, fsApi, pathModule }) {
  const assetsPath = pathModule.join(extensionPath, "webview", "assets");
  const entries = await fsApi.readdir(assetsPath);
  const matches = entries
    .filter((entry) => entry.startsWith(prefix) && entry.endsWith(".js"))
    .sort();

  if (!matches.length) {
    throw new Error(`Could not find ${prefix}*.js under ${assetsPath}`);
  }

  return pathModule.join(assetsPath, matches[0]);
}

async function readPetPackage({ codexHomePath, petSlug, fsApi, pathModule }) {
  const petDirectory = pathModule.join(codexHomePath, "pets", petSlug);
  const petJsonPath = pathModule.join(petDirectory, "pet.json");
  let metadata;

  try {
    metadata = JSON.parse(await fsApi.readFile(petJsonPath, "utf8"));
  } catch (error) {
    if (error && error.code === "ENOENT") {
      throw new Error(`Codex pet package not found: ${petJsonPath}`);
    }
    throw error;
  }

  const spritesheetPath = pathModule.join(petDirectory, metadata.spritesheetPath || "spritesheet.webp");
  try {
    await fsApi.stat(spritesheetPath);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      throw new Error(`Codex pet spritesheet not found: ${spritesheetPath}`);
    }
    throw error;
  }

  return {
    directory: petDirectory,
    petJsonPath,
    spritesheetPath,
    metadata
  };
}

async function setChatgptOpenOnStartup(vscodeApi, configTarget) {
  if (!vscodeApi?.workspace?.getConfiguration) {
    return false;
  }

  const config = vscodeApi.workspace.getConfiguration("chatgpt");
  if (config.get("openOnStartup", false) === true) {
    return false;
  }

  const target = configTarget ?? vscodeApi.ConfigurationTarget?.Global;
  await config.update("openOnStartup", true, target);
  return true;
}

function resolveCodexExtensionPath(options = {}) {
  if (options.extensionPath) {
    return options.extensionPath;
  }

  const extension = options.vscodeApi?.extensions?.getExtension?.(options.extensionId || DEFAULT_OPENAI_EXTENSION_ID);
  if (!extension?.extensionPath) {
    throw new Error(`OpenAI Codex extension is not installed or not visible: ${options.extensionId || DEFAULT_OPENAI_EXTENSION_ID}`);
  }

  return extension.extensionPath;
}

function resolveCodexHomePath(options = {}) {
  const dependencies = getDependencies(options);
  const configuredPath =
    options.codexHomePath ??
    options.vscodeApi?.workspace?.getConfiguration?.("codexHud")?.get?.("codexHomePath", "~/.codex") ??
    "~/.codex";

  return expandHomeDirectory(configuredPath, dependencies);
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

function normalizePetSlug(value) {
  const rawValue = String(value || DEFAULT_PET_SLUG).trim();
  const withoutCustomPrefix = rawValue.startsWith("custom:") ? rawValue.slice("custom:".length) : rawValue;
  return withoutCustomPrefix || DEFAULT_PET_SLUG;
}

function normalizePetId(value, petSlug = DEFAULT_PET_SLUG) {
  const rawValue = String(value || "").trim();
  return rawValue || `custom:${normalizePetSlug(petSlug)}`;
}

function safeAssetName(value) {
  return String(value || DEFAULT_PET_SLUG)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "") || DEFAULT_PET_SLUG;
}

function getDependencies(options = {}) {
  return {
    fsApi: options.fsApi || fsp,
    osModule: options.osModule || os,
    pathModule: options.pathModule || path
  };
}

module.exports = {
  BACKUP_SUFFIX,
  DEFAULT_OPENAI_EXTENSION_ID,
  DEFAULT_PET_ID,
  DEFAULT_PET_SLUG,
  applyPetAutoWakePatch,
  disablePetAutoWake,
  enablePetAutoWake,
  expandHomeDirectory,
  patchWebviewIndexSource,
  patchCodexAvatarSource,
  patchOverlayOpenSource,
  removePetAutoWakePatch,
  resolveCodexHomePath,
  unpatchWebviewIndexSource,
  unpatchCodexAvatarSource,
  unpatchOverlayOpenSource
};
