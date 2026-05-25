// ==UserScript==
// @name         Syncro - Copilot Assist
// @namespace    http://tampermonkey.net/
// @version      1.2.0
// @description  Copy detailed Syncro ticket context into a Copilot-ready prompt (including AI summary and communication history) and open Copilot.
// @author       Gary Herbstman
// @match        https://*.syncromsp.com/tickets/*
// @match        https://*.shield.syncromsp.com/tickets/*
// @grant        GM_setClipboard
// @grant        GM_openInTab
// @grant        GM_getValue
// @grant        GM_setValue
// @downloadURL  https://raw.githubusercontent.com/gherbstman/SyncroTamperMonkey/main/SyncroCopilotAssist.user.js
// @updateURL    https://raw.githubusercontent.com/gherbstman/SyncroTamperMonkey/main/SyncroCopilotAssist.user.js
// ==/UserScript==

(function () {
  "use strict";

  var DEFAULT_COPILOT_CHAT_URL = "https://m365.cloud.microsoft/chat";
  var AGENT_URL_STORAGE_KEY = "tmCopilotPreferredAgentUrl";
  var AUTO_EXPAND_SHOW_MORE_COMMENTS = true;

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

  function getTicketIdFromPath() {
    var match = window.location.pathname.match(/\/tickets\/(\d+)/);
    return match ? match[1] : "";
  }

  function getTicketNumber() {
    var heading = document.querySelector(".row h1") || document.querySelector("h1");
    var text = safeText(heading);
    var hashMatch = text.match(/#(\d+)/);
    if (hashMatch) return hashMatch[1];
    return getTicketIdFromPath();
  }

  function getTicketSubject() {
    var subjectInput = document.getElementById("ticket-subject");
    if (subjectInput && String(subjectInput.value || "").trim()) {
      return String(subjectInput.value || "").trim();
    }
    var subjectHeading = document.querySelector("h3.ticket-subject-title");
    return safeText(subjectHeading);
  }

  function getTicketField(labelText) {
    var headers = document.querySelectorAll(".widget-header h3");
    var ticketInfoWidget = null;

    for (var i = 0; i < headers.length; i++) {
      if (safeText(headers[i]) === "Ticket Info") {
        ticketInfoWidget = headers[i].closest(".widget");
        break;
      }
    }

    if (!ticketInfoWidget) return "";

    var ths = ticketInfoWidget.querySelectorAll("th");
    for (var j = 0; j < ths.length; j++) {
      if (safeText(ths[j]) === labelText) {
        var td = ths[j].nextElementSibling;
        return safeText(td);
      }
    }

    return "";
  }

  function getCustomerField(labelText) {
    var headers = document.querySelectorAll(".widget-header h3");
    var customerWidget = null;

    for (var i = 0; i < headers.length; i++) {
      if (safeText(headers[i]) === "Customer Info") {
        customerWidget = headers[i].closest(".widget");
        break;
      }
    }

    if (!customerWidget) return "";

    var ths = customerWidget.querySelectorAll("th");
    for (var j = 0; j < ths.length; j++) {
      if (safeText(ths[j]) === labelText) {
        var td = ths[j].nextElementSibling;
        return safeText(td);
      }
    }

    return "";
  }

  function getCustomerName() {
    var link = document.querySelector('.widget a[href^="/customers/"]');
    return safeText(link);
  }

  function getPrimaryEmail() {
    var mail = document.querySelector('.widget a[href^="mailto:"]');
    if (mail) {
      var href = mail.getAttribute("href") || "";
      return href.replace(/^mailto:/i, "").trim() || safeText(mail);
    }
    return getCustomerField("Email");
  }

  function getPrimaryPhone() {
    var phone = document.querySelector('.widget a[href^="tel:"]');
    if (phone) {
      var href = phone.getAttribute("href") || "";
      return href.replace(/^tel:/i, "").trim() || safeText(phone);
    }
    return getCustomerField("Phone");
  }

  function findAiSummaryText() {
    var candidates = document.querySelectorAll(
      '[data-sidepack-react-class*="ai-summary"], [data-testid*="ai-summary"], .ai-summary, .ticket-ai-summary, [id*="ai-summary"]'
    );

    for (var i = 0; i < candidates.length; i++) {
      var text = safeBlockText(candidates[i]);
      if (text && text.length > 20) return text;
    }

    var widgetHeaders = document.querySelectorAll(".widget-header h3");
    for (var j = 0; j < widgetHeaders.length; j++) {
      if (safeText(widgetHeaders[j]).toLowerCase() === "summary") {
        var widget = widgetHeaders[j].closest(".widget");
        if (!widget) continue;
        var body = widget.querySelector(".widget-content") || widget;
        var summaryText = safeBlockText(body);
        if (summaryText && summaryText.length > 20) return summaryText;
      }
    }

    return "";
  }

  function getCommunicationEntries() {
    var items = [];
    var seen = {};
    var nodes = document.querySelectorAll(
      ".ticket-comment, .comment, .timeline-item, .activity-item, .communication-item, .note"
    );

    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];

      var author =
        safeText(node.querySelector(".comment-author, .author, .user-name, .media-heading a, .ticket-comment-header a")) ||
        node.getAttribute("data-author") ||
        node.getAttribute("data-user-name") ||
        "Unknown";

      var timeEl = node.querySelector("time, .comment-date, .date, .timestamp, [data-time]");
      var timestamp =
        (timeEl && (timeEl.getAttribute("datetime") || timeEl.getAttribute("title") || safeText(timeEl))) ||
        node.getAttribute("data-time") ||
        node.getAttribute("data-created-at") ||
        "Unknown";

      var bodyEl = node.querySelector(
        ".note-editable, .comment-body, .body, .message, .ticket-comment-body, .fr-view"
      );
      var body = safeBlockText(bodyEl || node);

      if (!body || body.length < 8) continue;

      var key = author + "|" + timestamp + "|" + body;
      if (seen[key]) continue;
      seen[key] = true;

      items.push({
        author: String(author || "Unknown").trim() || "Unknown",
        timestamp: String(timestamp || "Unknown").trim() || "Unknown",
        body: body
      });
    }

    return items;
  }

  function formatCommunicationHistory(entries) {
    if (!entries || !entries.length) {
      return "No communication entries found on the currently loaded page content.";
    }

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

  function getAssistModeOptions() {
    return [
      { key: "both", label: "Both (Response + Diagnosis)" },
      { key: "response", label: "Response Draft" },
      { key: "diagnosis", label: "Diagnosis Help" }
    ];
  }

  function buildPrompt(requestType, details) {
    var taskLine = "Provide both a customer-facing response and an internal diagnosis plan.";
    if (requestType === "response") taskLine = "Draft a customer-facing response for this ticket.";
    if (requestType === "diagnosis") taskLine = "Provide a technical diagnosis and step-by-step remediation plan.";

    return [
      "You are assisting an MSP technician with a Syncro ticket.",
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
      "AI Summary:",
      details.aiSummary || "No AI summary found.",
      "",
      "Communication history (initial request + replies):",
      details.communicationHistory || "No communication entries found.",
      "",
      "Output format:",
      "1) Quick understanding summary",
      "2) Most likely root causes",
      "3) Immediate next actions",
      "4) Draft response text",
      "5) Follow-up questions",
      "",
      "Note for technician:",
      "- This prompt was copied to clipboard by the userscript.",
      "- Paste it in Copilot manually with Ctrl+V (or Cmd+V on macOS)."
    ].join("\n");
  }

  function copyText(text) {
    try {
      if (typeof GM_setClipboard === "function") {
        GM_setClipboard(text, "text");
        return true;
      }
    } catch (err) {}

    try {
      navigator.clipboard.writeText(text);
      return true;
    } catch (err2) {
      return false;
    }
  }

  function delay(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  function getShowMoreCommentLinks(includeProcessed) {
    var links = document.querySelectorAll('a[data-remote="true"][href*="/comments/"]');
    var out = [];

    for (var i = 0; i < links.length; i++) {
      var link = links[i];
      var text = safeText(link).toLowerCase();
      var looksLikeShowMore =
        text.indexOf("show more") !== -1 ||
        text.indexOf("load more") !== -1 ||
        text.indexOf("older") !== -1;

      if (!looksLikeShowMore) continue;
      if (!includeProcessed && link.getAttribute("data-tm-expanded") === "1") continue;
      out.push(link);
    }

    return out;
  }

  function waitForDomQuiet(root, quietMs, timeoutMs) {
    root = root || document.body;
    quietMs = quietMs || 350;
    timeoutMs = timeoutMs || 5000;

    return new Promise(function (resolve) {
      var observer = null;
      var done = false;
      var quietTimer = null;

      function finish() {
        if (done) return;
        done = true;
        if (quietTimer) clearTimeout(quietTimer);
        if (observer) observer.disconnect();
        resolve();
      }

      function scheduleQuietFinish() {
        if (quietTimer) clearTimeout(quietTimer);
        quietTimer = setTimeout(finish, quietMs);
      }

      try {
        observer = new MutationObserver(function () {
          scheduleQuietFinish();
        });
        observer.observe(root, { childList: true, subtree: true, characterData: true });
      } catch (err) {
        // If observer setup fails for any reason, fall back to timeout.
      }

      scheduleQuietFinish();
      setTimeout(finish, timeoutMs);
    });
  }

  async function expandAllShowMoreComments() {
    var maxIterations = 60;
    var expandedCount = 0;

    for (var i = 0; i < maxIterations; i++) {
      var links = getShowMoreCommentLinks(false);
      if (!links.length) break;

      var link = links[0];
      link.setAttribute("data-tm-expanded", "1");

      try {
        link.click();
      } catch (err) {
        try {
          link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        } catch (err2) {}
      }

      expandedCount++;
      await waitForDomQuiet(document.body, 350, 5000);
      await delay(100);
    }

    return {
      expandedCount: expandedCount,
      remainingShowMoreCount: getShowMoreCommentLinks(false).length
    };
  }

  function validateCopilotUrl(rawUrl) {
    if (!rawUrl) return "";

    var value = String(rawUrl).trim();
    if (!value) return "";

    try {
      var parsed = new URL(value);
      if (parsed.protocol !== "https:") return "";
      if (!/m365\.cloud\.microsoft$/i.test(parsed.hostname)) return "";
      if (parsed.pathname.toLowerCase().indexOf("/chat") !== 0) return "";
      return parsed.toString();
    } catch (err) {
      return "";
    }
  }

  function getStoredPreferredAgentUrl() {
    try {
      if (typeof GM_getValue === "function") {
        return validateCopilotUrl(GM_getValue(AGENT_URL_STORAGE_KEY, ""));
      }
    } catch (err) {}

    try {
      return validateCopilotUrl(window.localStorage.getItem(AGENT_URL_STORAGE_KEY) || "");
    } catch (err2) {
      return "";
    }
  }

  function setStoredPreferredAgentUrl(url) {
    var safeUrl = validateCopilotUrl(url);
    try {
      if (typeof GM_setValue === "function") {
        GM_setValue(AGENT_URL_STORAGE_KEY, safeUrl || "");
      }
    } catch (err) {}

    try {
      window.localStorage.setItem(AGENT_URL_STORAGE_KEY, safeUrl || "");
    } catch (err2) {}

    return safeUrl;
  }

  function promptForAgentUrl(currentValue) {
    var entered = window.prompt(
      "Optional: Enter your Copilot agent URL to save as your personal default. Leave blank to use standard chat URL.",
      currentValue || ""
    );

    if (entered === null) return { cancelled: true, value: currentValue || "" };

    var trimmed = String(entered || "").trim();
    if (!trimmed) return { cancelled: false, value: "" };

    var valid = validateCopilotUrl(trimmed);
    if (!valid) {
      window.alert("Invalid URL. Use an https://m365.cloud.microsoft/chat... URL.");
      return { cancelled: true, value: currentValue || "" };
    }

    return { cancelled: false, value: valid };
  }

  function getPreferredCopilotUrl(options) {
    options = options || {};

    var stored = getStoredPreferredAgentUrl();
    if (!stored && !options.skipPrompt) {
      var selected = promptForAgentUrl("");
      if (!selected.cancelled) {
        stored = setStoredPreferredAgentUrl(selected.value);
      }
    }

    if (options.forceConfigure) {
      var current = stored || DEFAULT_COPILOT_CHAT_URL;
      var configured = promptForAgentUrl(current);
      if (configured.cancelled) return stored || DEFAULT_COPILOT_CHAT_URL;
      stored = setStoredPreferredAgentUrl(configured.value);
      if (!stored) {
        showToast("Agent preference cleared. Using standard Copilot chat URL.", false);
      } else {
        showToast("Agent preference saved for this user/browser.", false);
      }
    }

    return stored || DEFAULT_COPILOT_CHAT_URL;
  }

  function openCopilot(url) {
    var targetUrl = validateCopilotUrl(url) || DEFAULT_COPILOT_CHAT_URL;
    try {
      if (typeof GM_openInTab === "function") {
        GM_openInTab(targetUrl, { active: true, insert: true, setParent: true });
      } else {
        window.open(targetUrl, "_blank", "noopener,noreferrer");
      }
      return true;
    } catch (err) {
      return false;
    }
  }

  function showToast(message, isError) {
    var existing = document.getElementById("tm-copilot-toast");
    if (existing) existing.remove();

    var toast = document.createElement("div");
    toast.id = "tm-copilot-toast";
    toast.textContent = message;

    toast.style.position = "fixed";
    toast.style.right = "14px";
    toast.style.bottom = "14px";
    toast.style.zIndex = "999999";
    toast.style.background = isError ? "#8b1e1e" : "#1f4f1f";
    toast.style.color = "#ffffff";
    toast.style.padding = "10px 12px";
    toast.style.borderRadius = "6px";
    toast.style.boxShadow = "0 4px 12px rgba(0,0,0,0.25)";
    toast.style.fontFamily = "Segoe UI, Arial, sans-serif";
    toast.style.fontSize = "12px";
    toast.style.maxWidth = "420px";
    toast.style.whiteSpace = "normal";

    document.body.appendChild(toast);
    setTimeout(function () {
      if (toast && toast.parentNode) toast.parentNode.removeChild(toast);
    }, 4200);
  }

  function collectTicketDetails() {
    var communicationEntries = getCommunicationEntries();

    return {
      ticketNumber: getTicketNumber(),
      subject: getTicketSubject(),
      status: getTicketField("Status"),
      priority: getTicketField("Priority"),
      assignee: getTicketField("Assignee"),
      customer: getCustomerName(),
      contact: getCustomerField("Assigned Contact"),
      email: getPrimaryEmail(),
      phone: getPrimaryPhone(),
      created: getTicketField("Created"),
      due: getTicketField("Due Date"),
      aiSummary: findAiSummaryText(),
      communicationHistory: formatCommunicationHistory(communicationEntries),
      url: window.location.href
    };
  }

  async function runAssistForMode(mode) {
    if (AUTO_EXPAND_SHOW_MORE_COMMENTS) {
      showToast("Loading full comment history from any Show more links...", false);
      var loadInfo = await expandAllShowMoreComments();
      if (loadInfo.expandedCount > 0) {
        showToast(
          "Loaded " + loadInfo.expandedCount + " additional comment section(s). Building Copilot prompt now.",
          false
        );
      }
    }

    var details = collectTicketDetails();
    var prompt = buildPrompt(mode, details);
    var copilotUrl = getPreferredCopilotUrl();

    var copied = copyText(prompt);
    var opened = openCopilot(copilotUrl);

    if (copied && opened) {
      showToast("Detailed ticket context copied. Copilot opened. Paste manually with Ctrl+V.", false);
      return;
    }

    if (copied && !opened) {
      showToast("Ticket context copied, but Copilot window could not be opened automatically.", true);
      return;
    }

    showToast("Could not copy ticket context automatically. Browser permission may be blocking clipboard access.", true);
  }

  function addAssistButton() {
    if (document.getElementById("tm-copilot-assist-wrap")) return;

    var targetBar = document.querySelector(".title-btns") || document.querySelector(".btn-bar");
    if (!targetBar) return;

    var wrap = document.createElement("div");
    wrap.id = "tm-copilot-assist-wrap";
    wrap.style.position = "relative";
    wrap.style.display = "inline-block";
    wrap.style.marginRight = "8px";

    var btn = document.createElement("button");
    btn.id = "tm-copilot-assist-btn";
    btn.type = "button";
    btn.className = "btn btn-default btn-xs";
    btn.textContent = "Copilot Assist \u25be";
    btn.title = "Select Copilot Assist mode. Shift+Click: configure your saved agent URL.";

    var menu = document.createElement("div");
    menu.id = "tm-copilot-assist-menu";
    menu.style.position = "absolute";
    menu.style.top = "100%";
    menu.style.left = "0";
    menu.style.minWidth = "230px";
    menu.style.marginTop = "4px";
    menu.style.padding = "4px";
    menu.style.background = "#ffffff";
    menu.style.border = "1px solid #d9dce3";
    menu.style.borderRadius = "6px";
    menu.style.boxShadow = "0 6px 18px rgba(0,0,0,0.18)";
    menu.style.zIndex = "100080";
    menu.style.display = "none";

    function setMenuOpen(open) {
      menu.style.display = open ? "block" : "none";
      btn.setAttribute("aria-expanded", open ? "true" : "false");
    }

    var modeOptions = getAssistModeOptions();
    for (var i = 0; i < modeOptions.length; i++) {
      (function (opt) {
        var item = document.createElement("button");
        item.type = "button";
        item.className = "btn btn-default btn-xs";
        item.textContent = opt.label;
        item.style.display = "block";
        item.style.width = "100%";
        item.style.margin = "0";
        item.style.marginBottom = i < modeOptions.length - 1 ? "4px" : "0";
        item.style.textAlign = "left";
        item.style.whiteSpace = "normal";
        item.addEventListener("click", async function (event) {
          event.preventDefault();
          event.stopPropagation();
          setMenuOpen(false);
          await runAssistForMode(opt.key);
        });
        menu.appendChild(item);
      })(modeOptions[i]);
    }

    btn.addEventListener("click", async function (event) {
      if (event && event.shiftKey) {
        setMenuOpen(false);
        getPreferredCopilotUrl({ forceConfigure: true, skipPrompt: true });
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      setMenuOpen(menu.style.display !== "block");
    });

    document.addEventListener("click", function (event) {
      if (!wrap.contains(event.target)) setMenuOpen(false);
    });

    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape") {
        setMenuOpen(false);
      }
    });

    wrap.appendChild(btn);
    wrap.appendChild(menu);

    if (targetBar.firstElementChild) {
      targetBar.insertBefore(wrap, targetBar.firstElementChild);
    } else {
      targetBar.appendChild(wrap);
    }
  }

  function onMutations(mutations) {
    for (var i = 0; i < mutations.length; i++) {
      if (mutations[i].addedNodes && mutations[i].addedNodes.length > 0) {
        addAssistButton();
        return;
      }
    }
  }

  function boot() {
    addAssistButton();

    var root = document.querySelector("#main") || document.body;
    var observer = new MutationObserver(onMutations);
    observer.observe(root, { childList: true, subtree: true });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
