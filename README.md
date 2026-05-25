# Syncro Tickets Tampermonkey Helper

A Tampermonkey userscript that improves day-to-day ticket handling in Syncro by adding faster time entry tools, copy helpers, sticky header behavior, and comment workflow enhancements.

## What This Script Does

This script enhances Syncro ticket pages for the Syncro tenant domains:

- https://*.syncromsp.com/tickets/*
- https://*.shield.syncromsp.com/tickets/*

It is designed for technicians who work tickets all day and need fewer clicks for repetitive actions.

## Features

### Time and Duration Helpers

- Smart duration parsing and normalization in helper bars:
  - `25m`, `2h`, `1.5`, `1:25`
  - Mixed hour/minute text values
- Duration presets: `5m`, `10m`, `15m`, `30m`, `45m`, `1h`, `1.5h`, `2h`
- Smart duration field entry controls:
  - Mouse wheel on duration input: +/- 5 minutes
  - Arrow Up/Down: +/- 15 minutes
  - Shift + Arrow Up/Down: +/- 30 minutes
  - Enter to apply duration
  - Escape to clear duration input
- Auto duration application logic:
  - If `From` is populated, script calculates and sets `To`
  - If `From` is blank, script sets `To` to now and back-calculates `From`
- Labor Log helper bar (React/MUI form)
- Comment form helper bar (Bootstrap/jQuery form)
- Time field controls (start/end fields):
  - Arrow Up/Down: +/- 1 minute
  - Shift + Arrow Up/Down: +/- 5 minutes
  - Ctrl or Alt + Arrow Up/Down: +/- 60 minutes
  - Mouse wheel: +/- 5 minutes
- Product/service select wheel support:
  - Mouse wheel cycles selected option and dispatches change event
- Date wheel support:
  - Mouse wheel adjusts date by +/- 1 day
  - Uses datepicker API when available, with native fallback

### Ticket Copy Actions

- Top-row quick copy buttons:
  - Copy URL
  - Copy TSU (ticket number + subject + URL)
  - Copy Details (formatted summary)
- Click ticket heading to copy ticket number
- Customer info copy support from field icons:
  - Customer
  - Assigned contact
  - Email
  - Phone
  - Contact mobile
  - Primary address
  - Ticket address
- Empty-copy guards to prevent copying blank values

### Ticket UI Enhancements

- Sticky multi-row ticket header region for easier scrolling
- WoC button to submit comment and set status to Waiting on Customer
- Context menu in comment editor with canned responses
- Ticket number copy from heading click
- Native browser tooltips for script-added controls

### Comment Editor Context Menu Enhancements

- Custom right-click menu inside comment editor
- Built-in Copy/Cut/Paste actions
- Subject-aware canned response insertion
- Uses full canned body from `data-body` attributes (HTML-decoded)

### Reliability and Performance Improvements

- Mutation filtering to reduce unnecessary reinjection cycles
- Per-step injection isolation (one failing feature does not block others)
- Polling bootstrap that exits early when features are loaded
- Per-cycle widget lookup cache to reduce repeated DOM scans
- Empty-copy guards to avoid copying blank values

## Requirements

- Google Chrome, Microsoft Edge, or Firefox
- Tampermonkey browser extension
- Access to the target Syncro tenant URLs
- Permission to run userscripts in the browser

## Installation

### 1. Install Tampermonkey

Install Tampermonkey from the browser extension store:

- Chrome Web Store
- Microsoft Edge Add-ons
- Firefox Add-ons

### 2. Install the Userscript

Option A: Install from GitHub raw URL

1. Open the raw script URL in your browser.
2. Tampermonkey will detect and prompt to install.
3. Approve installation.

Example raw URL format:

`https://raw.githubusercontent.com/<owner>/<repo>/<branch>/SyncroTickets.user.js`

Option B: Manual install

1. Open Tampermonkey dashboard.
2. Create a new script.
3. Paste contents of `SyncroTickets.user.js`.
4. Save.

## Auto Updates via GitHub HTTP Reference

Tampermonkey can auto-update userscripts when metadata includes `@updateURL` and `@downloadURL` pointing to GitHub raw HTTP endpoints.

Add these lines to the userscript metadata header (top of `SyncroTickets.user.js`):

```javascript
// @downloadURL  https://raw.githubusercontent.com/<owner>/<repo>/<branch>/SyncroTickets.user.js
// @updateURL    https://raw.githubusercontent.com/<owner>/<repo>/<branch>/SyncroTickets.user.js
```

Recommended for this repository homepage reference:

```javascript
// @downloadURL  https://raw.githubusercontent.com/esperto/Syncro-TamperMonkey/main/SyncroTickets.user.js
// @updateURL    https://raw.githubusercontent.com/esperto/Syncro-TamperMonkey/main/SyncroTickets.user.js
```

If the repository uses `master` instead of `main`, replace `main` with `master`.

After this is set, Tampermonkey will check for updates according to its configured update interval.

## Access and Scope Control

The userscript is intentionally scoped with `@match` entries to Syncro ticket pages only.

Current scope:

```javascript
// @match        https://*.syncromsp.com/tickets/*
// @match        https://*.shield.syncromsp.com/tickets/*
```

To enable additional Syncro tenant domains, add additional `@match` lines.

## Development

Repository files:

- `SyncroTickets.user.js`: main userscript
- `view-source_https___bytesolutions.shield.syncromsp.com_tickets_110818582.html`: page source reference snapshot for selector debugging

## Troubleshooting

- If changes do not appear, do a hard refresh.
- If updates are not detected, verify `@updateURL` and `@downloadURL` values.
- Confirm Tampermonkey script is enabled.
- Check that URL matches one of the `@match` patterns.

## Disclaimer

This script is tailored to specific Syncro page structure and may need updates if Syncro changes its frontend markup or behavior.
