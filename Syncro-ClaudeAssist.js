// ==UserScript==
// @name         Syncro - Claude Assist
// @namespace    http://tampermonkey.net/
// @version      1.0.0
// @description  Send Syncro ticket context to Claude API and display the response in an inline panel. Claude4.5 will be more cost efficient for this task but change variables to use other model.
// @author       Adapted from Gary Herbstman's Copilot Assist by Des Quinn / Equinox ITC
// @match        https://*.syncromsp.com/tickets/*
// @match        https://*.shield.syncromsp.com/tickets/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_setClipboard
// @grant        GM_xmlhttpRequest
// @connect      api.anthropic.com
// ==/UserScript==

(function () {
  "use strict";

  /* ═══════════════════ CONSTANTS ═══════════════════ */
  var CLAUDE_API_URL       = "https://api.anthropic.com/v1/messages";
 // var CLAUDE_MODEL         = "claude-sonnet-4-6";
 // var CLAUDE_MAX_TOKENS    = 2048;
  var CLAUDE_MODEL = "claude-haiku-4-5-20251001";
  var CLAUDE_MAX_TOKENS    = 3000;
  var API_KEY_STORAGE_KEY  = "tmClaudeApiKey";
  var AUTO_EXPAND_COMMENTS = true;

  /* ═══════════════════ API KEY MANAGEMENT ═══════════════════ */
  function getStoredApiKey() {
    try {
      if (typeof GM_getValue === "function") return GM_getValue(API_KEY_STORAGE_KEY, "") || "";
    } catch (e) {}
    return "";
  }

  function setStoredApiKey(key) {
    try {
      if (typeof GM_setValue === "function") GM_setValue(API_KEY_STORAGE_KEY, key || "");
    } catch (e) {}
  }

  function promptForApiKey() {
    var current = getStoredApiKey();
    var entered = window.prompt(
      "Enter your Anthropic API key (starts with sk-ant-). This will be stored securely by Tampermonkey.",
      current ? "sk-ant-..." : ""
    );
    if (entered === null) return null;
    var trimmed = String(entered || "").trim();
    if (!trimmed || !trimmed.startsWith("sk-")) {
      window.alert("That doesn't look like a valid Anthropic API key. Please try again.");
      return null;
    }
    setStoredApiKey(trimmed);
    return trimmed;
  }

  function getApiKey(forceConfigure) {
    var key = getStoredApiKey();
    if (forceConfigure || !key) return promptForApiKey();
    return key;
  }

  /* ═══════════════════ DOM HELPERS ═══════════════════ */
  function safeText(el) {
    return el ? String(el.textContent || "").replace(/\s+/g, " ").trim() : "";
  }

  function safeBlockText(el) {
    if (!el) return "";
    var raw = String(el.innerText || el.textContent || "").replace(/\r/g, "");
    var lines = raw.split("\n");
    for (var i = 0; i < lines.length; i++) lines[i] = lines[i].replace(/[ \t]+$/g, "");
    return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  /* ═══════════════════ TICKET DATA EXTRACTION ═══════════════════ */
  function getTicketIdFromPath() {
    var m = window.location.pathname.match(/\/tickets\/(\d+)/);
    return m ? m[1] : "";
  }

  function getTicketNumber() {
    var h = document.querySelector(".row h1") || document.querySelector("h1");
    var t = safeText(h);
    var m = t.match(/#(\d+)/);
    return m ? m[1] : getTicketIdFromPath();
  }

  function getTicketSubject() {
    var inp = document.getElementById("ticket-subject");
    if (inp && String(inp.value || "").trim()) return String(inp.value).trim();
    return safeText(document.querySelector("h3.ticket-subject-title"));
  }

  function getTicketInfoWidget() {
    var headers = document.querySelectorAll(".widget-header h3");
    for (var i = 0; i < headers.length; i++) {
      if (safeText(headers[i]) === "Ticket Info") return headers[i].closest(".widget");
    }
    return null;
  }

  function getCustomerWidget() {
    var headers = document.querySelectorAll(".widget-header h3");
    for (var i = 0; i < headers.length; i++) {
      if (safeText(headers[i]) === "Customer Info") return headers[i].closest(".widget");
    }
    return null;
  }

  function getTicketField(label) {
    var widget = getTicketInfoWidget();
    if (!widget) return "";
    var ths = widget.querySelectorAll("th");
    for (var i = 0; i < ths.length; i++) {
      if (safeText(ths[i]) === label) {
        var td = ths[i].nextElementSibling;
        if (!td) return "";
        var sel = td.querySelector("select");
        if (sel && sel.options && sel.selectedIndex >= 0) return safeText(sel.options[sel.selectedIndex]);
        return safeText(td);
      }
    }
    return "";
  }

  function getTicketStatus() {
    var sel = document.getElementById("ticket_status");
    if (sel && sel.options && sel.selectedIndex >= 0) return safeText(sel.options[sel.selectedIndex]);
    return getTicketField("Status");
  }

  function getCustomerField(label) {
    var widget = getCustomerWidget();
    if (!widget) return "";
    var ths = widget.querySelectorAll("th");
    for (var i = 0; i < ths.length; i++) {
      if (safeText(ths[i]) === label) {
        var td = ths[i].nextElementSibling;
        return td ? safeText(td) : "";
      }
    }
    return "";
  }

  function getCustomerName() {
    var a = document.querySelector('.widget a[href^="/customers/"]');
    return safeText(a);
  }

  function getAssignedContact() {
    var widget = getCustomerWidget();
    if (widget) {
      var ths = widget.querySelectorAll("th");
      for (var i = 0; i < ths.length; i++) {
        if (safeText(ths[i]) === "Assigned Contact") {
          var td = ths[i].nextElementSibling;
          if (!td) break;
          var el = td.querySelector("[data-original-title]") || td;
          var title = el.getAttribute && el.getAttribute("data-original-title");
          if (title && title.trim()) return title.trim();
          return safeText(td);
        }
      }
    }
    return getCustomerField("Assigned Contact");
  }

  function getPrimaryEmail() {
    var a = document.querySelector('.widget a[href^="mailto:"]');
    if (a) return (a.getAttribute("href") || "").replace(/^mailto:/i, "").trim() || safeText(a);
    return getCustomerField("Email");
  }

  function getPrimaryPhone() {
    var a = document.querySelector('.widget a[href^="tel:"]');
    if (a) return (a.getAttribute("href") || "").replace(/^tel:/i, "").trim() || safeText(a);
    return getCustomerField("Phone");
  }

  function findAiSummaryText() {
    var candidates = document.querySelectorAll(
      '[data-sidepack-react-class*="ai-summary"], [data-testid*="ai-summary"], .ai-summary, .ticket-ai-summary, [id*="ai-summary"]'
    );
    for (var i = 0; i < candidates.length; i++) {
      var t = safeBlockText(candidates[i]);
      if (t && t.length > 20) return t;
    }
    var headers = document.querySelectorAll(".widget-header h3");
    for (var j = 0; j < headers.length; j++) {
      if (safeText(headers[j]).toLowerCase() === "summary") {
        var widget = headers[j].closest(".widget");
        if (!widget) continue;
        var body = widget.querySelector(".widget-content") || widget;
        var t2 = safeBlockText(body);
        if (t2 && t2.length > 20) return t2;
      }
    }
    return "";
  }

  function getCommunicationEntries() {
    var items = [];
    var seen = {};
    var commentList = document.querySelector("div.comment-list.pbm");
    var nodes = commentList
      ? commentList.querySelectorAll(
          "div[id^='comment-'][data-testid='reply-comment'], div[id^='comment-'].hover-parent, .ticket-comment, .comment"
        )
      : document.querySelectorAll(".ticket-comment, .comment, .timeline-item, .activity-item, .communication-item, .note");

    function extractBody(node) {
      var bodyEl = node.querySelector(
        "div[id^='comment-body-'], .rich-text-comment, div[id^='purify-text-comment-'], .comment-body, .ticket-comment-body, .fr-view, .body"
      );
      if (!bodyEl) return "";
      var clone = bodyEl.cloneNode(true);
      var junk = clone.querySelectorAll("script, style, noscript, .hover-actions, .btn-group, .dropdown-menu");
      for (var k = 0; k < junk.length; k++) {
        if (junk[k].parentNode) junk[k].parentNode.removeChild(junk[k]);
      }
      return safeBlockText(clone);
    }

    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      var author =
        safeText(node.querySelector(".author-label, .comment-author, .author, .user-name, .media-heading a, .ticket-comment-header a")) ||
        node.getAttribute("data-author") || node.getAttribute("data-user-name") || "Unknown";
      var timeEl = node.querySelector(".meta .mrm[title], .meta [title], time, .comment-date, .date, .timestamp, [data-time]");
      var timestamp =
        (timeEl && (timeEl.getAttribute("datetime") || timeEl.getAttribute("title") || safeText(timeEl))) ||
        node.getAttribute("data-time") || node.getAttribute("data-created-at") || "Unknown";
      var body = extractBody(node);
      if (!body || body.length < 8) continue;
      var key = author + "|" + timestamp + "|" + body;
      if (seen[key]) continue;
      seen[key] = true;
      items.push({ author: String(author).trim(), timestamp: String(timestamp).trim(), body: body });
    }
    return items;
  }

  function formatCommunicationHistory(entries) {
    if (!entries || !entries.length) return "No communication entries found on the currently loaded page content.";
    var parts = [];
    for (var i = 0; i < entries.length; i++) {
      parts.push("Entry " + (i + 1));
      parts.push("Author: " + entries[i].author);
      parts.push("Date/Time: " + entries[i].timestamp);
      parts.push("Body:");
      parts.push(entries[i].body);
      parts.push("");
    }
    return parts.join("\n").trim();
  }

  /* ═══════════════════ COMMENT EXPANDER ═══════════════════ */
  function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function waitForDomQuiet(root, quietMs, timeoutMs) {
    root = root || document.body;
    quietMs = quietMs || 350;
    timeoutMs = timeoutMs || 5000;
    return new Promise(function (resolve) {
      var done = false;
      var quietTimer = null;
      var observer = null;
      function finish() {
        if (done) return;
        done = true;
        if (quietTimer) clearTimeout(quietTimer);
        if (observer) observer.disconnect();
        resolve();
      }
      function schedule() { if (quietTimer) clearTimeout(quietTimer); quietTimer = setTimeout(finish, quietMs); }
      try {
        observer = new MutationObserver(schedule);
        observer.observe(root, { childList: true, subtree: true, characterData: true });
      } catch (e) {}
      schedule();
      setTimeout(finish, timeoutMs);
    });
  }

  function getShowMoreLinks(includeProcessed) {
    var links = document.querySelectorAll('a[data-remote="true"][href*="/comments/"]');
    var out = [];
    for (var i = 0; i < links.length; i++) {
      var t = safeText(links[i]).toLowerCase();
      if (t.indexOf("show more") === -1 && t.indexOf("load more") === -1 && t.indexOf("older") === -1) continue;
      if (!includeProcessed && links[i].getAttribute("data-tm-expanded") === "1") continue;
      out.push(links[i]);
    }
    return out;
  }

  async function expandAllComments() {
    var maxIter = 60;
    var count = 0;
    for (var i = 0; i < maxIter; i++) {
      var links = getShowMoreLinks(false);
      if (!links.length) break;
      var link = links[0];
      link.setAttribute("data-tm-expanded", "1");
      try { link.click(); } catch (e) {
        try { link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); } catch (e2) {}
      }
      count++;
      await waitForDomQuiet(document.body, 350, 5000);
      await delay(100);
    }
    return count;
  }

  /* ═══════════════════ PROMPT BUILDER ═══════════════════ */
  function buildPrompt(mode, details) {
    var taskLine = "Provide both a customer-facing response and an internal diagnosis plan.";
    if (mode === "response") taskLine = "Draft a customer-facing response for this ticket.";
    if (mode === "diagnosis") taskLine = "Provide a technical diagnosis and step-by-step remediation plan.";

    return [
      "You are assisting an MSP technician with a Syncro support ticket.",
      taskLine,
      "",
      "Rules:",
      "- Keep assumptions explicit.",
      "- If information is missing, list clarifying questions.",
      "- Keep recommendations practical and low-risk.",
      "- Use the communication history as the source of truth for chronology and context.",
      "",
      "Ticket details:",
      "- Ticket Number: " + (details.ticketNumber || "Unknown"),
      "- Subject: " + (details.subject || "Unknown"),
      "- Status: " + (details.status || "Unknown"),
      "- Priority: " + (details.priority || "Unknown"),
      "- Assignee: " + (details.assignee || "Unknown"),
      "- Customer: " + (details.customer || "Unknown"),
      "- Contact: " + (details.contact || "Unknown"),
      "- Email: " + (details.email || "Unknown"),
      "- Phone: " + (details.phone || "Unknown"),
      "- Created: " + (details.created || "Unknown"),
      "- Due: " + (details.due || "Unknown"),
      "- Ticket URL: " + (details.url || "Unknown"),
      "",
      "AI Summary (if available):",
      details.aiSummary || "None.",
      "",
      "Communication history:",
      details.communicationHistory || "No entries found.",
      "",
      "Output format:",
      "1) Quick understanding summary",
      "2) Most likely root causes",
      "3) Immediate next actions",
      "4) Draft customer-facing response",
      "5) Follow-up questions if needed"
    ].join("\n");
  }

  function collectTicketDetails() {
    var entries = getCommunicationEntries();
    return {
      ticketNumber: getTicketNumber(),
      subject: getTicketSubject(),
      status: getTicketStatus(),
      priority: getTicketField("Priority"),
      assignee: getTicketField("Assignee"),
      customer: getCustomerName(),
      contact: getAssignedContact(),
      email: getPrimaryEmail(),
      phone: getPrimaryPhone(),
      created: getTicketField("Created"),
      due: getTicketField("Due Date"),
      aiSummary: findAiSummaryText(),
      communicationHistory: formatCommunicationHistory(entries),
      url: window.location.href
    };
  }

  /* ═══════════════════ CLAUDE API CALL ═══════════════════ */
  function callClaudeApi(apiKey, prompt) {
    return new Promise(function (resolve, reject) {
      GM_xmlhttpRequest({
        method: "POST",
        url: CLAUDE_API_URL,
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01"
        },
        data: JSON.stringify({
          model: CLAUDE_MODEL,
          max_tokens: CLAUDE_MAX_TOKENS,
          messages: [{ role: "user", content: prompt }]
        }),
        onload: function (response) {
          try {
            var data = JSON.parse(response.responseText);
            if (response.status !== 200) {
              var errMsg = (data.error && data.error.message) ? data.error.message : "HTTP " + response.status;
              reject(new Error(errMsg));
              return;
            }
            var text = "";
            if (data.content && data.content.length > 0) {
              for (var i = 0; i < data.content.length; i++) {
                if (data.content[i].type === "text") text += data.content[i].text;
              }
            }
            resolve(text || "(No response text returned)");
          } catch (parseErr) {
            reject(new Error("Failed to parse API response: " + parseErr.message));
          }
        },
        onerror: function (err) {
          reject(new Error("Network error contacting Claude API. Check your connection and try again."));
        },
        ontimeout: function () {
          reject(new Error("Request to Claude API timed out. Please try again."));
        },
        timeout: 60000
      });
    });
  }

  /* ═══════════════════ RESULT PANEL UI ═══════════════════ */
  function injectPanelStyles() {
    if (document.getElementById("tm-claude-styles")) return;
    var style = document.createElement("style");
    style.id = "tm-claude-styles";
    style.textContent = [
      "#tm-claude-overlay {",
      "  position: fixed; inset: 0; z-index: 200000;",
      "  background: rgba(0,0,0,0.45); display: flex;",
      "  align-items: center; justify-content: center;",
      "}",
      "#tm-claude-panel {",
      "  background: #fff; border-radius: 8px;",
      "  box-shadow: 0 8px 32px rgba(0,0,0,0.28);",
      "  width: min(820px, 94vw); max-height: 85vh;",
      "  display: flex; flex-direction: column;",
      "  font-family: 'Segoe UI', Arial, sans-serif; font-size: 13px;",
      "}",
      "#tm-claude-panel-header {",
      "  display: flex; align-items: center; justify-content: space-between;",
      "  padding: 12px 16px; border-bottom: 1px solid #e0e0e0;",
      "  background: #1a1a2e; border-radius: 8px 8px 0 0;",
      "}",
      "#tm-claude-panel-header span {",
      "  color: #fff; font-weight: 700; font-size: 14px;",
      "}",
      "#tm-claude-panel-header-btns { display: flex; gap: 8px; }",
      "#tm-claude-panel-header-btns button {",
      "  padding: 4px 10px; border-radius: 4px; border: 1px solid rgba(255,255,255,0.3);",
      "  background: rgba(255,255,255,0.1); color: #fff;",
      "  cursor: pointer; font-size: 12px; font-weight: 500;",
      "}",
      "#tm-claude-panel-header-btns button:hover { background: rgba(255,255,255,0.25); }",
      "#tm-claude-panel-body {",
      "  overflow-y: auto; padding: 16px 18px; flex: 1;",
      "  white-space: pre-wrap; line-height: 1.6; color: #222;",
      "}",
      "#tm-claude-panel-footer {",
      "  padding: 10px 16px; border-top: 1px solid #e0e0e0;",
      "  display: flex; gap: 8px; justify-content: flex-end;",
      "  background: #f7f8fb; border-radius: 0 0 8px 8px;",
      "}",
      "#tm-claude-panel-footer button {",
      "  padding: 5px 14px; border-radius: 4px; cursor: pointer;",
      "  border: 1px solid #c0c4cc; background: #fff;",
      "  font-size: 12px; font-weight: 500; color: #333;",
      "}",
      "#tm-claude-panel-footer button:hover { background: #eef2f7; }",
      "#tm-claude-panel-footer .tm-btn-primary {",
      "  background: #1a1a2e; color: #fff; border-color: #1a1a2e;",
      "}",
      "#tm-claude-panel-footer .tm-btn-primary:hover { background: #2d2d50; }",
      ".tm-claude-loading {",
      "  display: flex; flex-direction: column; align-items: center;",
      "  justify-content: center; padding: 40px; gap: 12px; color: #555;",
      "}",
      ".tm-claude-spinner {",
      "  width: 32px; height: 32px; border: 3px solid #e0e0e0;",
      "  border-top-color: #1a1a2e; border-radius: 50%;",
      "  animation: tm-spin 0.8s linear infinite;",
      "}",
      "@keyframes tm-spin { to { transform: rotate(360deg); } }",
      ".tm-claude-error { color: #8b1e1e; padding: 12px; background: #fff5f5;",
      "  border-radius: 6px; border: 1px solid #f5c6c6; }",
      ".tm-claude-error-actions { margin-top: 10px; display: flex; gap: 8px; flex-wrap: wrap; }",
      ".tm-claude-error-actions button {",
      "  padding: 5px 12px; border-radius: 4px; cursor: pointer;",
      "  border: 1px solid #c0c4cc; background: #fff;",
      "  font-size: 12px; font-weight: 500;",
      "}"
    ].join("\n");
    document.head.appendChild(style);
  }

  function showPanel(titleSuffix) {
    injectPanelStyles();

    var existing = document.getElementById("tm-claude-overlay");
    if (existing) existing.remove();

    var overlay = document.createElement("div");
    overlay.id = "tm-claude-overlay";

    var panel = document.createElement("div");
    panel.id = "tm-claude-panel";

    // Header
    var header = document.createElement("div");
    header.id = "tm-claude-panel-header";

    var title = document.createElement("span");
    title.textContent = "Claude Assist" + (titleSuffix ? " - " + titleSuffix : "");

    var headerBtns = document.createElement("div");
    headerBtns.id = "tm-claude-panel-header-btns";

    var closeBtn = document.createElement("button");
    closeBtn.textContent = "Close";
    closeBtn.addEventListener("click", function () { overlay.remove(); });

    headerBtns.appendChild(closeBtn);
    header.appendChild(title);
    header.appendChild(headerBtns);

    // Body
    var body = document.createElement("div");
    body.id = "tm-claude-panel-body";

    // Footer
    var footer = document.createElement("div");
    footer.id = "tm-claude-panel-footer";

    var footerClose = document.createElement("button");
    footerClose.textContent = "Close";
    footerClose.addEventListener("click", function () { overlay.remove(); });
    footer.appendChild(footerClose);

    panel.appendChild(header);
    panel.appendChild(body);
    panel.appendChild(footer);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    // Close on overlay click
    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) overlay.remove();
    });

    // Close on Escape
    function onKey(e) {
      if (e.key === "Escape") { overlay.remove(); document.removeEventListener("keydown", onKey); }
    }
    document.addEventListener("keydown", onKey);

    return { overlay: overlay, body: body, footer: footer, title: title };
  }

  function setLoading(body, message) {
    body.innerHTML = "";
    var wrap = document.createElement("div");
    wrap.className = "tm-claude-loading";

    var spinner = document.createElement("div");
    spinner.className = "tm-claude-spinner";

    var msg = document.createElement("span");
    msg.textContent = message || "Asking Claude...";

    wrap.appendChild(spinner);
    wrap.appendChild(msg);
    body.appendChild(wrap);
  }

  function setResult(body, footer, text, rawPrompt) {
    body.innerHTML = "";
    body.textContent = text;

    // Copy response button
    var copyResponseBtn = document.createElement("button");
    copyResponseBtn.textContent = "Copy Response";
    copyResponseBtn.className = "tm-btn-primary";
    copyResponseBtn.addEventListener("click", function () {
      try {
        if (typeof GM_setClipboard === "function") GM_setClipboard(text, "text");
        else navigator.clipboard.writeText(text);
        copyResponseBtn.textContent = "Copied!";
        setTimeout(function () { copyResponseBtn.textContent = "Copy Response"; }, 1800);
      } catch (e) {}
    });

    // Copy prompt fallback button
    var copyPromptBtn = document.createElement("button");
    copyPromptBtn.textContent = "Copy Prompt";
    copyPromptBtn.title = "Copy the raw prompt sent to Claude (useful for pasting elsewhere)";
    copyPromptBtn.addEventListener("click", function () {
      try {
        if (typeof GM_setClipboard === "function") GM_setClipboard(rawPrompt, "text");
        else navigator.clipboard.writeText(rawPrompt);
        copyPromptBtn.textContent = "Copied!";
        setTimeout(function () { copyPromptBtn.textContent = "Copy Prompt"; }, 1800);
      } catch (e) {}
    });

    footer.insertBefore(copyPromptBtn, footer.firstChild);
    footer.insertBefore(copyResponseBtn, footer.firstChild);
  }

  function setError(body, footer, errorMessage, rawPrompt, onRetry) {
    body.innerHTML = "";

    var wrap = document.createElement("div");
    wrap.className = "tm-claude-error";

    var msg = document.createElement("div");
    msg.textContent = "Error: " + errorMessage;

    var actions = document.createElement("div");
    actions.className = "tm-claude-error-actions";

    // Retry button
    if (typeof onRetry === "function") {
      var retryBtn = document.createElement("button");
      retryBtn.textContent = "Retry";
      retryBtn.addEventListener("click", function () { onRetry(); });
      actions.appendChild(retryBtn);
    }

    // Re-enter API key
    var rekeyBtn = document.createElement("button");
    rekeyBtn.textContent = "Update API Key";
    rekeyBtn.addEventListener("click", function () {
      var newKey = promptForApiKey();
      if (newKey && typeof onRetry === "function") onRetry(newKey);
    });
    actions.appendChild(rekeyBtn);

    // Copy prompt fallback - lets them paste into Claude.ai or any other interface
    var copyPromptBtn = document.createElement("button");
    copyPromptBtn.textContent = "Copy Prompt (Fallback)";
    copyPromptBtn.title = "Copy the prompt to clipboard so you can paste it into Claude.ai or another interface manually";
    copyPromptBtn.addEventListener("click", function () {
      try {
        if (typeof GM_setClipboard === "function") GM_setClipboard(rawPrompt, "text");
        else navigator.clipboard.writeText(rawPrompt);
        copyPromptBtn.textContent = "Copied!";
        setTimeout(function () { copyPromptBtn.textContent = "Copy Prompt (Fallback)"; }, 1800);
      } catch (e) {}
    });
    actions.appendChild(copyPromptBtn);

    // Open Claude.ai in new tab
    var openClaudeBtn = document.createElement("button");
    openClaudeBtn.textContent = "Open Claude.ai";
    openClaudeBtn.title = "Open Claude.ai so you can paste the prompt manually after copying it above";
    openClaudeBtn.addEventListener("click", function () {
      window.open("https://claude.ai", "_blank", "noopener,noreferrer");
    });
    actions.appendChild(openClaudeBtn);

    wrap.appendChild(msg);
    wrap.appendChild(actions);
    body.appendChild(wrap);
  }

  /* ═══════════════════ TOAST ═══════════════════ */
  function showToast(message, isError) {
    var existing = document.getElementById("tm-claude-toast");
    if (existing) existing.remove();
    var toast = document.createElement("div");
    toast.id = "tm-claude-toast";
    toast.textContent = message;
    Object.assign(toast.style, {
      position: "fixed", right: "14px", bottom: "14px", zIndex: "999999",
      background: isError ? "#8b1e1e" : "#1a1a2e", color: "#fff",
      padding: "10px 14px", borderRadius: "6px", boxShadow: "0 4px 12px rgba(0,0,0,0.25)",
      fontFamily: "Segoe UI, Arial, sans-serif", fontSize: "12px",
      maxWidth: "420px", whiteSpace: "normal"
    });
    document.body.appendChild(toast);
    setTimeout(function () { if (toast.parentNode) toast.parentNode.removeChild(toast); }, 4200);
  }

  /* ═══════════════════ MAIN FLOW ═══════════════════ */
  var MODE_LABELS = {
    both: "Both (Response + Diagnosis)",
    response: "Response Draft",
    diagnosis: "Diagnosis Help"
  };

  async function runAssist(mode, overrideApiKey) {
    var apiKey = overrideApiKey || getApiKey(false);
    if (!apiKey) return;

    var panelParts = showPanel(MODE_LABELS[mode] || mode);

    if (AUTO_EXPAND_COMMENTS) {
      setLoading(panelParts.body, "Expanding comment history...");
      var expandCount = await expandAllComments();
      if (expandCount > 0) {
        showToast("Loaded " + expandCount + " additional comment section(s).", false);
      }
    }

    setLoading(panelParts.body, "Building prompt and asking Claude...");

    var details = collectTicketDetails();
    var prompt = buildPrompt(mode, details);

    function doApiCall(keyToUse) {
      setLoading(panelParts.body, "Waiting for Claude response...");
      callClaudeApi(keyToUse, prompt).then(function (responseText) {
        setResult(panelParts.body, panelParts.footer, responseText, prompt);
      }).catch(function (err) {
        setError(
          panelParts.body,
          panelParts.footer,
          err.message || "Unknown error",
          prompt,
          function (newKey) {
            var keyToRetry = newKey || keyToUse;
            if (newKey) setStoredApiKey(newKey);
            doApiCall(keyToRetry);
          }
        );
      });
    }

    doApiCall(apiKey);
  }

  /* ═══════════════════ BUTTON INJECTION ═══════════════════ */
  function addAssistButton() {
    if (document.getElementById("tm-claude-assist-wrap")) return;

    var targetBar = document.querySelector(".title-btns") || document.querySelector(".btn-bar");
    if (!targetBar) return;

    var wrap = document.createElement("div");
    wrap.id = "tm-claude-assist-wrap";
    Object.assign(wrap.style, {
      position: "relative", display: "inline-block", marginRight: "8px"
    });

    var btn = document.createElement("button");
    btn.id = "tm-claude-assist-btn";
    btn.type = "button";
    btn.className = "btn btn-default btn-xs";
    btn.textContent = "Claude Assist \u25be";
    btn.title = "Send ticket context to Claude for analysis";

    var menu = document.createElement("div");
    menu.id = "tm-claude-assist-menu";
    Object.assign(menu.style, {
      position: "absolute", top: "100%", left: "0",
      minWidth: "220px", marginTop: "4px", padding: "4px",
      background: "#fff", border: "1px solid #d9dce3",
      borderRadius: "6px", boxShadow: "0 6px 18px rgba(0,0,0,0.18)",
      zIndex: "100080", display: "none"
    });

    function setMenuOpen(open) {
      menu.style.display = open ? "block" : "none";
      btn.setAttribute("aria-expanded", open ? "true" : "false");
    }

    var modes = [
      { key: "both",      label: "Both (Response + Diagnosis)" },
      { key: "response",  label: "Response Draft" },
      { key: "diagnosis", label: "Diagnosis Help" }
    ];

    for (var i = 0; i < modes.length; i++) {
      (function (opt, idx) {
        var item = document.createElement("button");
        item.type = "button";
        item.className = "btn btn-default btn-xs";
        item.textContent = opt.label;
        Object.assign(item.style, {
          display: "block", width: "100%", margin: "0",
          marginBottom: idx < modes.length - 1 ? "4px" : "0",
          textAlign: "left", whiteSpace: "normal"
        });
        item.addEventListener("click", async function (e) {
          e.preventDefault(); e.stopPropagation();
          setMenuOpen(false);
          await runAssist(opt.key);
        });
        menu.appendChild(item);
      })(modes[i], i);
    }

    // Separator
    var sep = document.createElement("hr");
    Object.assign(sep.style, { margin: "4px 0", borderColor: "#e0e0e0" });
    menu.appendChild(sep);

    // Settings item
    var settingsItem = document.createElement("button");
    settingsItem.type = "button";
    settingsItem.className = "btn btn-default btn-xs";
    settingsItem.textContent = "API Key Settings";
    Object.assign(settingsItem.style, {
      display: "block", width: "100%", margin: "0",
      textAlign: "left", whiteSpace: "normal"
    });
    settingsItem.addEventListener("click", function (e) {
      e.preventDefault(); e.stopPropagation();
      setMenuOpen(false);
      var newKey = promptForApiKey();
      if (newKey) showToast("API key saved.", false);
    });
    menu.appendChild(settingsItem);

    btn.addEventListener("click", function (e) {
      e.preventDefault(); e.stopPropagation();
      setMenuOpen(menu.style.display !== "block");
    });

    document.addEventListener("click", function (e) {
      if (!wrap.contains(e.target)) setMenuOpen(false);
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") setMenuOpen(false);
    });

    wrap.appendChild(btn);
    wrap.appendChild(menu);

    if (targetBar.firstElementChild) targetBar.insertBefore(wrap, targetBar.firstElementChild);
    else targetBar.appendChild(wrap);
  }

  /* ═══════════════════ BOOT ═══════════════════ */
  function boot() {
    addAssistButton();
    var root = document.querySelector("#main") || document.body;
    var observer = new MutationObserver(function (mutations) {
      for (var i = 0; i < mutations.length; i++) {
        if (mutations[i].addedNodes && mutations[i].addedNodes.length > 0) {
          addAssistButton();
          return;
        }
      }
    });
    observer.observe(root, { childList: true, subtree: true });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();

})();