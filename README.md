# Syncro Tickets Tampermonkey Helper

Tampermonkey userscripts that improve day-to-day ticket handling in Syncro by adding faster time entry tools, copy helpers, sticky header behavior, comment workflow enhancements, and Copilot-ready ticket assist prompts.

## What This Script Does

These scripts enhance Syncro ticket pages for the Syncro tenant domains:

- `https://*.syncromsp.com/tickets/*`
- `https://*.shield.syncromsp.com/tickets/*`

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

### Canned Response Subject Matching (How It Works)

The right-click menu in the comment editor can show canned responses based on the currently selected comment subject.

How the script filters canned responses:

- Right-click inside the comment editor (`.note-editable` or `#comment_body`) to open the custom menu.
- The script reads the current value of the comment subject field (`#comment_subject`).
- If a comment subject is selected, only canned responses with a matching subject are shown.
- Matching is case-insensitive, but it is an exact text match (not partial/contains).
- If the comment subject field is blank, the script shows all canned responses that have a valid canned body.

How to configure canned responses in Syncro:

1. Open your canned response list in Syncro and edit/create a canned response.
2. Set the canned response Subject/Matching Subject to the exact same subject value technicians choose in the ticket comment subject field.
3. Save the canned response body content normally.
4. In a ticket, choose that same comment subject first, then right-click in the editor to see matching canned entries.

Important behavior notes:

- If no canned entries appear, first confirm a comment subject is selected and that the canned response subject matches exactly.
- Canned entries without a mapped subject will not appear when a subject is selected.
- The menu always includes Copy/Cut/Paste; the Canned responses section appears only when matching entries are found.
- The script inserts the full canned response body (decoded from HTML entities), so formatting/content is preserved better than truncated table text.

### Reliability and Performance Improvements

- Mutation filtering to reduce unnecessary reinjection cycles
- Per-step injection isolation (one failing feature does not block others)
- Polling bootstrap that exits early when features are loaded
- Per-cycle widget lookup cache to reduce repeated DOM scans
- Empty-copy guards to avoid copying blank values

### Copilot Assist (Separate Script)

- Adds a **Copilot Assist** button to ticket pages
- Collects key ticket context (ticket number, subject, status, priority, assignee, customer/contact info, latest comment snippet, link)
- Builds a structured prompt for response drafting and diagnosis support
- Copies the prompt to clipboard and opens Copilot in a new tab
- Supports assist modes:
  - Response draft
  - Technical diagnosis
  - Both
- Supports a user-configurable Copilot URL (including custom agents)

### Copilot Assist Usage and URL Configuration

How to use Copilot Assist on a ticket:

1. Click **Copilot Assist** in the ticket action bar.
2. Choose a mode from the dropdown:
  - Both (Response + Diagnosis)
  - Response Draft
  - Diagnosis Help
3. The script copies ticket context to clipboard and opens your configured Copilot URL in a new tab.
4. Paste the prompt into Copilot with `Ctrl+V` (or `Cmd+V` on macOS).

How to configure your Copilot URL:

1. On the ticket page, **Shift+Click** the **Copilot Assist** button.
2. Enter your preferred Copilot URL when prompted.
3. Save to store the URL for your user/browser profile.
4. Leave it blank to clear your preference and return to standard Copilot chat.

Recommended usage with custom agents:

- If your team has a custom Copilot agent, paste that agent's chat URL so Copilot Assist opens directly into your agent experience.
- This is useful for role-specific workflows (helpdesk triage, incident response, escalation assistant, compliance response templates, etc.).
- Each technician can store their own preferred URL independently on their own browser profile.

URL requirements and validation:

- URL must be HTTPS.
- Host must be `m365.cloud.microsoft`.
- Path must begin with `/chat`.
- Invalid URLs are rejected so technicians do not accidentally store malformed/non-Copilot links.

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

### 2. Install a Userscript

This repository contains two userscripts:

- `SyncroTickets.user.js` (main workflow helper)
- `SyncroCopilotAssist.user.js` (Copilot context/prompt helper)

Option A: Install from GitHub raw URL

1. Open a raw script URL in your browser.
2. Tampermonkey will detect and prompt to install.
3. Approve installation.

Direct install URLs for this repository:

`https://raw.githubusercontent.com/gherbstman/SyncroTamperMonkey/main/SyncroTickets.user.js`

`https://raw.githubusercontent.com/gherbstman/SyncroTamperMonkey/main/SyncroCopilotAssist.user.js`

Generic raw URL format:

`https://raw.githubusercontent.com/<owner>/<repo>/<branch>/SyncroTickets.user.js`

`https://raw.githubusercontent.com/<owner>/<repo>/<branch>/SyncroCopilotAssist.user.js`

Option B: Manual install

1. Open Tampermonkey dashboard.
2. Create a new script.
3. Paste contents of `SyncroTickets.user.js` or `SyncroCopilotAssist.user.js`.
4. Save.

## Auto Updates via GitHub HTTP Reference

Tampermonkey can auto-update userscripts when metadata includes `@updateURL` and `@downloadURL` pointing to GitHub raw HTTP endpoints.

Add these lines to each userscript metadata header:

```javascript
// @downloadURL  https://raw.githubusercontent.com/<owner>/<repo>/<branch>/SyncroTickets.user.js
// @updateURL    https://raw.githubusercontent.com/<owner>/<repo>/<branch>/SyncroTickets.user.js
```

```javascript
// @downloadURL  https://raw.githubusercontent.com/<owner>/<repo>/<branch>/SyncroCopilotAssist.user.js
// @updateURL    https://raw.githubusercontent.com/<owner>/<repo>/<branch>/SyncroCopilotAssist.user.js
```

Recommended for this repository:

```javascript
// @downloadURL  https://raw.githubusercontent.com/gherbstman/SyncroTamperMonkey/main/SyncroTickets.user.js
// @updateURL    https://raw.githubusercontent.com/gherbstman/SyncroTamperMonkey/main/SyncroTickets.user.js
```

```javascript
// @downloadURL  https://raw.githubusercontent.com/gherbstman/SyncroTamperMonkey/main/SyncroCopilotAssist.user.js
// @updateURL    https://raw.githubusercontent.com/gherbstman/SyncroTamperMonkey/main/SyncroCopilotAssist.user.js
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

## Credits

- **Nick Fratangelo**: Original concept and initial build of this script. Original project: https://github.com/esperto/Syncro-TamperMonkey
- **Gary Herbstman**: Expanded and optimized the script for internal staff workflows, while keeping features broadly useful for others.

### Credit Details

- Added reliability and performance optimizations for real-world ticket handling.
- Implemented GitHub-based auto-update support via `@downloadURL` and `@updateURL` metadata.
- Wrote and maintained full project documentation for installation, features, and update behavior.
- Continued feature development to improve day-to-day technician efficiency.

## Development

Repository files:

- `SyncroTickets.user.js`: main userscript
- `SyncroCopilotAssist.user.js`: Copilot prompt builder and launcher helper
- `view-source_https___bytesolutions.shield.syncromsp.com_tickets_110818582.html`: page source reference snapshot for selector debugging

## Troubleshooting

- If changes do not appear, do a hard refresh.
- If updates are not detected, verify `@updateURL` and `@downloadURL` values.
- Confirm Tampermonkey script is enabled.
- Check that URL matches one of the `@match` patterns.
- For Copilot Assist, if Copilot does not open automatically, allow popups/new tabs for the site and try again.
- For Copilot Assist URL issues, use **Shift+Click** on the Copilot Assist button to reconfigure the saved URL.
- Ensure configured Copilot URLs follow `https://m365.cloud.microsoft/chat...`.
- For canned responses, ensure the ticket comment subject value exactly matches the canned response matching subject.

## Disclaimer

This script is tailored to specific Syncro page structure and may need updates if Syncro changes its frontend markup or behavior.
