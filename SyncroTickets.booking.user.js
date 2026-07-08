// ==UserScript==
// @name         Syncro – Ticket Bookings
// @homepageURL  https://github.com/gherbstman/SyncroTamperMonkey
// @namespace    http://tampermonkey.net/
// @version      1.2.0
// @description  Replaces vendor appointment action with Microsoft Bookings dropdown and provides bookings config/import.
// @author       Gary Herbstman
// @match        https://*.syncromsp.com/tickets/*
// @match        https://*.shield.syncromsp.com/tickets/*
// @grant        GM_getValue
// @grant        GM_setValue
// @downloadURL  https://raw.githubusercontent.com/gherbstman/SyncroTamperMonkey/main/SyncroTickets.booking.user.js
// @updateURL    https://raw.githubusercontent.com/gherbstman/SyncroTamperMonkey/main/SyncroTickets.booking.user.js
// ==/UserScript==

(function () {
  "use strict";

  var BOOKING_LINKS_STORAGE_KEY = "tmBookingLinksConfig";
  var BOOKING_DEFAULT_INTRO_TEXT = "Use the link below to schedule time with the assigned engineer.";
  var BOOKING_MENU_ID = "tm-booking-links-menu";
  var BOOKING_APPOINTMENT_BUTTON_ID = "tm-booking-appointment-btn";
  var BOOKING_CONFIG_BUTTON_ID = "tm-booking-config-btn";
  var BOOKING_CONFIG_MENU_ID = "tm-booking-config-menu";
  var BOOKING_IMPORT_INPUT_ID = "tm-booking-import-input";

  function safeText(el) {
    return el ? String(el.textContent || "").replace(/\s+/g, " ").trim() : "";
  }

  function getTicketIdFromPath() {
    var m = window.location.pathname.match(/\/tickets\/(\d+)/);
    return m ? m[1] : null;
  }

  function getTicketInfoField(label) {
    var widgets = document.querySelectorAll(".widget-header h3");
    var ticketInfo = null;
    for (var i = 0; i < widgets.length; i++) {
      if (safeText(widgets[i]) === "Ticket Info") {
        ticketInfo = widgets[i].closest(".widget");
        break;
      }
    }
    if (!ticketInfo) return "";

    var ths = ticketInfo.querySelectorAll("th");
    for (var j = 0; j < ths.length; j++) {
      if (safeText(ths[j]) === label) {
        var td = ths[j].nextElementSibling;
        return td ? safeText(td) : "";
      }
    }
    return "";
  }

  function getAssignee() {
    var ticketId = getTicketIdFromPath();
    if (ticketId) {
      var el = document.getElementById("best_in_place_ticket_" + ticketId + "_user_id");
      var txt = safeText(el);
      if (txt) return txt;
    }
    return getTicketInfoField("Assignee");
  }

  function injectStyle(css, styleId) {
    var id = styleId || "tm-booking-style";
    if (document.getElementById(id)) return;
    var s = document.createElement("style");
    s.id = id;
    s.type = "text/css";
    s.textContent = css;
    document.head.appendChild(s);
  }

  function createMiniButton(label, title) {
    var button = document.createElement("button");
    button.type = "button";
    button.className = "btn btn-default btn-xs tm-mini-btn";
    button.textContent = label;
    button.setAttribute("title", title || "");
    button.style.padding = "2px 6px";
    button.style.lineHeight = "1.2";
    return button;
  }

  function readStoredJson(key, fallbackValue) {
    var fallback = typeof fallbackValue === "undefined" ? null : fallbackValue;

    try {
      if (typeof GM_getValue === "function") {
        var gmValue = GM_getValue(key, null);
        if (gmValue !== null && typeof gmValue !== "undefined") {
          if (typeof gmValue === "string") {
            try { return JSON.parse(gmValue); } catch (parseErr) { return fallback; }
          }
          return gmValue;
        }
      }
    } catch (e) {}

    try {
      var raw = window.localStorage.getItem(key);
      if (raw === null) return fallback;
      return JSON.parse(raw);
    } catch (e2) {
      return fallback;
    }
  }

  function writeStoredJson(key, value) {
    var json;
    try {
      json = JSON.stringify(value);
    } catch (e) {
      return false;
    }

    try {
      if (typeof GM_setValue === "function") {
        GM_setValue(key, json);
        return true;
      }
    } catch (e2) {}

    try {
      window.localStorage.setItem(key, json);
      return true;
    } catch (e3) {
      return false;
    }
  }

  function normalizeBookingText(value) {
    return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
  }

  function escapeHtml(text) {
    return String(text || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function getStoredBookingLinksConfig() {
    var cfg = readStoredJson(BOOKING_LINKS_STORAGE_KEY, null);
    var introText = BOOKING_DEFAULT_INTRO_TEXT;
    if (cfg && typeof cfg.introText === "string" && String(cfg.introText || "").trim()) {
      introText = String(cfg.introText || "").trim();
    }

    if (!cfg || !cfg.rows || !cfg.rows.length) return { introText: introText, rows: [] };

    var rows = [];
    for (var i = 0; i < cfg.rows.length; i++) {
      var row = cfg.rows[i] || {};
      rows.push({
        engineerName: String(row.engineerName || "").trim(),
        pullDownDescription: String(row.pullDownDescription || "").trim(),
        linkTextHtml: String(row.linkTextHtml || "").trim(),
        bookingLink: String(row.bookingLink || "").trim()
      });
    }
    return { introText: introText, rows: rows };
  }

  function setStoredBookingLinksConfig(cfg) {
    var introText = BOOKING_DEFAULT_INTRO_TEXT;
    if (cfg && typeof cfg.introText === "string" && String(cfg.introText || "").trim()) {
      introText = String(cfg.introText || "").trim();
    }

    var safeRows = [];
    var rows = cfg && cfg.rows ? cfg.rows : [];
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i] || {};
      var engineerName = String(row.engineerName || "").trim();
      var pullDownDescription = String(row.pullDownDescription || "").trim();
      var linkTextHtml = String(row.linkTextHtml || "").trim();
      var bookingLink = String(row.bookingLink || "").trim();
      if (!engineerName && !pullDownDescription && !linkTextHtml && !bookingLink) continue;
      safeRows.push({
        engineerName: engineerName,
        pullDownDescription: pullDownDescription,
        linkTextHtml: linkTextHtml,
        bookingLink: bookingLink
      });
    }

    return writeStoredJson(BOOKING_LINKS_STORAGE_KEY, { introText: introText, rows: safeRows });
  }

  function getBookingIntroText() {
    var cfg = getStoredBookingLinksConfig();
    return String((cfg && cfg.introText) || BOOKING_DEFAULT_INTRO_TEXT).trim() || BOOKING_DEFAULT_INTRO_TEXT;
  }

  function showToast(message, isError) {
    var toast = document.getElementById("tm-toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.id = "tm-toast";
      Object.assign(toast.style, {
        position: "fixed",
        right: "18px",
        bottom: "18px",
        zIndex: "330000",
        minWidth: "220px",
        maxWidth: "420px",
        padding: "10px 12px",
        borderRadius: "8px",
        boxShadow: "0 8px 20px rgba(0,0,0,0.22)",
        color: "#fff",
        font: "13px 'Segoe UI', Arial, sans-serif",
        opacity: "0",
        transform: "translateY(8px)",
        transition: "opacity 0.15s ease, transform 0.15s ease",
        pointerEvents: "none"
      });
      document.body.appendChild(toast);
    }

    toast.textContent = String(message || "");
    toast.style.background = isError ? "#8b1e1e" : "#1f6b3a";
    toast.style.opacity = "1";
    toast.style.transform = "translateY(0)";

    if (toast.__tmHideTimer) window.clearTimeout(toast.__tmHideTimer);
    toast.__tmHideTimer = window.setTimeout(function () {
      toast.style.opacity = "0";
      toast.style.transform = "translateY(8px)";
    }, 2200);
  }

  function normalizeBookingCsvHeader(value) {
    return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  }

  function parseCsvText(csvText) {
    var text = String(csvText || "");
    var rows = [];
    var row = [];
    var current = "";
    var inQuotes = false;

    for (var i = 0; i < text.length; i++) {
      var ch = text.charAt(i);

      if (inQuotes) {
        if (ch === '"') {
          if (text.charAt(i + 1) === '"') {
            current += '"';
            i++;
          } else {
            inQuotes = false;
          }
        } else {
          current += ch;
        }
        continue;
      }

      if (ch === '"') {
        inQuotes = true;
        continue;
      }

      if (ch === ',') {
        row.push(current);
        current = "";
        continue;
      }

      if (ch === '\r') continue;

      if (ch === '\n') {
        row.push(current);
        rows.push(row);
        row = [];
        current = "";
        continue;
      }

      current += ch;
    }

    row.push(current);
    if (row.length > 1 || row[0] !== "") rows.push(row);
    return rows;
  }

  function parseBookingCsvRows(csvText) {
    var parsed = parseCsvText(csvText);
    if (!parsed.length) return [];

    var headerRow = parsed[0];
    var headers = [];
    for (var hi = 0; hi < headerRow.length; hi++) headers.push(normalizeBookingCsvHeader(headerRow[hi]));

    var indexByField = {
      engineerName: headers.indexOf("engineername"),
      pullDownDescription: headers.indexOf("pulldowndescription"),
      linkTextHtml: headers.indexOf("linktexthtml"),
      bookingLink: headers.indexOf("bookinglink")
    };

    if (indexByField.engineerName === -1 || indexByField.pullDownDescription === -1 || indexByField.linkTextHtml === -1 || indexByField.bookingLink === -1) {
      throw new Error("CSV headers must include engineerName, pullDownDescription, linkTextHtml, and bookingLink.");
    }

    var rows = [];
    for (var ri = 1; ri < parsed.length; ri++) {
      var values = parsed[ri] || [];
      var row = {
        engineerName: String(values[indexByField.engineerName] || "").trim(),
        pullDownDescription: String(values[indexByField.pullDownDescription] || "").trim(),
        linkTextHtml: String(values[indexByField.linkTextHtml] || "").trim(),
        bookingLink: String(values[indexByField.bookingLink] || "").trim()
      };
      if (!row.engineerName && !row.pullDownDescription && !row.linkTextHtml && !row.bookingLink) continue;
      rows.push(row);
    }

    return rows;
  }

  function ensureBookingImportInput() {
    var input = document.getElementById(BOOKING_IMPORT_INPUT_ID);
    if (input) return input;

    input = document.createElement("input");
    input.id = BOOKING_IMPORT_INPUT_ID;
    input.type = "file";
    input.accept = ".csv,text/csv";
    input.style.display = "none";
    input.addEventListener("change", function () {
      var file = input.files && input.files[0] ? input.files[0] : null;
      if (!file) return;

      var reader = new FileReader();
      reader.onload = function () {
        try {
          var rows = parseBookingCsvRows(reader.result);
          setStoredBookingLinksConfig({
            introText: getBookingIntroText(),
            rows: rows
          });
          showToast("Imported " + rows.length + " booking rows from CSV.", false);
        } catch (err) {
          showToast("CSV import failed: " + (err && err.message ? err.message : "Invalid file."), true);
        } finally {
          input.value = "";
        }
      };
      reader.onerror = function () {
        input.value = "";
        showToast("CSV import failed while reading the file.", true);
      };
      reader.readAsText(file);
    });
    document.body.appendChild(input);
    return input;
  }

  function triggerBookingCsvImport() {
    ensureBookingImportInput().click();
  }

  function getBookingRows() {
    var cfg = getStoredBookingLinksConfig();
    return cfg && cfg.rows ? cfg.rows : [];
  }

  function getBookingDurationSortKey(row) {
    var text = String((row && (row.pullDownDescription || row.linkTextHtml)) || "");
    var match = text.match(/(\d{1,3})\s*(?:m|min|mins|minute|minutes)\b/i);
    if (match) return parseInt(match[1], 10) || 9999;
    match = text.match(/\b(\d{1,3})\b/);
    if (match) return parseInt(match[1], 10) || 9999;
    return 9999;
  }

  function getCurrentEngineerName() {
    return normalizeBookingText(getAssignee());
  }

  function groupBookingRowsForTicket() {
    var rows = getBookingRows();
    var grouped = {};
    var currentEngineer = getCurrentEngineerName();

    for (var i = 0; i < rows.length; i++) {
      var row = rows[i] || {};
      var engineerName = String(row.engineerName || "").trim();
      if (!engineerName) continue;
      var key = normalizeBookingText(engineerName);
      if (!key) continue;
      if (!grouped[key]) {
        grouped[key] = {
          engineerName: engineerName,
          rows: []
        };
      }
      grouped[key].rows.push({
        engineerName: engineerName,
        pullDownDescription: String(row.pullDownDescription || "").trim(),
        linkTextHtml: String(row.linkTextHtml || "").trim(),
        bookingLink: String(row.bookingLink || "").trim()
      });
    }

    var keys = Object.keys(grouped);
    keys.sort(function (a, b) {
      if (a === currentEngineer) return -1;
      if (b === currentEngineer) return 1;
      var nameA = grouped[a].engineerName.toLowerCase();
      var nameB = grouped[b].engineerName.toLowerCase();
      if (nameA < nameB) return -1;
      if (nameA > nameB) return 1;
      return 0;
    });

    for (var ki = 0; ki < keys.length; ki++) {
      grouped[keys[ki]].rows.sort(function (left, right) {
        var leftKey = getBookingDurationSortKey(left);
        var rightKey = getBookingDurationSortKey(right);
        if (leftKey !== rightKey) return leftKey - rightKey;
        var leftLabel = String(left.pullDownDescription || left.linkTextHtml || "").toLowerCase();
        var rightLabel = String(right.pullDownDescription || right.linkTextHtml || "").toLowerCase();
        if (leftLabel < rightLabel) return -1;
        if (leftLabel > rightLabel) return 1;
        return 0;
      });
    }

    return {
      currentEngineer: currentEngineer,
      grouped: grouped,
      keys: keys
    };
  }

  function buildBookingInsertPayload(row) {
    var introText = getBookingIntroText();
    var label = String((row && row.linkTextHtml) || "").trim();
    var url = String((row && row.bookingLink) || "").trim();
    if (!label || !url) return null;

    var introHtml = escapeHtml(introText).replace(/\r?\n/g, "<br>");
    return {
      html: '<div>' + introHtml + '</div><div><a href="' + escapeHtml(url) + '">' + label + '</a></div>',
      text: introText + "\n" + label + ": " + url
    };
  }

  function insertBookingLinkIntoComment(payload) {
    var editor = document.querySelector(".note-editable") || document.getElementById("comment_body");
    if (!editor) return false;

    editor.focus();
    var htmlText = payload && typeof payload.html === "string" ? payload.html : String(payload || "");
    var plainText = payload && typeof payload.text === "string" ? payload.text : htmlText;
    var looksHtml = /<\/?[a-z][\s\S]*>/i.test(htmlText);

    if (editor.isContentEditable) {
      if (looksHtml) document.execCommand("insertHTML", false, htmlText);
      else document.execCommand("insertText", false, plainText);
      return true;
    }

    var start = typeof editor.selectionStart === "number" ? editor.selectionStart : 0;
    var end = typeof editor.selectionEnd === "number" ? editor.selectionEnd : start;
    var value = editor.value || "";
    editor.value = value.slice(0, start) + plainText + value.slice(end);
    editor.selectionStart = editor.selectionEnd = start + plainText.length;
    editor.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  }

  function closeBookingMenu() {
    var existing = document.getElementById(BOOKING_MENU_ID);
    if (existing) existing.style.display = "none";
  }

  function showBookingLinksSettingsModal() {
    var existing = document.getElementById("tm-booking-settings-overlay");
    if (existing) existing.remove();

    var style = document.getElementById("tm-booking-settings-styles");
    if (!style) {
      style = document.createElement("style");
      style.id = "tm-booking-settings-styles";
      style.textContent = [
        "#tm-booking-settings-overlay { position: fixed; inset: 0; z-index: 320000; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; }",
        "#tm-booking-settings-panel { background: #fff; border-radius: 8px; box-shadow: 0 8px 32px rgba(0,0,0,0.3); width: min(1100px, 96vw); max-height: 90vh; display: flex; flex-direction: column; font-family: 'Segoe UI', Arial, sans-serif; font-size: 13px; }",
        "#tm-booking-settings-header { display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; background: #1f4f1f; border-radius: 8px 8px 0 0; }",
        "#tm-booking-settings-header span { color: #fff; font-weight: 700; font-size: 14px; }",
        "#tm-booking-settings-header button { background: rgba(255,255,255,0.15); border: 1px solid rgba(255,255,255,0.3); color: #fff; border-radius: 4px; cursor: pointer; padding: 3px 9px; font-size: 12px; }",
        "#tm-booking-settings-body { padding: 16px 18px; overflow-y: auto; }",
        "#tm-booking-settings-body p { margin-top: 0; color: #444; line-height: 1.4; }",
        ".tm-booking-table { width: 100%; border-collapse: collapse; table-layout: fixed; }",
        ".tm-booking-table th, .tm-booking-table td { border: 1px solid #d9dce3; padding: 8px; vertical-align: top; }",
        ".tm-booking-table th { background: #f6f7fa; text-align: left; font-size: 12px; }",
        ".tm-booking-table input, .tm-booking-table textarea { width: 100%; box-sizing: border-box; font: inherit; border: 1px solid #c0c4cc; border-radius: 4px; padding: 6px 8px; }",
        ".tm-booking-table textarea { min-height: 60px; resize: vertical; }",
        ".tm-booking-table .tm-booking-actions { width: 74px; }",
        ".tm-booking-row-remove { width: 100%; border: 1px solid #c0c4cc; border-radius: 4px; background: #fff; cursor: pointer; color: #8b1e1e; padding: 6px 8px; }",
        ".tm-booking-add-row { margin-top: 10px; }",
        "#tm-booking-settings-footer { padding: 10px 16px; border-top: 1px solid #e0e0e0; display: flex; gap: 8px; justify-content: flex-end; background: #f7f8fb; border-radius: 0 0 8px 8px; }",
        "#tm-booking-settings-footer button { padding: 6px 16px; border-radius: 4px; cursor: pointer; border: 1px solid #c0c4cc; background: #fff; font-size: 12px; font-weight: 500; color: #333; }",
        "#tm-booking-settings-footer .tm-booking-save { background: #1f4f1f; color: #fff; border-color: #1f4f1f; }",
        "#tm-booking-settings-footer .tm-booking-save:hover { background: #2a6b2a; }"
      ].join("\n");
      document.head.appendChild(style);
    }

    var overlay = document.createElement("div");
    overlay.id = "tm-booking-settings-overlay";

    var panel = document.createElement("div");
    panel.id = "tm-booking-settings-panel";

    var header = document.createElement("div");
    header.id = "tm-booking-settings-header";
    var headerTitle = document.createElement("span");
    headerTitle.textContent = "Booking Link Configuration";
    var headerClose = document.createElement("button");
    headerClose.textContent = "\u2715";
    headerClose.addEventListener("click", function () { overlay.remove(); });
    header.appendChild(headerTitle);
    header.appendChild(headerClose);

    var body = document.createElement("div");
    body.id = "tm-booking-settings-body";
    body.innerHTML = "<p>Each row defines one engineer booking option. Keep three rows per engineer for 15, 30, and 60 minutes. The dropdown will place the current ticket assignee first, then the remaining engineers alphabetically.</p>";

    var introWrap = document.createElement("div");
    introWrap.style.marginBottom = "14px";

    var introLabel = document.createElement("label");
    introLabel.textContent = "Introductory text pasted above the booking link";
    introLabel.style.display = "block";
    introLabel.style.fontWeight = "600";
    introLabel.style.marginBottom = "6px";

    function makeTextarea(value, placeholder) {
      var input = document.createElement("textarea");
      input.value = String(value || "");
      input.placeholder = placeholder || "";
      return input;
    }

    function makeTextInput(value, placeholder) {
      var input = document.createElement("input");
      input.type = "text";
      input.value = String(value || "");
      input.placeholder = placeholder || "";
      return input;
    }

    var introInput = makeTextarea(getBookingIntroText(), "Short explanation shown above the inserted booking link");
    introInput.style.minHeight = "72px";

    var introHint = document.createElement("div");
    introHint.style.marginTop = "6px";
    introHint.style.color = "#666";
    introHint.style.fontSize = "12px";
    introHint.textContent = "Default: " + BOOKING_DEFAULT_INTRO_TEXT;

    introWrap.appendChild(introLabel);
    introWrap.appendChild(introInput);
    introWrap.appendChild(introHint);
    body.appendChild(introWrap);

    var table = document.createElement("table");
    table.className = "tm-booking-table";

    var thead = document.createElement("thead");
    thead.innerHTML = "<tr><th>Engineer Name</th><th>Pull-down Description</th><th>Link Text HTML</th><th>Booking Link</th><th class='tm-booking-actions'>Action</th></tr>";
    table.appendChild(thead);

    var tbody = document.createElement("tbody");
    table.appendChild(tbody);

    function addBookingRow(row) {
      var tr = document.createElement("tr");

      var engineerCell = document.createElement("td");
      var engineerInput = makeTextInput(row && row.engineerName, "Engineer name");
      engineerCell.appendChild(engineerInput);

      var descCell = document.createElement("td");
      var descInput = makeTextInput(row && row.pullDownDescription, "e.g. 15 min booking");
      descCell.appendChild(descInput);

      var htmlCell = document.createElement("td");
      var htmlInput = makeTextarea(row && row.linkTextHtml, "e.g. Book 15 min support");
      htmlCell.appendChild(htmlInput);

      var linkCell = document.createElement("td");
      var linkInput = makeTextarea(row && row.bookingLink, "https://bookings.microsoft.com/...");
      linkCell.appendChild(linkInput);

      var actionCell = document.createElement("td");
      actionCell.className = "tm-booking-actions";
      var removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "tm-booking-row-remove";
      removeBtn.textContent = "Remove";
      removeBtn.addEventListener("click", function () {
        if (tr.parentNode) tr.parentNode.removeChild(tr);
      });
      actionCell.appendChild(removeBtn);

      tr.appendChild(engineerCell);
      tr.appendChild(descCell);
      tr.appendChild(htmlCell);
      tr.appendChild(linkCell);
      tr.appendChild(actionCell);
      tbody.appendChild(tr);
    }

    var storedRows = getBookingRows();
    if (storedRows.length) {
      for (var sri = 0; sri < storedRows.length; sri++) addBookingRow(storedRows[sri]);
    } else {
      addBookingRow({});
      addBookingRow({});
      addBookingRow({});
    }

    var addRowBtn = document.createElement("button");
    addRowBtn.type = "button";
    addRowBtn.className = "btn btn-default btn-xs tm-booking-add-row";
    addRowBtn.textContent = "+ Add Row";
    addRowBtn.addEventListener("click", function () { addBookingRow({}); });

    body.appendChild(table);
    body.appendChild(addRowBtn);

    var footer = document.createElement("div");
    footer.id = "tm-booking-settings-footer";

    var onEsc = function (e) {
      if (e.key === "Escape") closeModal();
    };

    function closeModal() {
      document.removeEventListener("keydown", onEsc);
      if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
    }

    var cancelBtn = document.createElement("button");
    cancelBtn.textContent = "Cancel";
    cancelBtn.addEventListener("click", function () { closeModal(); });

    var saveBtn = document.createElement("button");
    saveBtn.textContent = "Save Settings";
    saveBtn.className = "tm-booking-save";
    saveBtn.addEventListener("click", function () {
      var rows = tbody.querySelectorAll("tr");
      var next = [];
      for (var i = 0; i < rows.length; i++) {
        var cells = rows[i].querySelectorAll("td");
        if (cells.length < 4) continue;
        var engineer = cells[0].querySelector("input");
        var desc = cells[1].querySelector("input");
        var html = cells[2].querySelector("textarea");
        var link = cells[3].querySelector("textarea");
        next.push({
          engineerName: String((engineer && engineer.value) || "").trim(),
          pullDownDescription: String((desc && desc.value) || "").trim(),
          linkTextHtml: String((html && html.value) || "").trim(),
          bookingLink: String((link && link.value) || "").trim()
        });
      }
      setStoredBookingLinksConfig({
        introText: String((introInput && introInput.value) || "").trim() || BOOKING_DEFAULT_INTRO_TEXT,
        rows: next
      });
      closeModal();
      showToast("Booking links saved.", false);
    });

    footer.appendChild(cancelBtn);
    footer.appendChild(saveBtn);

    panel.appendChild(header);
    panel.appendChild(body);
    panel.appendChild(footer);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    overlay.addEventListener("click", function (e) { if (e.target === overlay) closeModal(); });
    document.addEventListener("keydown", onEsc);
  }

  function ensureBookingSelectionMenu() {
    var menu = document.getElementById(BOOKING_MENU_ID);
    if (menu) return menu;

    injectStyle(
      "#" + BOOKING_MENU_ID + " { position: fixed; z-index: 100010; min-width: 320px; max-width: min(92vw, 520px); background: #fff; border: 1px solid #d9dce3; box-shadow: 0 6px 18px rgba(0,0,0,.18); border-radius: 6px; padding: 6px; display: none; font-family: 'Segoe UI', Arial, sans-serif; font-size: 13px; }" +
      "#" + BOOKING_MENU_ID + " .tm-booking-head { padding: 6px 10px; font-weight: 700; color: #444; }" +
      "#" + BOOKING_MENU_ID + " .tm-booking-subhead { padding: 2px 10px 6px; color: #666; font-size: 12px; }" +
      "#" + BOOKING_MENU_ID + " .tm-booking-group { padding-top: 4px; margin-top: 4px; border-top: 1px solid #e6e9ef; }" +
      "#" + BOOKING_MENU_ID + " .tm-booking-group:first-of-type { border-top: 0; margin-top: 0; padding-top: 0; }" +
      "#" + BOOKING_MENU_ID + " .tm-booking-group-title { padding: 4px 10px; font-size: 12px; font-weight: 700; color: #1f4f1f; }" +
      "#" + BOOKING_MENU_ID + " .tm-booking-item { display: block; width: 100%; text-align: left; padding: 6px 10px; border: 0; background: transparent; cursor: pointer; border-radius: 4px; }" +
      "#" + BOOKING_MENU_ID + " .tm-booking-item:hover { background: #eef2f7; }" +
      "#" + BOOKING_MENU_ID + " .tm-booking-actions { margin-top: 6px; padding-top: 6px; border-top: 1px solid #e6e9ef; display: flex; gap: 6px; justify-content: flex-end; }" +
      "#" + BOOKING_MENU_ID + " .tm-booking-actions button { padding: 5px 10px; border-radius: 4px; border: 1px solid #c0c4cc; background: #fff; cursor: pointer; font-size: 12px; }",
      "tm-booking-links-style"
    );

    menu = document.createElement("div");
    menu.id = BOOKING_MENU_ID;
    document.body.appendChild(menu);
    return menu;
  }

  function renderBookingSelectionMenu(button, emptyHint) {
    var menu = ensureBookingSelectionMenu();
    var grouped = groupBookingRowsForTicket();
    var keys = grouped.keys || [];
    var currentEngineer = grouped.currentEngineer;

    menu.innerHTML = "";
    var head = document.createElement("div");
    head.className = "tm-booking-head";
    head.textContent = "Microsoft Bookings";
    menu.appendChild(head);

    var subhead = document.createElement("div");
    subhead.className = "tm-booking-subhead";
    subhead.textContent = currentEngineer && grouped.grouped[currentEngineer]
      ? ("Current ticket assignee first: " + grouped.grouped[currentEngineer].engineerName)
      : "No assignee match found; engineers are sorted alphabetically.";
    menu.appendChild(subhead);

    if (!keys.length) {
      var empty = document.createElement("div");
      empty.style.padding = "6px 10px";
      empty.textContent = emptyHint || "No booking links configured.";
      menu.appendChild(empty);
    } else {
      for (var ki = 0; ki < keys.length; ki++) {
        (function (groupKey) {
          var group = grouped.grouped[groupKey];
          var wrapper = document.createElement("div");
          wrapper.className = "tm-booking-group";

          var title = document.createElement("div");
          title.className = "tm-booking-group-title";
          title.textContent = group.engineerName + (groupKey === currentEngineer ? " (current ticket assignee)" : "");
          wrapper.appendChild(title);

          for (var ri = 0; ri < group.rows.length; ri++) {
            (function (row) {
              var label = row.pullDownDescription || row.linkTextHtml || row.bookingLink;
              var item = document.createElement("button");
              item.type = "button";
              item.className = "tm-booking-item";
              item.innerHTML = escapeHtml(label);
              item.addEventListener("click", function (ev) {
                ev.preventDefault();
                ev.stopPropagation();
                menu.style.display = "none";
                var payload = buildBookingInsertPayload(row);
                if (!payload) {
                  showToast("Booking link is missing from the configuration.", true);
                  return;
                }
                if (!insertBookingLinkIntoComment(payload)) {
                  showToast("Could not find the comment editor.", true);
                  return;
                }
                showToast("Inserted booking link.", false);
              });
              wrapper.appendChild(item);
            })(group.rows[ri]);
          }

          menu.appendChild(wrapper);
        })(keys[ki]);
      }
    }

    var actions = document.createElement("div");
    actions.className = "tm-booking-actions";

    var closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.textContent = "Close";
    closeBtn.addEventListener("click", function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      menu.style.display = "none";
    });
    actions.appendChild(closeBtn);

    menu.appendChild(actions);

    menu.style.display = "block";
    var rect = button.getBoundingClientRect();
    var vw = Math.max(document.documentElement.clientWidth || 0, window.innerWidth || 0);
    var vh = Math.max(document.documentElement.clientHeight || 0, window.innerHeight || 0);
    menu.style.left = Math.max(8, Math.min(rect.left, vw - menu.offsetWidth - 8)) + "px";
    menu.style.top = Math.max(8, Math.min(rect.bottom + 6, vh - menu.offsetHeight - 8)) + "px";
  }

  function ensureBookingMenuDismissHandlers() {
    if (window.__tmBookingMenuDismissBound) return;
    window.__tmBookingMenuDismissBound = true;

    document.addEventListener("click", function (e) {
      var selectionMenu = document.getElementById(BOOKING_MENU_ID);
      var configMenu = document.getElementById(BOOKING_CONFIG_MENU_ID);
      var appointmentBtn = document.getElementById(BOOKING_APPOINTMENT_BUTTON_ID);
      var configBtn = document.getElementById(BOOKING_CONFIG_BUTTON_ID);

      if (selectionMenu && selectionMenu.style.display !== "none" && !selectionMenu.contains(e.target) && e.target !== appointmentBtn) selectionMenu.style.display = "none";
      if (configMenu && configMenu.style.display !== "none" && !configMenu.contains(e.target) && e.target !== configBtn) configMenu.style.display = "none";
    });
    document.addEventListener("scroll", function () {
      closeBookingMenu();
      var configMenu = document.getElementById(BOOKING_CONFIG_MENU_ID);
      if (configMenu) configMenu.style.display = "none";
    }, true);
    window.addEventListener("blur", function () {
      closeBookingMenu();
      var configMenu = document.getElementById(BOOKING_CONFIG_MENU_ID);
      if (configMenu) configMenu.style.display = "none";
    });
  }

  function findVendorAppointmentButton() {
    function isVendorAppointmentText(text) {
      var normalized = String(text || "").replace(/\s+/g, " ").trim().toLowerCase();
      return normalized === "appointment" || normalized === "appointment link";
    }

    var mount = document.getElementById("appointments-links-ticket-comments");
    if (mount) {
      var localCandidates = mount.querySelectorAll("button, a");
      for (var i = 0; i < localCandidates.length; i++) {
        var candidate = localCandidates[i];
        if (candidate.id === BOOKING_APPOINTMENT_BUTTON_ID) continue;
        if (isVendorAppointmentText(candidate.textContent)) return candidate;
      }
    }

    var globalCandidates = document.querySelectorAll("button, a");
    for (var gi = 0; gi < globalCandidates.length; gi++) {
      var c = globalCandidates[gi];
      if (!c || c.id === BOOKING_APPOINTMENT_BUTTON_ID) continue;
      if (!isVendorAppointmentText(c.textContent)) continue;
      if (c.closest("#tm-top-copy-group")) continue;
      if (c.closest("#" + BOOKING_MENU_ID) || c.closest("#" + BOOKING_CONFIG_MENU_ID)) continue;
      return c;
    }

    return null;
  }

  function disableVendorAppointmentButton(vendorBtn) {
    if (!vendorBtn || vendorBtn.dataset.tmVendorDisabled === "1") return;
    vendorBtn.dataset.tmVendorDisabled = "1";
    vendorBtn.setAttribute("aria-hidden", "true");
    vendorBtn.setAttribute("tabindex", "-1");
    vendorBtn.style.display = "none";
    vendorBtn.style.pointerEvents = "none";
    if (vendorBtn.tagName === "BUTTON") {
      vendorBtn.disabled = true;
    }
  }

  function renderAppointmentButton() {
    ensureBookingMenuDismissHandlers();

    var button = document.getElementById(BOOKING_APPOINTMENT_BUTTON_ID);
    var vendorBtn = findVendorAppointmentButton();

    if (!button) {
      button = document.createElement("button");
      button.type = "button";
      button.id = BOOKING_APPOINTMENT_BUTTON_ID;
      button.className = (vendorBtn && vendorBtn.className) ? vendorBtn.className : "btn btn-default btn-sm mrs";
      button.textContent = "Appointment";
      button.setAttribute("title", "Insert Microsoft Bookings link into the comment");
    }

    if (vendorBtn) {
      var parent = vendorBtn.parentNode;
      if (parent && button.parentNode !== parent) {
        parent.insertBefore(button, vendorBtn);
      }
      disableVendorAppointmentButton(vendorBtn);
    } else {
      var mount = document.getElementById("appointments-links-ticket-comments");
      if (mount && button.parentNode !== mount) {
        mount.appendChild(button);
      }
    }

    if (button.__tmBookingBound) return;
    button.__tmBookingBound = true;
    button.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      renderBookingSelectionMenu(button, "No booking links configured. Use Bookings Config above to import or edit links.");
    });
  }

  function ensureBookingConfigMenu() {
    var menu = document.getElementById(BOOKING_CONFIG_MENU_ID);
    if (menu) return menu;

    injectStyle(
      "#" + BOOKING_CONFIG_MENU_ID + " { position: fixed; z-index: 100010; min-width: 220px; background: #fff; border: 1px solid #d9dce3; box-shadow: 0 6px 18px rgba(0,0,0,.18); border-radius: 6px; padding: 6px; display: none; font-family: 'Segoe UI', Arial, sans-serif; font-size: 13px; }" +
      "#" + BOOKING_CONFIG_MENU_ID + " .tm-config-item { display: block; width: 100%; text-align: left; padding: 7px 10px; border: 0; background: transparent; cursor: pointer; border-radius: 4px; }" +
      "#" + BOOKING_CONFIG_MENU_ID + " .tm-config-item:hover { background: #eef2f7; }",
      "tm-booking-config-style"
    );

    menu = document.createElement("div");
    menu.id = BOOKING_CONFIG_MENU_ID;
    document.body.appendChild(menu);
    return menu;
  }

  function renderConfigButton() {
    var topActionButtonBar = document.querySelector(".title-btns") || document.querySelector(".btn-bar");
    if (!topActionButtonBar) return;

    var topCopyGroup = document.getElementById("tm-top-copy-group");
    if (!topCopyGroup) {
      topCopyGroup = document.createElement("span");
      topCopyGroup.id = "tm-top-copy-group";
      topCopyGroup.style.display = "inline-flex";
      topCopyGroup.style.alignItems = "center";
      topCopyGroup.style.gap = "6px";
      topCopyGroup.style.marginLeft = "0";
      topCopyGroup.style.marginRight = "8px";
      if (topActionButtonBar.firstElementChild) topActionButtonBar.insertBefore(topCopyGroup, topActionButtonBar.firstElementChild);
      else topActionButtonBar.appendChild(topCopyGroup);
    }

    ensureBookingMenuDismissHandlers();

    var button = document.getElementById(BOOKING_CONFIG_BUTTON_ID);
    if (!button) {
      button = createMiniButton("Bookings Config", "Configure or import Microsoft Bookings links");
      button.id = BOOKING_CONFIG_BUTTON_ID;
      button.classList.add("tm-inline-mini");
      topCopyGroup.appendChild(button);
    }

    var menu = ensureBookingConfigMenu();

    if (button.__tmBookingBound) return;
    button.__tmBookingBound = true;

    button.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();

      menu.innerHTML = "";

      var manageBtn = document.createElement("button");
      manageBtn.type = "button";
      manageBtn.className = "tm-config-item";
      manageBtn.textContent = "Configure links and intro text";
      manageBtn.addEventListener("click", function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        menu.style.display = "none";
        showBookingLinksSettingsModal();
      });
      menu.appendChild(manageBtn);

      var importBtn = document.createElement("button");
      importBtn.type = "button";
      importBtn.className = "tm-config-item";
      importBtn.textContent = "Import bookings-links.csv";
      importBtn.addEventListener("click", function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        menu.style.display = "none";
        triggerBookingCsvImport();
      });
      menu.appendChild(importBtn);

      menu.style.display = "block";
      var rect = button.getBoundingClientRect();
      var vw = Math.max(document.documentElement.clientWidth || 0, window.innerWidth || 0);
      var vh = Math.max(document.documentElement.clientHeight || 0, window.innerHeight || 0);
      menu.style.left = Math.max(8, Math.min(rect.left, vw - menu.offsetWidth - 8)) + "px";
      menu.style.top = Math.max(8, Math.min(rect.bottom + 6, vh - menu.offsetHeight - 8)) + "px";
    });
  }

  function runBookingsInjections() {
    renderAppointmentButton();
    renderConfigButton();
  }

  var queued = false;
  function scheduleRun() {
    if (queued) return;
    queued = true;
    window.requestAnimationFrame(function () {
      queued = false;
      runBookingsInjections();
    });
  }

  function isScriptManagedNode(node) {
    if (!node || node.nodeType !== 1) return false;
    var id = node.id || "";
    if (id.indexOf("tm-") === 0) return true;
    var className = typeof node.className === "string" ? node.className : "";
    return /(^|\s)tm-/.test(className);
  }

  function mutationHasExternalChanges(mutationList) {
    for (var i = 0; i < mutationList.length; i++) {
      var mutation = mutationList[i];
      if (!mutation) continue;

      if (mutation.addedNodes) {
        for (var j = 0; j < mutation.addedNodes.length; j++) {
          var addedNode = mutation.addedNodes[j];
          if (addedNode && addedNode.nodeType === 1 && !isScriptManagedNode(addedNode)) return true;
        }
      }

      if (mutation.removedNodes) {
        for (var k = 0; k < mutation.removedNodes.length; k++) {
          var removedNode = mutation.removedNodes[k];
          if (removedNode && removedNode.nodeType === 1 && !isScriptManagedNode(removedNode)) return true;
        }
      }
    }
    return false;
  }

  function getObservationRoot() {
    return document.querySelector("#main") || document.querySelector(".container-fluid") || document.querySelector(".container") || document.body;
  }

  var observer = new MutationObserver(function (mutationList) {
    if (mutationHasExternalChanges(mutationList)) scheduleRun();
  });
  observer.observe(getObservationRoot(), { childList: true, subtree: true });

  var pollCount = 0;
  var maxPollAttempts = 15;
  var pollInterval = setInterval(function () {
    pollCount++;
    scheduleRun();
    if (pollCount >= maxPollAttempts) clearInterval(pollInterval);
  }, 2000);

  window.addEventListener("load", scheduleRun);
  window.addEventListener("pageshow", function () { scheduleRun(); });
  if (document.readyState === "complete" || document.readyState === "interactive") setTimeout(scheduleRun, 0);
  else document.addEventListener("DOMContentLoaded", scheduleRun);
})();

