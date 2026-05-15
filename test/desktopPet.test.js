const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const manifest = require("../package.json");
const {
  createNotificationEventFromCodexEvent
} = require("../codexNotifications");
const {
  startDesktopPet,
  stopDesktopPet
} = require("../desktopPet");

test("desktop pet spawns the native helper with the duotuan spritesheet", async (t) => {
  const fixture = await createFixture(t);
  const calls = [];
  const childProcessApi = {
    spawn(executablePath, args, options) {
      calls.push({ executablePath, args, options });
      return {
        pid: 12345,
        unref() {}
      };
    }
  };

  const result = await startDesktopPet({
    childProcessApi,
    codexHomePath: fixture.codexHomePath,
    extensionPath: fixture.extensionPath,
    petSlug: "duotuan"
  });

  assert.equal(result.pid, 12345);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].executablePath, fixture.executablePath);
  assert.deepEqual(calls[0].args.slice(0, 2), ["--spritesheet", fixture.spritesheetPath]);
  assert.equal(calls[0].options.detached, true);
});

test("desktop pet falls back to the bundled duotuan spritesheet", async (t) => {
  const fixture = await createFixture(t);
  const bundledSpritesheetPath = path.join(fixture.extensionPath, "pets", "duotuan", "spritesheet.webp");
  await fsp.mkdir(path.dirname(bundledSpritesheetPath), { recursive: true });
  await fsp.writeFile(bundledSpritesheetPath, "bundled-webp");
  await fsp.rm(path.join(fixture.codexHomePath, "pets", "duotuan"), {
    recursive: true,
    force: true
  });

  const calls = [];
  const childProcessApi = {
    spawn(executablePath, args, options) {
      calls.push({ executablePath, args, options });
      return {
        pid: 12345,
        unref() {}
      };
    }
  };

  const result = await startDesktopPet({
    childProcessApi,
    codexHomePath: fixture.codexHomePath,
    extensionPath: fixture.extensionPath,
    petSlug: "duotuan"
  });

  assert.equal(result.spritesheetPath, bundledSpritesheetPath);
  assert.deepEqual(calls[0].args.slice(0, 2), ["--spritesheet", bundledSpritesheetPath]);
});

test("desktop pet reuses a live helper instead of spawning duplicates", async (t) => {
  const fixture = await createFixture(t);
  const pidFilePath = path.join(fixture.codexHomePath, "duotuan-pet.pid");
  await fsp.mkdir(path.dirname(pidFilePath), { recursive: true });
  await fsp.writeFile(pidFilePath, "23456\n", "utf8");
  const childProcessApi = {
    spawn() {
      throw new Error("spawn should not be called when a live pet helper already exists");
    }
  };
  const processApi = {
    kill(pid, signal) {
      assert.equal(pid, 23456);
      assert.equal(signal, 0);
      return true;
    }
  };

  const result = await startDesktopPet({
    childProcessApi,
    processApi,
    codexHomePath: fixture.codexHomePath,
    extensionPath: fixture.extensionPath,
    petSlug: "duotuan"
  });

  assert.equal(result.pid, 23456);
  assert.equal(result.alreadyRunning, true);
});

test("desktop pet passes the Codex URI to the native helper", async (t) => {
  const fixture = await createFixture(t);
  const calls = [];
  const childProcessApi = {
    spawn(executablePath, args, options) {
      calls.push({ executablePath, args, options });
      return {
        pid: 12345,
        unref() {}
      };
    }
  };

  await startDesktopPet({
    childProcessApi,
    codexHomePath: fixture.codexHomePath,
    codexUri: "vscode://local.codex-hud/open-codex",
    extensionPath: fixture.extensionPath,
    petSlug: "duotuan"
  });

  assert.deepEqual(
    calls[0].args.slice(-2),
    ["--codex-uri", "vscode://local.codex-hud/open-codex"]
  );
});

test("desktop pet passes notification and size options to the native helper", async (t) => {
  const fixture = await createFixture(t);
  const calls = [];
  const childProcessApi = {
    spawn(executablePath, args, options) {
      calls.push({ executablePath, args, options });
      return {
        pid: 12345,
        unref() {}
      };
    }
  };

  await startDesktopPet({
    childProcessApi,
    codexHomePath: fixture.codexHomePath,
    extensionPath: fixture.extensionPath,
    notificationMode: "progress",
    petSize: 188,
    petSlug: "duotuan"
  });

  assert.ok(calls[0].args.includes("--codex-home"));
  assert.ok(calls[0].args.includes(fixture.codexHomePath));
  assert.ok(calls[0].args.includes("--notification-mode"));
  assert.ok(calls[0].args.includes("progress"));
  assert.ok(calls[0].args.includes("--pet-size"));
  assert.ok(calls[0].args.includes("188"));
});

test("desktop pet passes pet switching context and reads the pet display name", async (t) => {
  const fixture = await createFixture(t);
  await fsp.writeFile(
    path.join(fixture.codexHomePath, "pets", "duotuan", "pet.json"),
    JSON.stringify({
      id: "duotuan",
      displayName: "多多团团",
      spritesheetPath: "spritesheet.webp"
    }),
    "utf8"
  );
  const calls = [];
  const childProcessApi = {
    spawn(executablePath, args, options) {
      calls.push({ executablePath, args, options });
      return {
        pid: 12345,
        unref() {}
      };
    }
  };

  await startDesktopPet({
    childProcessApi,
    codexHomePath: fixture.codexHomePath,
    extensionPath: fixture.extensionPath,
    petSlug: "duotuan",
    switchPetUriPrefix: "vscode://local.codex-hud/switch-pet?slug="
  });

  assert.ok(calls[0].args.includes("--pet-slug"));
  assert.ok(calls[0].args.includes("duotuan"));
  assert.ok(calls[0].args.includes("--extension-path"));
  assert.ok(calls[0].args.includes(fixture.extensionPath));
  assert.ok(calls[0].args.includes("--switch-pet-uri-prefix"));
  assert.ok(calls[0].args.includes("vscode://local.codex-hud/switch-pet?slug="));
  assert.deepEqual(
    calls[0].args.slice(calls[0].args.indexOf("--pet-name"), calls[0].args.indexOf("--pet-name") + 2),
    ["--pet-name", "多多团团"]
  );
});

test("desktop pet stop ignores a missing pid file", async (t) => {
  const fixture = await createFixture(t);
  assert.equal(await stopDesktopPet({ codexHomePath: fixture.codexHomePath }), false);
});

test("codex notification events identify approvals and completions", () => {
  const state = { title: "在 VS Code 唤醒小宠物" };
  const approval = createNotificationEventFromCodexEvent({
    type: "response_item",
    payload: {
      type: "function_call",
      call_id: "call_1",
      turn_id: "turn_1",
      arguments: {
        sandbox_permissions: "require_escalated",
        justification: "需要修改已安装扩展目录。"
      }
    }
  }, state);
  const completion = createNotificationEventFromCodexEvent({
    type: "event_msg",
    payload: {
      type: "task_complete",
      turn_id: "turn_1",
      last_agent_message: "已经完成。"
    }
  }, state);

  assert.equal(approval.type, "needs_approval");
  assert.equal(approval.taskKey, "turn_1");
  assert.equal(approval.title, "在 VS Code 唤醒小宠物 需要你同意");
  assert.equal(approval.body, "需要修改已安装扩展目录。");
  assert.equal(completion.type, "completed");
  assert.equal(completion.taskKey, "turn_1");
  assert.equal(completion.title, "在 VS Code 唤醒小宠物 已经完成作业");
});

test("codex notification events include stable task keys for task state updates", () => {
  const state = { firstMessage: "执行自媒体故事任务" };
  const started = createNotificationEventFromCodexEvent({
    type: "event_msg",
    payload: {
      type: "task_started",
      turn_id: "turn_started"
    }
  }, state);
  const progress = createNotificationEventFromCodexEvent({
    type: "event_msg",
    payload: {
      type: "agent_message",
      turn_id: "turn_progress",
      message: "正在处理。"
    }
  }, state, { nowMs: 45_000 });

  assert.equal(started.type, "started");
  assert.equal(started.taskKey, "turn_started");
  assert.equal(progress.type, "progress");
  assert.equal(progress.taskKey, "turn_progress");
});

test("codex notification progress reuses the task key discovered from the same session", () => {
  const state = { firstMessage: "执行自媒体故事任务" };
  const started = createNotificationEventFromCodexEvent({
    type: "event_msg",
    payload: {
      type: "task_started",
      turn_id: "turn_shared"
    }
  }, state, { fileKey: "session-file.jsonl" });
  const progress = createNotificationEventFromCodexEvent({
    type: "event_msg",
    payload: {
      type: "agent_message",
      message: "正在处理。"
    }
  }, state, { fileKey: "session-file.jsonl", nowMs: 45_000 });

  assert.equal(started.taskKey, "turn_shared");
  assert.equal(progress.taskKey, "turn_shared");
});

test("manifest contributes desktop pet settings", () => {
  assert.ok(manifest.activationEvents.includes("onUri"));
  assert.equal(manifest.scripts["build:desktop-pet"], "clang -fobjc-arc desktop-pet/DuoTuanPet.m -framework Cocoa -o desktop-pet/DuoTuanPet");
  assert.equal(manifest.contributes.configuration.properties["codexHud.petAutoWake.desktopPet.enabled"].default, true);
  assert.equal(manifest.contributes.configuration.properties["codexHud.petAutoWake.webviewOverlay.enabled"].default, false);
  assert.equal(manifest.contributes.configuration.properties["codexHud.petAutoWake.notificationMode"].default, "critical");
  assert.equal(manifest.contributes.configuration.properties["codexHud.petAutoWake.desktopPet.size"].default, 160);
});

test("native desktop pet idle loop avoids the incomplete table corner frame", () => {
  const source = readNativePetSource();

  assert.doesNotMatch(source, /\{5,\s*0,\s*0\.32\}/);
  assert.match(source, /\{0,\s*0,\s*0\.32\}/);
});

test("native desktop pet bubble folds instead of closing and can expand from the badge", () => {
  const source = readNativePetSource();

  assert.doesNotMatch(source, /buttonWithTitle:@"×"/);
  assert.match(source, /buttonWithTitle:@"⌄"/);
  assert.match(source, /@selector\(collapseBubble:\)/);
  assert.match(source, /toggleTaskBubble:/);
  assert.doesNotMatch(source, /AppDelegate \*\)NSApp\.delegate showTaskListBubble:nil/);
  assert.match(source, /showTaskListBubble/);
  assert.match(source, /_activeTaskKeys/);
  assert.match(source, /drawBadgeInRect:/);
});

test("native desktop pet badge toggles task bubbles closed when already expanded", () => {
  const source = readNativePetSource();

  assert.match(source, /typedef NS_ENUM\(NSInteger, BubbleDisplayState\)/);
  assert.match(source, /BubbleDisplayStateTaskList/);
  assert.match(source, /BubbleDisplayStateTaskDetail/);
  assert.match(source, /- \(void\)toggleTaskBubble:\(id\)sender/);
  assert.match(source, /_bubbleDisplayState == BubbleDisplayStateTaskList/);
  assert.match(source, /_bubbleDisplayState == BubbleDisplayStateTaskDetail/);
  assert.match(source, /_bubbleDisplayState = BubbleDisplayStateTaskList/);
  assert.match(source, /_bubbleDisplayState = BubbleDisplayStateTaskDetail/);
  assert.match(source, /_bubbleDisplayState = BubbleDisplayStateNone/);
});

test("native desktop pet badge opens a multi-task list with expandable task cards", () => {
  const source = readNativePetSource();

  assert.match(source, /@interface TaskChevronButton : NSButton/);
  assert.match(source, /mouseEntered:/);
  assert.match(source, /mouseExited:/);
  assert.match(source, /drawAtPoint:textPoint withAttributes:attributes/);
  assert.match(source, /showTaskListBubble:/);
  assert.match(source, /taskSummaryForKey:/);
  assert.match(source, /expandTaskBubble:/);
  assert.match(source, /@selector\(expandTaskBubble:\)/);
});

test("native desktop pet badge follows active task state instead of historical notifications", () => {
  const source = readNativePetSource();

  assert.match(source, /_activeTaskSummaries/);
  assert.match(source, /_activeTaskOrder/);
  assert.match(source, /syncActiveTaskKey:\(NSString \*\)taskKey forNotificationType:\(NSString \*\)type/);
  assert.match(source, /if \(\[type isEqualToString:@"started"\] \|\|/);
  assert.match(source, /\[_activeTaskKeys addObject:taskKey\]/);
  assert.match(source, /\[_activeTaskSummaries setObject:/);
  assert.match(source, /\[_activeTaskOrder addObject:taskKey\]/);
  assert.match(source, /else if \(\[type isEqualToString:@"completed"\] \|\|/);
  assert.match(source, /\[_activeTaskKeys removeObject:taskKey\]/);
  assert.match(source, /\[_activeTaskSummaries removeObjectForKey:taskKey\]/);
  assert.match(source, /\[_activeTaskOrder removeObject:taskKey\]/);
  assert.match(source, /setBadgeCount:_activeTaskKeys.count/);
});

test("native desktop pet tracks active tasks even when progress bubbles are hidden", () => {
  const source = readNativePetSource();

  assert.match(source, /syncActiveTaskKey:taskKey\s+forNotificationType:type\s+title:title/);
  assert.match(source, /if \(!\[_notificationMode isEqualToString:kNotificationModeProgress\]/);
  assert.match(source, /syncActiveTaskKey:turnId\s+forNotificationType:@"started"/);
  assert.match(source, /syncActiveTaskKey:turnId\s+forNotificationType:@"progress"/);
  assert.match(source, /if \(\[self isProgressMode\]\)/);
});

test("native desktop pet seeds active task list from recent event log on restart", () => {
  const source = readNativePetSource();

  assert.match(source, /seedActiveTasksFromEventLog/);
  assert.match(source, /event\[@"emittedAt"\]/);
  assert.match(source, /dateByAddingTimeInterval:-6 \* 60 \* 60/);
  assert.match(source, /updatedAt:emittedAt/);
  assert.match(source, /pruneStaleActiveTasks/);
});

test("native desktop pet reconciles badge count from current session files", () => {
  const source = readNativePetSource();

  assert.match(source, /_activeTaskReconcileTimer/);
  assert.match(source, /_activeTaskReconcileQueue/);
  assert.match(source, /_reconcileInFlight/);
  assert.match(source, /_sessionSummaryCache/);
  assert.match(source, /dispatch_async\(_activeTaskReconcileQueue/);
  assert.match(source, /dispatch_async\(dispatch_get_main_queue\(\)/);
  assert.match(source, /reconcileActiveTasksWithSessionFiles:/);
  assert.match(source, /activeTaskSummariesFromRecentSessions/);
  assert.match(source, /activeTaskSummaryForSessionFile:filePath\s+modifiedAt:modifiedAt\s+oldestInterestingDate:/);
  assert.match(source, /replaceActiveTasksWithSummaries:/);
  assert.match(source, /activeTaskSnapshotMatchesCurrentState:/);
  assert.match(source, /pollCodexSessions:timer/);
  assert.match(source, /kActiveTaskStaleInterval/);
  assert.match(source, /_activeTaskLastUpdatedAt/);
});

test("native desktop pet derives task keys for legacy events without taskKey", () => {
  const source = readNativePetSource();

  assert.match(source, /taskKeyForEvent:/);
  assert.match(source, /event\[@"taskKey"\]/);
  assert.match(source, /event\[@"id"\]/);
  assert.match(source, /_legacyTaskKeysByTitle/);
  assert.match(source, /taskTitleFromNotificationTitle:/);
  assert.match(source, /NSString \*taskKey = \[self taskKeyForEvent:event\]/);
});

test("native desktop pet session monitor passes task state and task key", () => {
  const source = readNativePetSource();

  assert.match(source, /_fileTaskKeys/);
  assert.match(source, /_fileTaskKeys\[filePath\] = rawTurnId/);
  assert.match(source, /NSString \*turnId = _fileTaskKeys\[filePath\]/);
  assert.match(source, /type:@"needs_approval"\s+taskKey:turnId/);
  assert.match(source, /type:@"started"\s+taskKey:turnId/);
  assert.match(source, /type:@"progress"\s+taskKey:turnId/);
  assert.match(source, /type:@"completed"\s+taskKey:turnId/);
});

test("native desktop pet maps task events to existing spritesheet state rows", () => {
  const source = readNativePetSource();

  assert.match(source, /PetAnimationStateWaiting/);
  assert.match(source, /PetAnimationStateRunning/);
  assert.match(source, /PetAnimationStateReview/);
  assert.match(source, /PetAnimationStateFailed/);
  assert.match(source, /case PetAnimationStateWaiting:\s*return 6;/);
  assert.match(source, /case PetAnimationStateRunning:\s*return 7;/);
  assert.match(source, /case PetAnimationStateReview:\s*return 8;/);
  assert.match(source, /case PetAnimationStateFailed:\s*return 5;/);
});

test("native desktop pet preserves task animation state after drag gestures", () => {
  const source = readNativePetSource();

  assert.match(source, /PetAnimationState _restingState;/);
  assert.match(source, /setTransientAnimationState:/);
  assert.match(source, /setTransientAnimationState:_restingState/);
});

test("native desktop pet has a passive 30 minute rest reminder bubble", () => {
  const source = readNativePetSource();

  assert.match(source, /kRestReminderInterval = 30\.0 \* 60\.0/);
  assert.match(source, /kRestReminderMinVisibleSeconds = 4\.0/);
  assert.match(source, /kRestReminderMaxVisibleSeconds = 6\.0/);
  assert.match(source, /还在努力啊？真棒棒呢～/);
  assert.match(source, /卷王你好呀～/);
  assert.match(source, /认真你就输了哦～/);
  assert.match(source, /startRestReminderTimer/);
  assert.match(source, /showRestReminderIfIdle:/);
  assert.match(source, /showRestReminderBubbleWithMessage:/);
  assert.match(source, /ignoresMouseEvents = YES/);
});

test("native desktop pet can switch pet packages from the right click menu", () => {
  const source = readNativePetSource();

  assert.match(source, /--pet-slug/);
  assert.match(source, /--extension-path/);
  assert.match(source, /--switch-pet-uri-prefix/);
  assert.match(source, /切换形象/);
  assert.match(source, /makePetSwitchMenu/);
  assert.match(source, /switchPetFromMenu:/);
  assert.match(source, /availablePetPackages/);
  assert.match(source, /loadPetPackageAtDirectory:/);
  assert.match(source, /replaceImage:image petName:/);
  assert.match(source, /notifyExtensionOfPetSwitch:/);
});

test("extension handles desktop pet switch URIs by updating pet config", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "extension.js"), "utf8");

  assert.match(source, /const PET_SWITCH_URI_PATH = "\/switch-pet"/);
  assert.match(source, /createPetSwitchUriPrefix/);
  assert.match(source, /switchPetFromUri/);
  assert.match(source, /new URLSearchParams\(uri\.query \|\| ""\)/);
  assert.match(source, /config\.update\("petAutoWake\.petSlug", petSlug/);
  assert.match(source, /config\.update\("petAutoWake\.petId", `custom:\$\{petSlug\}`/);
});

async function createFixture(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "codex-hud-desktop-pet-"));
  t.after(async () => {
    await fsp.rm(root, {
      recursive: true,
      force: true
    });
  });

  const extensionPath = path.join(root, "extension");
  const executablePath = path.join(extensionPath, "desktop-pet", "DuoTuanPet");
  const codexHomePath = path.join(root, "codex-home");
  const spritesheetPath = path.join(codexHomePath, "pets", "duotuan", "spritesheet.webp");

  await fsp.mkdir(path.dirname(executablePath), { recursive: true });
  await fsp.mkdir(path.dirname(spritesheetPath), { recursive: true });
  await fsp.writeFile(executablePath, "#!/bin/sh\n");
  await fsp.chmod(executablePath, 0o755);
  await fsp.writeFile(spritesheetPath, "fake-webp");

  assert.equal(fs.existsSync(executablePath), true);
  assert.equal(fs.existsSync(spritesheetPath), true);

  return {
    codexHomePath,
    executablePath,
    extensionPath,
    spritesheetPath
  };
}

function readNativePetSource() {
  return fs.readFileSync(path.join(__dirname, "..", "desktop-pet", "DuoTuanPet.m"), "utf8");
}
