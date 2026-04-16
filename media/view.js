(function () {
  const vscode = acquireVsCodeApi();
  let state = window.__CODEX_HUD_INITIAL_STATE__ || {};
  let activeTab = "overview";

  const app = document.getElementById("app");

  window.addEventListener("message", (event) => {
    const message = event.data;
    if (!message || message.type !== "snapshot") {
      return;
    }
    state = message.payload;
    render();
  });

  render();

  function render() {
    app.innerHTML = `
      <div class="shell">
        ${renderBanner()}
        <div class="tabs">
          ${renderTabButton("overview", "Status")}
          ${renderTabButton("context", "Context")}
          ${renderTabButton("usage", "Usage")}
          ${renderTabButton("config", "Config")}
        </div>
        <div class="panel">
          <section class="section ${activeTab === "overview" ? "is-active" : ""}" data-section="overview">
            ${renderOverview()}
          </section>
          <section class="section ${activeTab === "context" ? "is-active" : ""}" data-section="context">
            ${renderContext()}
          </section>
          <section class="section ${activeTab === "usage" ? "is-active" : ""}" data-section="usage">
            ${renderUsage()}
          </section>
          <section class="section ${activeTab === "config" ? "is-active" : ""}" data-section="config">
            ${renderConfig()}
          </section>
        </div>
      </div>
    `;

    bindEvents();
  }

  function renderBanner() {
    const alerts = [];
    if (state?.usage?.session?.usedPercent >= 100) {
      alerts.push("Session limit reached.");
    } else if (state?.usage?.session?.status === "warn") {
      alerts.push("Session remaining is getting low.");
    }

    if (state?.contextWindow?.status === "warn" || state?.contextWindow?.status === "danger") {
      alerts.push("Background context is filling the context window.");
    }

    if (!alerts.length) {
      return `<div class="banner">No active warnings.</div>`;
    }

    return `
      <div class="banner is-visible">
        <div>${alerts.join(" ")}</div>
        <a href="#" data-action="open-tab" data-tab="usage">Review usage</a>
      </div>
    `;
  }

  function renderOverview() {
    const items = state?.context?.items || [];
    const previewItems = items.slice(0, 3);
    const hasContextItems = items.length > 0;
    return `
      <div class="grid cols-3">
        ${renderMetricProgressCard("Context remaining", state?.contextWindow, {
          detail: `${state?.contextWindow?.remainingTokens || 0}/${state?.contextWindow?.limitTokens || 0} tokens left`,
          tokenMode: "remaining"
        })}
        ${renderMetricProgressCard("Session remaining", state?.usage?.session, {
          detail: state?.usage?.session?.resetAt || "Reset time not set"
        })}
        ${renderMetricProgressCard("Week remaining", state?.usage?.weekly, {
          detail: state?.usage?.weekly?.resetAt || "Reset time not set"
        })}
      </div>
      <div class="card stack">
        <div class="eyebrow">Background pack</div>
        <div class="chips">
          <div class="chip">${state?.context?.totalItems || 0} items</div>
          <div class="chip">${state?.context?.pinnedItems || 0} pinned</div>
          <div class="chip">${state?.context?.totalTokens || 0} tokens</div>
        </div>
        ${
          previewItems.length
            ? `<div class="list">${previewItems.map(renderContextItem).join("")}</div>`
            : `<div class="empty">No background items yet. Capture a selection or add a note.</div>`
        }
      </div>
      <div class="card intro">
        <div class="eyebrow">Bottom panel home</div>
        <div class="intro-title">Codex HUD lives in the VS Code bottom panel.</div>
        <div class="subtle">If it disappears, click the status bar item or run <strong>Codex HUD: Open Panel</strong> from the command palette.</div>
        ${
          hasContextItems
            ? ""
            : `<div class="actions"><button class="button ghost" data-action="reveal-panel">Show me where it lives</button></div>`
        }
      </div>
    `;
  }

  function renderContext() {
    const items = state?.context?.items || [];
    return `
      ${
        items.length
          ? ""
          : `<div class="card intro">
              <div class="eyebrow">Getting started</div>
              <div class="intro-title">This is your reusable background context tray.</div>
              <div class="subtle">Save notes here, then reopen this bottom panel anytime from the status bar or <strong>Codex HUD: Open Panel</strong>.</div>
            </div>`
      }
      <div class="card stack">
        <div class="eyebrow">Add background info</div>
        <div class="form-grid">
          <div class="field">
            <label for="context-title">Title</label>
            <input id="context-title" placeholder="Customer brief / Prompt policy / Research note" />
          </div>
          <div class="field" style="grid-column: 1 / -1;">
            <label for="context-body">Body</label>
            <textarea id="context-body" placeholder="Paste reference notes, constraints, style guides, or research snippets."></textarea>
          </div>
        </div>
        <div class="actions">
          <button class="button primary" data-action="add-context">Save note</button>
          <button class="button" data-action="capture-selection">Capture editor selection</button>
          <button class="button ghost" data-action="copy-compiled">Copy merged context</button>
        </div>
      </div>
      <div class="card stack">
        <div class="eyebrow">Managed items</div>
        <div class="chips">
          <div class="chip">${state?.context?.totalItems || 0} items</div>
          <div class="chip">${state?.context?.totalTokens || 0} tokens</div>
          <div class="chip">Longest: ${escapeHtml(state?.stats?.longestItemTitle || "None")}</div>
        </div>
        ${
          items.length
            ? `<div class="list">${items.map(renderContextItem).join("")}</div>`
            : `<div class="empty">Your background info pack is empty.</div>`
        }
      </div>
    `;
  }

  function renderUsage() {
    const extraUsageLabel = state?.usage?.extraUsageLabel || "Extra usage not enabled";
    const source = state?.usage?.source;
    return `
      <div class="card stack">
        <div class="eyebrow">Usage source</div>
        <div class="intro-title">${escapeHtml(source?.mode === "codex-rollout" ? "Live data from your latest Codex rollout" : "Manual fallback values")}</div>
        <div class="subtle">${escapeHtml(source?.description || "No usage source detected yet.")}</div>
        ${
          source?.planType
            ? `<div class="chips"><div class="chip">Plan: ${escapeHtml(source.planType)}</div></div>`
            : ""
        }
        ${
          source?.lastSyncedAt
            ? `<div class="subtle">Last synced: ${escapeHtml(new Date(source.lastSyncedAt).toLocaleString())}</div>`
            : ""
        }
        ${
          source?.currentContextTokens
            ? `<div class="subtle">Current context: ${escapeHtml(String(round(source.currentContextTokens)))} / ${escapeHtml(String(round(state?.contextWindow?.limitTokens)))} tokens. This now follows the real Codex thread context.</div>`
            : source?.latestThreadTokenTotal
            ? `<div class="subtle">Latest thread total: ${escapeHtml(String(round(source.latestThreadTokenTotal)))} tokens. Context falls back to HUD-managed estimates when live context is unavailable.</div>`
            : `<div class="subtle">Context falls back to HUD-managed estimates when live context is unavailable.</div>`
        }
        ${
          source?.error
            ? `<div class="subtle">Last sync error: ${escapeHtml(source.error)}</div>`
            : ""
        }
        <div class="actions">
          <button class="button primary" data-action="refresh-usage">Refresh from Codex</button>
        </div>
      </div>
      <div class="card stack">
        <div class="eyebrow">Update usage</div>
        <div class="form-grid">
          <div class="field">
            <label for="session-used">Session remaining %</label>
            <input id="session-used" type="number" min="0" max="100" value="${round(state?.usage?.session?.remainingPercent)}" />
          </div>
          <div class="field">
            <label for="session-reset">Session resets at</label>
            <input id="session-reset" value="${escapeAttribute(state?.usage?.session?.resetAt || "")}" placeholder="5pm (Asia/Shanghai)" />
          </div>
          <div class="field">
            <label for="weekly-used">Week remaining %</label>
            <input id="weekly-used" type="number" min="0" max="100" value="${round(state?.usage?.weekly?.remainingPercent)}" />
          </div>
          <div class="field">
            <label for="weekly-reset">Week resets at</label>
            <input id="weekly-reset" value="${escapeAttribute(state?.usage?.weekly?.resetAt || "")}" placeholder="Apr 18 3pm (Asia/Shanghai)" />
          </div>
          <div class="field">
            <label for="extra-usage-label">Extra usage label</label>
            <input id="extra-usage-label" value="${escapeAttribute(extraUsageLabel)}" placeholder="Enabled via enterprise plan" />
          </div>
          <div class="field">
            <label class="switch">
              <input id="extra-usage-enabled" type="checkbox" ${state?.usage?.extraUsageEnabled ? "checked" : ""} />
              <span>Extra usage enabled</span>
            </label>
          </div>
        </div>
        <div class="actions">
          <button class="button primary" data-action="save-usage">Save usage</button>
        </div>
      </div>
    `;
  }

  function renderConfig() {
    return `
      <div class="card stack">
        <div class="eyebrow">Context window config</div>
        <div class="form-grid">
          <div class="field">
            <label for="context-limit">Limit tokens</label>
            <input id="context-limit" type="number" min="1" value="${round(state?.contextWindow?.limitTokens)}" />
          </div>
          <div class="field">
            <label for="context-base">Reserved base tokens</label>
            <input id="context-base" type="number" min="0" value="${round(state?.contextWindow?.baseTokens)}" />
          </div>
          <div class="field">
            <label for="context-warn">Warn at %</label>
            <input id="context-warn" type="number" min="1" max="100" value="${round(state?.contextWindow?.warnAtPercent)}" />
          </div>
        </div>
        <div class="actions">
          <button class="button primary" data-action="save-config">Save config</button>
          <button class="button ghost" data-action="open-settings">Open VS Code settings</button>
        </div>
      </div>
      <div class="card stack">
        <div class="eyebrow">Compiled prompt pack</div>
        <div class="codebox">${escapeHtml(state?.stats?.compiledContext || "No compiled context yet.")}</div>
        <div class="subtle">Pinned items stay on top. Token counts are estimated, not exact model accounting.</div>
      </div>
    `;
  }

  function renderMetricCard(label, value, detail, toneClass) {
    return `
      <div class="card ${toneClass || ""}">
        <div class="eyebrow">${escapeHtml(label)}</div>
        <div class="metric">${escapeHtml(String(value))}</div>
        <p class="subtle">${escapeHtml(detail)}</p>
      </div>
    `;
  }

  function renderMetricProgressCard(label, data, options) {
    const toneClass = getRemainingToneClass(data);
    const percent = round(data?.remainingPercent);
    const statusClass = toneClass ? `is-${toneClass}` : "";
    const detail = options?.detail || "No detail";

    return `
      <div class="card metric-progress-card ${toneClass || ""}">
        <div class="eyebrow">${escapeHtml(label)}</div>
        <div class="metric-row">
          <div class="metric">${escapeHtml(String(percent))}%</div>
          <div class="metric-side">${percent}% left</div>
        </div>
        <progress class="metric-progress ${statusClass}" value="${Math.min(percent, 100)}" max="100"></progress>
        <p class="subtle">${escapeHtml(detail)}</p>
      </div>
    `;
  }

  function renderProgressBlock(label, data, options) {
    const tokenMode = options?.tokenMode || "reset";
    const percentMode = options?.percentMode || "used";
    const percent = round(percentMode === "remaining" ? data?.remainingPercent : data?.usedPercent);
    const toneClass = getToneClass(data);
    const statusClass = toneClass ? `is-${toneClass}` : "";
    const detail = tokenMode === "remaining"
      ? `${round(data?.remainingTokens)} / ${round(data?.limitTokens)} tokens left`
      : tokenMode === "used"
      ? `${round(data?.usedTokens)} / ${round(data?.limitTokens)} tokens`
      : data?.resetAt || "Reset time not set";
    const percentLabel = percentMode === "remaining" ? `${percent}% left` : `${percent}% used`;

    return `
      <div class="progress-block">
        <div class="progress-row">
          <strong>${escapeHtml(label)}</strong>
          <span>${percentLabel}</span>
        </div>
        <div class="progress-track">
          <div class="progress-fill ${statusClass}" style="width: ${Math.min(percent, 100)}%;"></div>
        </div>
        <div class="subtle">${escapeHtml(detail)}</div>
      </div>
    `;
  }

  function renderContextItem(item) {
    return `
      <div class="item">
        <div class="item-head">
          <div>
            <div class="item-title">${escapeHtml(item.title)}</div>
            <div class="item-meta">
              <span>${item.tokens} tokens</span>
              <span>${item.source ? escapeHtml(item.source) : "manual"}</span>
              <span>${item.pinned ? "Pinned" : "Normal"}</span>
            </div>
          </div>
          <div class="actions">
            <button class="button ghost" data-action="toggle-pin" data-id="${item.id}">${item.pinned ? "Unpin" : "Pin"}</button>
            <button class="button ghost" data-action="copy-item" data-id="${item.id}">Copy</button>
            <button class="button ghost" data-action="remove-item" data-id="${item.id}">Remove</button>
          </div>
        </div>
        <div class="item-body">${escapeHtml(item.body)}</div>
      </div>
    `;
  }

  function renderTabButton(id, label) {
    return `<button class="tab ${activeTab === id ? "is-active" : ""}" data-action="open-tab" data-tab="${id}">${label}</button>`;
  }

  function bindEvents() {
    app.querySelectorAll("[data-action='open-tab']").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.preventDefault();
        activeTab = button.getAttribute("data-tab");
        render();
      });
    });

    bindButton("add-context", () => {
      const title = getValue("context-title");
      const body = getValue("context-body");
      if (!body.trim()) {
        return;
      }

      vscode.postMessage({
        type: "addContext",
        title,
        body
      });
    });

    bindButton("capture-selection", () => {
      vscode.postMessage({ type: "captureSelection" });
    });

    bindButton("copy-compiled", () => {
      vscode.postMessage({ type: "copyCompiledContext" });
    });

    bindButton("save-usage", () => {
      const sessionRemainingPercent = clampPercent(getValue("session-used"));
      const weeklyRemainingPercent = clampPercent(getValue("weekly-used"));
      vscode.postMessage({
        type: "saveUsage",
        sessionUsedPercent: 100 - sessionRemainingPercent,
        sessionResetAt: getValue("session-reset"),
        weeklyUsedPercent: 100 - weeklyRemainingPercent,
        weeklyResetAt: getValue("weekly-reset"),
        extraUsageEnabled: getChecked("extra-usage-enabled"),
        extraUsageLabel: getValue("extra-usage-label")
      });
    });

    bindButton("save-config", () => {
      vscode.postMessage({
        type: "saveConfig",
        contextLimitTokens: getValue("context-limit"),
        contextBaseTokens: getValue("context-base"),
        contextWarnAtPercent: getValue("context-warn")
      });
    });

    bindButton("open-settings", () => {
      vscode.postMessage({ type: "openSettings" });
    });

    bindButton("reveal-panel", () => {
      vscode.postMessage({ type: "revealPanel" });
    });

    bindButton("refresh-usage", () => {
      vscode.postMessage({ type: "refreshUsage" });
    });

    app.querySelectorAll("[data-action='toggle-pin']").forEach((button) => {
      button.addEventListener("click", () => {
        vscode.postMessage({
          type: "togglePin",
          id: button.getAttribute("data-id")
        });
      });
    });

    app.querySelectorAll("[data-action='copy-item']").forEach((button) => {
      button.addEventListener("click", () => {
        vscode.postMessage({
          type: "copyItem",
          id: button.getAttribute("data-id")
        });
      });
    });

    app.querySelectorAll("[data-action='remove-item']").forEach((button) => {
      button.addEventListener("click", () => {
        vscode.postMessage({
          type: "removeContext",
          id: button.getAttribute("data-id")
        });
      });
    });
  }

  function bindButton(action, handler) {
    const button = app.querySelector(`[data-action='${action}']`);
    if (!button) {
      return;
    }
    button.addEventListener("click", handler);
  }

  function getValue(id) {
    const element = document.getElementById(id);
    return element ? element.value : "";
  }

  function getChecked(id) {
    const element = document.getElementById(id);
    return element ? element.checked : false;
  }

  function round(value) {
    return Math.round(Number(value) || 0);
  }

  function clampPercent(value) {
    return Math.max(0, Math.min(100, round(value)));
  }

  function getToneClass(data) {
    if (data?.status === "danger") {
      return "danger";
    }
    if (data?.status === "warn") {
      return "warn";
    }
    return "ok";
  }

  function getRemainingToneClass(data) {
    const percent = round(data?.remainingPercent);
    if (percent <= 20) {
      return "danger";
    }
    if (percent <= 50) {
      return "warn";
    }
    return "ok";
  }

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function escapeAttribute(value) {
    return escapeHtml(value).replace(/\n/g, " ");
  }
})();
