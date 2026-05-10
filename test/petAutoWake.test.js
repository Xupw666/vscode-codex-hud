const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const manifest = require("../package.json");
const {
  BACKUP_SUFFIX,
  applyPetAutoWakePatch,
  patchCodexAvatarSource,
  patchOverlayOpenSource,
  patchWebviewIndexSource,
  removePetAutoWakePatch,
  unpatchCodexAvatarSource,
  unpatchOverlayOpenSource,
  unpatchWebviewIndexSource
} = require("../petAutoWake");

test("pet auto wake patches the Codex avatar fallback to duotuan", () => {
  const source = "var h=r(),g=`codex`,_=a(`selected-avatar-id`,null);";
  const result = patchCodexAvatarSource(source, "custom:duotuan");

  assert.equal(result.changed, true);
  assert.match(result.source, /g=`custom:duotuan`,_=a\(`selected-avatar-id`,null\)/);
});

test("pet auto wake keeps an already patched Codex avatar fallback unchanged", () => {
  const source = "var h=r(),g=`custom:duotuan`,_=a(`selected-avatar-id`,null);";
  const result = patchCodexAvatarSource(source, "custom:duotuan");

  assert.equal(result.changed, false);
  assert.equal(result.alreadyPatched, true);
});

test("pet auto wake restores the Codex avatar fallback when disabled", () => {
  const source = "var h=r(),g=`custom:duotuan`,_=a(`selected-avatar-id`,null);";
  const result = unpatchCodexAvatarSource(source, "custom:duotuan");

  assert.equal(result.changed, true);
  assert.match(result.source, /g=`codex`,_=a\(`selected-avatar-id`,null\)/);
});

test("pet auto wake patches the overlay default to open", () => {
  const source = 'import{oi as e,y as t}from"./vscode-api-Csu73h_e.js";var n=e(t,!1);export{n as t};';
  const result = patchOverlayOpenSource(source);

  assert.equal(result.changed, true);
  assert.match(result.source, /=e\(t,!0\);/);
});

test("pet auto wake restores the overlay default when disabled", () => {
  const source = 'import{oi as e,y as t}from"./vscode-api-Csu73h_e.js";var n=e(t,!0);export{n as t};';
  const result = unpatchOverlayOpenSource(source);

  assert.equal(result.changed, true);
  assert.match(result.source, /=e\(t,!1\);/);
});

test("pet auto wake injects and removes the webview pet overlay script tag", () => {
  const source = "<html><body><div id=\"root\"></div></body></html>";
  const patched = patchWebviewIndexSource(source);
  assert.equal(patched.changed, true);
  assert.match(patched.source, /codex-hud-pet-overlay\.js/);

  const unpatched = unpatchWebviewIndexSource(patched.source);
  assert.equal(unpatched.changed, true);
  assert.equal(unpatched.source, source);
});

test("pet auto wake patches fake OpenAI assets and writes backups once", async (t) => {
  const fixture = await createFixture(t);
  const result = await applyPetAutoWakePatch({
    extensionPath: fixture.extensionPath,
    codexHomePath: fixture.codexHomePath,
    petSlug: "duotuan",
    petId: "custom:duotuan"
  });

  assert.equal(result.changed, true);
  assert.equal(result.petPackage.metadata.displayName, "多多团团");

  const avatarSource = await fsp.readFile(fixture.avatarAssetPath, "utf8");
  const overlaySource = await fsp.readFile(fixture.overlayAssetPath, "utf8");
  assert.match(avatarSource, /g=`custom:duotuan`,_=a\(`selected-avatar-id`,null\)/);
  assert.match(overlaySource, /=e\(t,!0\);/);
  assert.match(await fsp.readFile(fixture.indexPath, "utf8"), /codex-hud-pet-overlay\.js/);
  assert.match(await fsp.readFile(fixture.petOverlayScriptPath, "utf8"), /codex-hud-duotuan-pet-overlay/);
  assert.equal(fs.existsSync(fixture.petOverlaySpritesheetPath), true);
  assert.equal(fs.existsSync(`${fixture.avatarAssetPath}${BACKUP_SUFFIX}`), true);
  assert.equal(fs.existsSync(`${fixture.overlayAssetPath}${BACKUP_SUFFIX}`), true);
  assert.equal(fs.existsSync(`${fixture.indexPath}${BACKUP_SUFFIX}`), true);

  const avatarBackupStat = await fsp.stat(`${fixture.avatarAssetPath}${BACKUP_SUFFIX}`);
  const secondResult = await applyPetAutoWakePatch({
    extensionPath: fixture.extensionPath,
    codexHomePath: fixture.codexHomePath,
    petSlug: "duotuan",
    petId: "custom:duotuan"
  });
  const avatarBackupAfterStat = await fsp.stat(`${fixture.avatarAssetPath}${BACKUP_SUFFIX}`);

  assert.equal(secondResult.changed, false);
  assert.equal(secondResult.alreadyPatched, true);
  assert.equal(avatarBackupAfterStat.mtimeMs, avatarBackupStat.mtimeMs);
});

test("pet auto wake can remove the fake OpenAI asset patch", async (t) => {
  const fixture = await createFixture(t);
  await applyPetAutoWakePatch({
    extensionPath: fixture.extensionPath,
    codexHomePath: fixture.codexHomePath,
    petSlug: "duotuan",
    petId: "custom:duotuan"
  });

  const result = await removePetAutoWakePatch({
    extensionPath: fixture.extensionPath,
    petSlug: "duotuan",
    petId: "custom:duotuan"
  });

  assert.equal(result.changed, true);

  const avatarSource = await fsp.readFile(fixture.avatarAssetPath, "utf8");
  const overlaySource = await fsp.readFile(fixture.overlayAssetPath, "utf8");
  const indexSource = await fsp.readFile(fixture.indexPath, "utf8");
  assert.match(avatarSource, /g=`codex`,_=a\(`selected-avatar-id`,null\)/);
  assert.match(overlaySource, /=e\(t,!1\);/);
  assert.doesNotMatch(indexSource, /codex-hud-pet-overlay\.js/);
});

test("desktop-only pet auto wake removes all OpenAI webview pet patches", async (t) => {
  const fixture = await createFixture(t);
  await applyPetAutoWakePatch({
    extensionPath: fixture.extensionPath,
    codexHomePath: fixture.codexHomePath,
    petSlug: "duotuan",
    petId: "custom:duotuan",
    webviewOverlayEnabled: true
  });

  const result = await applyPetAutoWakePatch({
    extensionPath: fixture.extensionPath,
    codexHomePath: fixture.codexHomePath,
    petSlug: "duotuan",
    petId: "custom:duotuan",
    webviewOverlayEnabled: false
  });

  assert.equal(result.changed, true);

  const avatarSource = await fsp.readFile(fixture.avatarAssetPath, "utf8");
  const overlaySource = await fsp.readFile(fixture.overlayAssetPath, "utf8");
  const indexSource = await fsp.readFile(fixture.indexPath, "utf8");
  assert.match(avatarSource, /g=`codex`,_=a\(`selected-avatar-id`,null\)/);
  assert.match(overlaySource, /=e\(t,!1\);/);
  assert.doesNotMatch(indexSource, /codex-hud-pet-overlay\.js/);
});

test("pet auto wake reports a missing pet package before patching", async (t) => {
  const fixture = await createFixture(t);
  await fsp.rm(path.join(fixture.codexHomePath, "pets", "duotuan"), {
    recursive: true,
    force: true
  });

  await assert.rejects(
    applyPetAutoWakePatch({
      extensionPath: fixture.extensionPath,
      codexHomePath: fixture.codexHomePath,
      petSlug: "duotuan",
      petId: "custom:duotuan"
    }),
    /Codex pet package not found/
  );
});

test("manifest contributes pet auto wake commands and settings", () => {
  const expectedCommands = [
    "codexHud.enablePetAutoWake",
    "codexHud.disablePetAutoWake",
    "codexHud.repairPetAutoWake"
  ];

  for (const commandId of expectedCommands) {
    assert.ok(
      manifest.activationEvents.includes(`onCommand:${commandId}`),
      `missing activation event for ${commandId}`
    );
    assert.ok(
      manifest.contributes.commands.some((command) => command.command === commandId),
      `missing command contribution for ${commandId}`
    );
  }

  assert.equal(manifest.contributes.configuration.properties["codexHud.petAutoWake.enabled"].default, false);
  assert.equal(manifest.contributes.configuration.properties["codexHud.petAutoWake.petSlug"].default, "duotuan");
  assert.equal(manifest.contributes.configuration.properties["codexHud.petAutoWake.petId"].default, "custom:duotuan");
});

async function createFixture(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "codex-hud-pet-autowake-"));
  t.after(async () => {
    await fsp.rm(root, {
      recursive: true,
      force: true
    });
  });

  const extensionPath = path.join(root, "openai.chatgpt");
  const assetsPath = path.join(extensionPath, "webview", "assets");
  const codexHomePath = path.join(root, "codex-home");
  const petPath = path.join(codexHomePath, "pets", "duotuan");
  const indexPath = path.join(extensionPath, "webview", "index.html");
  const avatarAssetPath = path.join(assetsPath, "codex-avatar-DviyLvDs.js");
  const overlayAssetPath = path.join(assetsPath, "avatar-overlay-open-state-signal-m024BnlS.js");
  const petOverlayScriptPath = path.join(assetsPath, "codex-hud-pet-overlay.js");
  const petOverlaySpritesheetPath = path.join(assetsPath, "codex-hud-duotuan-spritesheet.webp");

  await fsp.mkdir(assetsPath, { recursive: true });
  await fsp.mkdir(petPath, { recursive: true });
  await fsp.writeFile(indexPath, "<html><body><div id=\"root\"></div></body></html>", "utf8");
  await fsp.writeFile(avatarAssetPath, "var h=r(),g=`codex`,_=a(`selected-avatar-id`,null);", "utf8");
  await fsp.writeFile(
    overlayAssetPath,
    'import{oi as e,y as t}from"./vscode-api-Csu73h_e.js";var n=e(t,!1);export{n as t};',
    "utf8"
  );
  await fsp.writeFile(
    path.join(petPath, "pet.json"),
    JSON.stringify({
      id: "duotuan",
      displayName: "多多团团",
      spritesheetPath: "spritesheet.webp"
    }),
    "utf8"
  );
  await fsp.writeFile(path.join(petPath, "spritesheet.webp"), "fake-webp");

  return {
    root,
    extensionPath,
    codexHomePath,
    indexPath,
    avatarAssetPath,
    overlayAssetPath,
    petOverlayScriptPath,
    petOverlaySpritesheetPath
  };
}
