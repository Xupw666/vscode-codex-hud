const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const manifest = require("../package.json");
const {
  AUTO_LAUNCH_SUPPRESSION_MS,
  formatLaunchErrorMessage,
  shouldAutoLaunch
} = require("../quickLauncher");

test("quick launcher stays quiet during startup suppression window", () => {
  const shouldLaunch = shouldAutoLaunch({
    visible: true,
    launchConsumedForCurrentReveal: false,
    activatedAt: 10_000,
    now: 10_000 + AUTO_LAUNCH_SUPPRESSION_MS - 1
  });

  assert.equal(shouldLaunch, false);
});

test("quick launcher only auto-launches once per reveal after suppression window", () => {
  const now = 10_000 + AUTO_LAUNCH_SUPPRESSION_MS;

  assert.equal(
    shouldAutoLaunch({
      visible: true,
      launchConsumedForCurrentReveal: false,
      activatedAt: 10_000,
      now
    }),
    true
  );

  assert.equal(
    shouldAutoLaunch({
      visible: true,
      launchConsumedForCurrentReveal: true,
      activatedAt: 10_000,
      now
    }),
    false
  );
});

test("quick launcher error formatter falls back cleanly", () => {
  assert.equal(formatLaunchErrorMessage(new Error("boom")), "boom");
  assert.equal(formatLaunchErrorMessage("plain failure"), "plain failure");
  assert.equal(formatLaunchErrorMessage(undefined), "Unknown error");
});

test("manifest contributes quick launcher command and activity bar entry", () => {
  assert.ok(
    manifest.activationEvents.includes("onView:codexHud.quickLauncher"),
    "missing quick launcher activation event"
  );
  assert.ok(
    manifest.activationEvents.includes("onCommand:codexHud.quickOpenCodexAgent"),
    "missing quick launcher command activation event"
  );

  assert.ok(
    manifest.contributes.commands.some((command) => command.command === "codexHud.quickOpenCodexAgent"),
    "missing quick launcher command contribution"
  );

  assert.ok(
    manifest.contributes.viewsContainers.activitybar.some((container) => container.id === "codexHudLauncher"),
    "missing quick launcher activity bar container"
  );

  assert.ok(
    manifest.contributes.views.codexHudLauncher.some((view) => view.id === "codexHud.quickLauncher"),
    "missing quick launcher view"
  );

  const launcherContainer = manifest.contributes.viewsContainers.activitybar.find((container) => container.id === "codexHudLauncher");
  assert.ok(launcherContainer, "missing quick launcher container details");
  assert.equal(launcherContainer.icon, "media/blossom-white.svg", "quick launcher should use the official-style Codex blossom icon");
});

test("official-style blossom icon asset exists for the quick launcher", () => {
  const iconPath = path.join(__dirname, "..", "media", "blossom-white.svg");
  assert.equal(fs.existsSync(iconPath), true, "expected blossom icon asset to exist");
});
