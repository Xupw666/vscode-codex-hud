# Codex HUD

`Codex HUD` is a local VS Code companion extension that adds:

- a status bar summary for session, weekly, and context-window usage
- a bottom panel view for usage bars and quick config
- a background-context manager for storing reusable notes/snippets

## What this first version does

- Shows a status bar entry like `Codex S:42% W:18% Ctx:36%`
- Opens a bottom panel named `Codex HUD`
- Lets you save manual background notes or capture editor selections
- Estimates token cost for stored notes
- Tracks a context-window budget with progress bars
- Lets you manually enter session/week usage and reset labels

## Usage auto-sync

This version can auto-read real usage from your local Codex rollout history in `~/.codex/sessions`.

It extracts:

- current short-window usage
- current weekly usage
- latest thread token usage
- model context window size

`Session` and `Week` come from your real local Codex rollout data.

`Ctx` is different on purpose: it measures the background items managed by this HUD, plus any reserved base tokens you configure. It does not mirror the full cumulative thread token total.

If rollout data is missing, the HUD falls back to manual values from `codexHud.*`.

## Run locally

1. Open the `codex-hud` folder in VS Code.
2. Press `F5` to launch an Extension Development Host.
3. In the new window, open the panel container named `Codex`.
4. Use the status bar item or the command palette:
   `Codex HUD: Open Panel`

## Useful commands

- `Codex HUD: Open Panel`
- `Codex HUD: Refresh Usage from Codex`
- `Codex HUD: Capture Selection as Context`
- `Codex HUD: Set Session Usage`
- `Codex HUD: Set Weekly Usage`
- `Codex HUD: Clear Stored Context`

## Next good upgrade

If you want, the next step can be one of these:

1. Add richer parsing for multiple models / multiple rate-limit buckets.
2. Add a real side panel tree for context packs and folders.
3. Add import/export for context presets by workspace.
