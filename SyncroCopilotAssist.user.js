// ==UserScript==
// @name         Syncro - Copilot Assist
// @namespace    http://tampermonkey.net/
// @version      1.6.0
// @description  Copy Syncro ticket context for Copilot, or send directly to Claude API for inline analysis. Includes shared settings panel for both assistants.
// @author       Gary Herbstman
// @match        https://*.syncromsp.com/tickets/*
// @match        https://*.shield.syncromsp.com/tickets/*
// @grant        GM_setClipboard
// @grant        GM_openInTab
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @connect      api.anthropic.com
// @downloadURL  https://raw.githubusercontent.com/gherbstman/SyncroTamperMonkey/main/SyncroCopilotAssist.user.js
// @updateURL    https://raw.githubusercontent.com/gherbstman/SyncroTamperMonkey/main/SyncroCopilotAssist.user.js
// ==/UserScript==

(function () {
  "use strict";

  var DEFAULT_COPILOT_CHAT_URL = "https://m365.cloud.microsoft/chat";
  var AGENT_URL_STORAGE_KEY = "tmCopilotPreferredAgentUrl";
  var AI_COMPONENTS_STORAGE_KEY = "tmAiAssistComponents";
  var AUTO_EXPAND_SHOW_MORE_COMMENTS = true;

  /* ── Claude constants ── */
  var CLAUDE_API_URL = "https://api.anthropic.com/v1/messages";
  var CLAUDE_API_KEY_STORAGE_KEY  = "tmClaudeApiKey";
  var CLAUDE_MODEL_STORAGE_KEY    = "tmClaudeModel";
  var CLAUDE_MAX_TOKENS_STORAGE_KEY = "tmClaudeMaxTokens";
  var CLAUDE_DEFAULT_MODEL      = "claude-haiku-4-5-20251001";
  var CLAUDE_DEFAULT_MAX_TOKENS = 3000;
  var CLAUDE_AVAILABLE_MODELS = [
    { value: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5 (Fast / Low Cost)" },
    { value: "claude-sonnet-4-6",         label: "Claude Sonnet 4.6 (Higher Quality)" }
  ];


  /* ── Prompt configuration constants ── */
  var AI_PERSONA_STORAGE_KEY       = "tmAiPersona";
  var AI_PROMPT_CONFIG_STORAGE_KEY = "tmAiPromptConfig";
  var DEFAULT_PERSONA       = "You are assisting an MSP technician with a Syncro ticket.";
  var DEFAULT_RULES         = "- Keep assumptions explicit.\n- If information is missing, list clarifying questions.\n- Keep recommendations practical and low-risk.\n- Use the communication history as the source of truth for chronology and context.";
  var DEFAULT_OUTPUT_FORMAT = "1) Quick understanding summary\n2) Most likely root causes\n3) Immediate next actions\n4) Draft response text\n5) Follow-up questions";
  var DEFAULT_TASK_LINES    = {
    both:      "Provide both a customer-facing response and an internal diagnosis plan.",
    response:  "Draft a customer-facing response for this ticket.",
    diagnosis: "Provide a technical diagnosis and step-by-step remediation plan."
  };
  var MAX_OUTPUT_FORMAT_ITEMS = 10;

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
        if (!td) return "";

        // When field is rendered as a <select> (e.g., Status/Priority),
        // use only the currently selected option text.
        var selectEl = td.querySelector("select");
        if (selectEl && selectEl.options && selectEl.selectedIndex >= 0) {
          var selected = selectEl.options[selectEl.selectedIndex];
          var selectedText = safeText(selected);
          if (selectedText) return selectedText;
        }

        return safeText(td);
      }
    }

    return "";
  }

  function getSelectedOptionText(selectEl) {
    if (!selectEl || !selectEl.options || !selectEl.options.length) return "";

    if (selectEl.selectedOptions && selectEl.selectedOptions.length) {
      return safeText(selectEl.selectedOptions[0]);
    }

    if (selectEl.selectedIndex >= 0 && selectEl.options[selectEl.selectedIndex]) {
      return safeText(selectEl.options[selectEl.selectedIndex]);
    }

    // Fallback for pages that mark selected in markup but don't expose selectedIndex reliably.
    var explicit = selectEl.querySelector("option[selected], option[selected='selected']");
    if (explicit) return safeText(explicit);

    return "";
  }

  function getTicketStatus() {
    var statusSelect = document.getElementById("ticket_status") || document.querySelector("select[name='ticket_status']");
    var selectedText = getSelectedOptionText(statusSelect);
    if (selectedText) return selectedText;

    return getTicketField("Status");
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

  function getAssignedContact() {
    // Prefer tooltip/source value over visible inline text to avoid id-like placeholders.
    var customerWidgetHeaders = document.querySelectorAll(".widget-header h3");
    var customerWidget = null;

    for (var i = 0; i < customerWidgetHeaders.length; i++) {
      if (safeText(customerWidgetHeaders[i]) === "Customer Info") {
        customerWidget = customerWidgetHeaders[i].closest(".widget");
        break;
      }
    }

    if (customerWidget) {
      var ths = customerWidget.querySelectorAll("th");
      for (var j = 0; j < ths.length; j++) {
        if (safeText(ths[j]) === "Assigned Contact") {
          var td = ths[j].nextElementSibling;
          if (!td) break;

          var attrHolder = td.querySelector("[data-original-title]") || td;
          var originalTitle = attrHolder.getAttribute && attrHolder.getAttribute("data-original-title");
          if (originalTitle && String(originalTitle).trim()) {
            return String(originalTitle).trim();
          }

          return safeText(td);
        }
      }
    }

    var globalHolder = document.querySelector("[id*='_contact_'][data-original-title], [id*='_contact_'] [data-original-title]");
    if (globalHolder) {
      var globalTitle = globalHolder.getAttribute("data-original-title");
      if (globalTitle && String(globalTitle).trim()) return String(globalTitle).trim();
    }

    return getCustomerField("Assigned Contact");
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
    var commentList = document.querySelector("div.comment-list.pbm");
    var nodes = commentList
      ? commentList.querySelectorAll(
          "div[id^='comment-'][data-testid='reply-comment'], div[id^='comment-'].hover-parent, .ticket-comment, .comment"
        )
      : document.querySelectorAll(".ticket-comment, .comment, .timeline-item, .activity-item, .communication-item, .note");

    function extractCommentBodyText(node) {
      if (!node) return "";

      var bodyEl = node.querySelector(
        "div[id^='comment-body-'], .rich-text-comment, div[id^='purify-text-comment-'], .comment-body, .ticket-comment-body, .fr-view, .body"
      );
      if (!bodyEl) return "";

      // Clone so we can remove non-content nodes without mutating the page.
      var clone = bodyEl.cloneNode(true);
      var junk = clone.querySelectorAll("script, style, noscript, .hover-actions, .btn-group, .dropdown-menu");
      for (var k = 0; k < junk.length; k++) {
        if (junk[k] && junk[k].parentNode) junk[k].parentNode.removeChild(junk[k]);
      }

      return safeBlockText(clone);
    }

    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];

      var author =
        safeText(node.querySelector(".author-label, .comment-author, .author, .user-name, .media-heading a, .ticket-comment-header a")) ||
        node.getAttribute("data-author") ||
        node.getAttribute("data-user-name") ||
        "Unknown";

      var timeEl = node.querySelector(".meta .mrm[title], .meta [title], time, .comment-date, .date, .timestamp, [data-time]");
      var timestamp =
        (timeEl && (timeEl.getAttribute("datetime") || timeEl.getAttribute("title") || safeText(timeEl))) ||
        node.getAttribute("data-time") ||
        node.getAttribute("data-created-at") ||
        "Unknown";

      var body = extractCommentBodyText(node);

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
    var builtIn = [
      { key: "both",      label: "Both (Response + Diagnosis)" },
      { key: "response",  label: "Response Draft" },
      { key: "diagnosis", label: "Diagnosis Help" }
    ];
    try {
      var config = getStoredPromptConfig();
      var custom = config.custom || [];
      for (var i = 0; i < custom.length; i++) {
        if (custom[i].key && custom[i].label) {
          builtIn.push({
            key: custom[i].key,
            label: "\u2605 " + truncatePromptLabel(custom[i].label, 40),
            title: custom[i].label
          });
        }
      }
    } catch (e) {}
    return builtIn;
  }

  function truncatePromptLabel(label, maxChars) {
    var text = String(label || "").trim();
    var limit = typeof maxChars === "number" && maxChars > 0 ? maxChars : 40;
    if (text.length <= limit) return text;
    return text.slice(0, Math.max(0, limit - 1)).replace(/[\s\u00A0]+$/g, "") + "…";
  }

  function parseOutputFormatText(rawText) {
    var raw = String(rawText || "").replace(/\r/g, "");
    var lines = raw.split("\n");
    var out = [];
    for (var i = 0; i < lines.length; i++) {
      var text = String(lines[i] || "").trim();
      if (!text) continue;
      text = text.replace(/^\d+[\.)]\s*/, "").replace(/^[-*]\s+/, "").trim();
      if (!text) continue;
      out.push({ text: text, defaultOn: true });
      if (out.length >= MAX_OUTPUT_FORMAT_ITEMS) break;
    }
    return out;
  }

  function getDefaultOutputItems() {
    return parseOutputFormatText(DEFAULT_OUTPUT_FORMAT);
  }

  function sanitizeOutputItems(items, fallbackText) {
    var source = Array.isArray(items) ? items : [];
    var out = [];
    for (var i = 0; i < source.length; i++) {
      var item = source[i] || {};
      var text = String(item.text || "").trim();
      if (!text) continue;
      out.push({
        text: text,
        defaultOn: item.defaultOn !== false
      });
      if (out.length >= MAX_OUTPUT_FORMAT_ITEMS) break;
    }

    if (!out.length && fallbackText) out = parseOutputFormatText(fallbackText);
    if (!out.length) out = getDefaultOutputItems();

    return out;
  }

  function outputItemsToPromptText(items) {
    var clean = sanitizeOutputItems(items, "");
    var lines = [];
    for (var i = 0; i < clean.length; i++) {
      lines.push((i + 1) + ") " + clean[i].text);
    }
    return lines.join("\n");
  }

  function getModeTemplateForRequest(config, requestType) {
    var customList = config.custom || [];
    for (var i = 0; i < customList.length; i++) {
      if (customList[i].key === requestType) {
        return {
          taskLine: String(customList[i].taskLine || "").trim(),
          rules: String(customList[i].rules || "").trim() || DEFAULT_RULES,
          outputItems: sanitizeOutputItems(customList[i].outputItems, customList[i].outputFormat)
        };
      }
    }

    var modeConfig = (config.modes && config.modes[requestType]) || {};
    return {
      taskLine: DEFAULT_TASK_LINES[requestType] || "",
      rules: String(modeConfig.rules || "").trim() || DEFAULT_RULES,
      outputItems: sanitizeOutputItems(modeConfig.outputItems, modeConfig.outputFormat)
    };
  }

  function buildPrompt(requestType, details, selectedOutputItems, additionalGuidance) {
    var persona = getStoredPersona() || DEFAULT_PERSONA;
    var config  = getStoredPromptConfig();
    var template = getModeTemplateForRequest(config, requestType);
    var taskLine = template.taskLine;
    var rules = template.rules;
    var outputFormat = outputItemsToPromptText(selectedOutputItems && selectedOutputItems.length ? selectedOutputItems : template.outputItems);
    var ticketSubject = String(details.subject || "").trim() || "Unknown";
    var guidance = String(additionalGuidance || "").trim();

    var lines = ["Ticket Subject: " + ticketSubject, persona];
    if (taskLine) lines.push(taskLine);
    if (guidance) {
      lines.push("", "Additional guidance:", guidance);
    }
    lines.push(
      "",
      "Rules:",
      rules,
      "",
      "Ticket details:",
      "- Ticket Number: " + (details.ticketNumber || "Unknown"),
      "- Subject: "       + (details.subject       || "Unknown"),
      "- Status: "        + (details.status         || "Unknown"),
      "- Priority: "      + (details.priority       || "Unknown"),
      "- Assignee: "      + (details.assignee       || "Unknown"),
      "- Customer: "      + (details.customer       || "Unknown"),
      "- Contact: "       + (details.contact        || "Unknown"),
      "- Email: "         + (details.email          || "Unknown"),
      "- Phone: "         + (details.phone          || "Unknown"),
      "- Created: "       + (details.created        || "Unknown"),
      "- Due: "           + (details.due            || "Unknown"),
      "- Ticket URL: "    + (details.url            || "Unknown"),
      "",
      "AI Summary:",
      details.aiSummary || "No AI summary found.",
      "",
      "Communication history (initial request + replies):",
      details.communicationHistory || "No communication entries found.",
      "",
      "Output format:",
      outputFormat
    );
    return lines.join("\n");
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

  /* ═══════════════════ CLAUDE STORAGE ═══════════════════ */

  function getStoredClaudeApiKey() {
    try {
      if (typeof GM_getValue === "function") return GM_getValue(CLAUDE_API_KEY_STORAGE_KEY, "") || "";
    } catch (e) {}
    return "";
  }

  function setStoredClaudeApiKey(key) {
    try {
      if (typeof GM_setValue === "function") GM_setValue(CLAUDE_API_KEY_STORAGE_KEY, key || "");
    } catch (e) {}
  }

  function getStoredClaudeModel() {
    try {
      if (typeof GM_getValue === "function") return GM_getValue(CLAUDE_MODEL_STORAGE_KEY, "") || CLAUDE_DEFAULT_MODEL;
    } catch (e) {}
    return CLAUDE_DEFAULT_MODEL;
  }

  function setStoredClaudeModel(model) {
    try {
      if (typeof GM_setValue === "function") GM_setValue(CLAUDE_MODEL_STORAGE_KEY, model || CLAUDE_DEFAULT_MODEL);
    } catch (e) {}
  }

  function getStoredClaudeMaxTokens() {
    try {
      if (typeof GM_getValue === "function") {
        var v = parseInt(GM_getValue(CLAUDE_MAX_TOKENS_STORAGE_KEY, "") || "", 10);
        if (!isNaN(v) && v > 0) return v;
      }
    } catch (e) {}
    return CLAUDE_DEFAULT_MAX_TOKENS;
  }

  function setStoredClaudeMaxTokens(tokens) {
    try {
      if (typeof GM_setValue === "function") GM_setValue(CLAUDE_MAX_TOKENS_STORAGE_KEY, String(tokens || CLAUDE_DEFAULT_MAX_TOKENS));
    } catch (e) {}
  }

  /* ═══════════════════ PROMPT CONFIG STORAGE ═══════════════════ */

  function getStoredPersona() {
    try {
      if (typeof GM_getValue === "function") return GM_getValue(AI_PERSONA_STORAGE_KEY, "") || "";
    } catch (e) {}
    return "";
  }

  function setStoredPersona(val) {
    try {
      if (typeof GM_setValue === "function") GM_setValue(AI_PERSONA_STORAGE_KEY, String(val || ""));
    } catch (e) {}
  }

  function getStoredPromptConfig() {
    try {
      if (typeof GM_getValue === "function") {
        var raw = GM_getValue(AI_PROMPT_CONFIG_STORAGE_KEY, "") || "";
        if (raw) {
          var parsed = JSON.parse(raw);
          parsed.modes = parsed.modes || {};
          parsed.custom = parsed.custom || [];

          var modeKeys = ["both", "response", "diagnosis"];
          for (var mi = 0; mi < modeKeys.length; mi++) {
            var mk = modeKeys[mi];
            parsed.modes[mk] = parsed.modes[mk] || {};
            parsed.modes[mk].outputItems = sanitizeOutputItems(parsed.modes[mk].outputItems, parsed.modes[mk].outputFormat);
          }

          for (var ci = 0; ci < parsed.custom.length; ci++) {
            parsed.custom[ci].outputItems = sanitizeOutputItems(parsed.custom[ci].outputItems, parsed.custom[ci].outputFormat);
          }

          return parsed;
        }
      }
    } catch (e) {}
    return { modes: {}, custom: [] };
  }

  function setStoredPromptConfig(config) {
    try {
      if (typeof GM_setValue === "function") {
        GM_setValue(AI_PROMPT_CONFIG_STORAGE_KEY, JSON.stringify(config || { modes: {}, custom: [] }));
      }
    } catch (e) {}
  }

  function getStoredAiComponents() {
    var defaults = { copilotEnabled: true, claudeEnabled: true };
    try {
      if (typeof GM_getValue === "function") {
        var raw = GM_getValue(AI_COMPONENTS_STORAGE_KEY, "") || "";
        if (!raw) return defaults;
        var parsed = JSON.parse(raw);
        return {
          copilotEnabled: parsed.copilotEnabled !== false,
          claudeEnabled: parsed.claudeEnabled !== false
        };
      }
    } catch (e) {}
    return defaults;
  }

  function setStoredAiComponents(components) {
    var safe = {
      copilotEnabled: !!(components && components.copilotEnabled),
      claudeEnabled: !!(components && components.claudeEnabled)
    };
    try {
      if (typeof GM_setValue === "function") GM_setValue(AI_COMPONENTS_STORAGE_KEY, JSON.stringify(safe));
    } catch (e) {}
    return safe;
  }

  /* ═══════════════════ CLAUDE API CALL ═══════════════════ */

  function callClaudeApi(prompt) {
    var apiKey   = getStoredClaudeApiKey();
    var model    = getStoredClaudeModel();
    var maxTokens = getStoredClaudeMaxTokens();

    return new Promise(function (resolve, reject) {
      if (!apiKey) {
        reject(new Error("No Claude API key configured. Open Settings to add your Anthropic API key."));
        return;
      }

      GM_xmlhttpRequest({
        method: "POST",
        url: CLAUDE_API_URL,
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01"
        },
        data: JSON.stringify({
          model: model,
          max_tokens: maxTokens,
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
        onerror: function () {
          reject(new Error("Network error contacting Claude API. Check your connection and try again."));
        },
        ontimeout: function () {
          reject(new Error("Request to Claude API timed out. Please try again."));
        },
        timeout: 60000
      });
    });
  }

  /* ═══════════════════ CLAUDE PANEL UI ═══════════════════ */

  function injectClaudePanelStyles() {
    if (document.getElementById("tm-claude-styles")) return;
    var style = document.createElement("style");
    style.id = "tm-claude-styles";
    style.textContent = [
      "#tm-claude-overlay { position: fixed; inset: 0; z-index: 200000;",
      "  background: rgba(0,0,0,0.45); display: flex; align-items: center; justify-content: center; }",
      "#tm-claude-panel { background: #fff; border-radius: 8px;",
      "  box-shadow: 0 8px 32px rgba(0,0,0,0.28); width: min(820px, 94vw); max-height: 85vh;",
      "  display: flex; flex-direction: column;",
      "  font-family: 'Segoe UI', Arial, sans-serif; font-size: 13px; }",
      "#tm-claude-panel-header { display: flex; align-items: center; justify-content: space-between;",
      "  padding: 12px 16px; border-bottom: 1px solid #e0e0e0;",
      "  background: #1a1a2e; border-radius: 8px 8px 0 0; }",
      "#tm-claude-panel-header span { color: #fff; font-weight: 700; font-size: 14px; }",
      "#tm-claude-panel-header-btns { display: flex; gap: 8px; }",
      "#tm-claude-panel-header-btns button { padding: 4px 10px; border-radius: 4px;",
      "  border: 1px solid rgba(255,255,255,0.3); background: rgba(255,255,255,0.1);",
      "  color: #fff; cursor: pointer; font-size: 12px; font-weight: 500; }",
      "#tm-claude-panel-header-btns button:hover { background: rgba(255,255,255,0.25); }",
      "#tm-claude-panel-body { overflow-y: auto; padding: 16px 18px; flex: 1;",
      "  white-space: pre-wrap; line-height: 1.6; color: #222; }",
      "#tm-claude-panel-footer { padding: 10px 16px; border-top: 1px solid #e0e0e0;",
      "  display: flex; gap: 8px; justify-content: flex-end;",
      "  background: #f7f8fb; border-radius: 0 0 8px 8px; }",
      "#tm-claude-panel-footer button { padding: 5px 14px; border-radius: 4px; cursor: pointer;",
      "  border: 1px solid #c0c4cc; background: #fff; font-size: 12px; font-weight: 500; color: #333; }",
      "#tm-claude-panel-footer button:hover { background: #eef2f7; }",
      "#tm-claude-panel-footer .tm-claude-btn-primary { background: #1a1a2e; color: #fff; border-color: #1a1a2e; }",
      "#tm-claude-panel-footer .tm-claude-btn-primary:hover { background: #2d2d50; }",
      ".tm-claude-loading { display: flex; flex-direction: column; align-items: center;",
      "  justify-content: center; padding: 40px; gap: 12px; color: #555; }",
      ".tm-claude-spinner { width: 32px; height: 32px; border: 3px solid #e0e0e0;",
      "  border-top-color: #1a1a2e; border-radius: 50%; animation: tm-spin 0.8s linear infinite; }",
      "@keyframes tm-spin { to { transform: rotate(360deg); } }",
      ".tm-claude-error { color: #8b1e1e; padding: 12px; background: #fff5f5;",
      "  border-radius: 6px; border: 1px solid #f5c6c6; }",
      ".tm-claude-error-actions { margin-top: 10px; display: flex; gap: 8px; flex-wrap: wrap; }",
      ".tm-claude-error-actions button { padding: 5px 12px; border-radius: 4px; cursor: pointer;",
      "  border: 1px solid #c0c4cc; background: #fff; font-size: 12px; font-weight: 500; }"
    ].join("\n");
    document.head.appendChild(style);
  }

  function showClaudePanel(titleSuffix) {
    injectClaudePanelStyles();
    var existing = document.getElementById("tm-claude-overlay");
    if (existing) existing.remove();

    var overlay = document.createElement("div");
    overlay.id = "tm-claude-overlay";

    var panel = document.createElement("div");
    panel.id = "tm-claude-panel";

    var header = document.createElement("div");
    header.id = "tm-claude-panel-header";

    var title = document.createElement("span");
    title.textContent = "Claude Assist" + (titleSuffix ? " \u2013 " + titleSuffix : "");

    var headerBtns = document.createElement("div");
    headerBtns.id = "tm-claude-panel-header-btns";

    var closeBtn = document.createElement("button");
    closeBtn.textContent = "Close";
    closeBtn.addEventListener("click", function () { overlay.remove(); });
    headerBtns.appendChild(closeBtn);
    header.appendChild(title);
    header.appendChild(headerBtns);

    var body = document.createElement("div");
    body.id = "tm-claude-panel-body";

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

    overlay.addEventListener("click", function (e) { if (e.target === overlay) overlay.remove(); });

    function onEsc(e) {
      if (e.key === "Escape") { overlay.remove(); document.removeEventListener("keydown", onEsc); }
    }
    document.addEventListener("keydown", onEsc);

    return { overlay: overlay, body: body, footer: footer, title: title };
  }

  function setClaudeLoading(body, message) {
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

  function setClaudeResult(body, footer, text, rawPrompt) {
    body.innerHTML = "";
    body.textContent = text;

    var copyResponseBtn = document.createElement("button");
    copyResponseBtn.textContent = "Copy Response";
    copyResponseBtn.className = "tm-claude-btn-primary";
    copyResponseBtn.addEventListener("click", function () {
      try {
        if (typeof GM_setClipboard === "function") GM_setClipboard(text, "text");
        else navigator.clipboard.writeText(text);
        copyResponseBtn.textContent = "Copied!";
        setTimeout(function () { copyResponseBtn.textContent = "Copy Response"; }, 1800);
      } catch (e) {}
    });

    var copyPromptBtn = document.createElement("button");
    copyPromptBtn.textContent = "Copy Prompt";
    copyPromptBtn.title = "Copy the raw prompt sent to Claude";
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

  function setClaudeError(body, footer, errorMessage, rawPrompt, onRetry) {
    body.innerHTML = "";
    var wrap = document.createElement("div");
    wrap.className = "tm-claude-error";

    var msg = document.createElement("div");
    msg.textContent = "Error: " + errorMessage;

    var actions = document.createElement("div");
    actions.className = "tm-claude-error-actions";

    if (typeof onRetry === "function") {
      var retryBtn = document.createElement("button");
      retryBtn.textContent = "Retry";
      retryBtn.addEventListener("click", function () { onRetry(); });
      actions.appendChild(retryBtn);
    }

    var settingsBtn = document.createElement("button");
    settingsBtn.textContent = "Open Settings";
    settingsBtn.addEventListener("click", function () { showSettingsModal(); });
    actions.appendChild(settingsBtn);

    var copyPromptBtn = document.createElement("button");
    copyPromptBtn.textContent = "Copy Prompt (Fallback)";
    copyPromptBtn.title = "Copy the prompt so you can paste it into Claude.ai manually";
    copyPromptBtn.addEventListener("click", function () {
      try {
        if (typeof GM_setClipboard === "function") GM_setClipboard(rawPrompt, "text");
        else navigator.clipboard.writeText(rawPrompt);
        copyPromptBtn.textContent = "Copied!";
        setTimeout(function () { copyPromptBtn.textContent = "Copy Prompt (Fallback)"; }, 1800);
      } catch (e) {}
    });
    actions.appendChild(copyPromptBtn);

    var openClaudeBtn = document.createElement("button");
    openClaudeBtn.textContent = "Open Claude.ai";
    openClaudeBtn.addEventListener("click", function () { window.open("https://claude.ai", "_blank", "noopener,noreferrer"); });
    actions.appendChild(openClaudeBtn);

    wrap.appendChild(msg);
    wrap.appendChild(actions);
    body.appendChild(wrap);
  }

  /* ═══════════════════ SETTINGS MODAL ═══════════════════ */

  function showSettingsModal() {
    var existing = document.getElementById("tm-settings-overlay");
    if (existing) existing.remove();

    if (!document.getElementById("tm-settings-styles")) {
      var style = document.createElement("style");
      style.id = "tm-settings-styles";
      style.textContent = [
        "#tm-settings-overlay { position: fixed; inset: 0; z-index: 300000;",
        "  background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; }",
        "#tm-settings-panel { background: #fff; border-radius: 8px;",
        "  box-shadow: 0 8px 32px rgba(0,0,0,0.3); width: min(520px, 94vw);",
        "  font-family: 'Segoe UI', Arial, sans-serif; font-size: 13px; display: flex; flex-direction: column; }",
        "#tm-settings-header { display: flex; align-items: center; justify-content: space-between;",
        "  padding: 12px 16px; background: #1f4f1f; border-radius: 8px 8px 0 0; }",
        "#tm-settings-header span { color: #fff; font-weight: 700; font-size: 14px; }",
        "#tm-settings-header button { background: rgba(255,255,255,0.15);",
        "  border: 1px solid rgba(255,255,255,0.3); color: #fff; border-radius: 4px;",
        "  cursor: pointer; padding: 3px 9px; font-size: 12px; }",
        "#tm-settings-body { padding: 16px 18px; overflow-y: auto; max-height: 70vh; }",
        ".tm-settings-section { margin-bottom: 18px; }",
        ".tm-settings-section-title { font-weight: 700; font-size: 11px; text-transform: uppercase;",
        "  letter-spacing: 0.05em; color: #555; margin-bottom: 10px; padding-bottom: 4px;",
        "  border-bottom: 1px solid #e0e0e0; }",
        ".tm-settings-field { margin-bottom: 12px; }",
        ".tm-settings-field label { display: block; font-weight: 600; margin-bottom: 4px;",
        "  color: #333; font-size: 12px; }",
        ".tm-settings-field input, .tm-settings-field select { width: 100%; padding: 6px 8px;",
        "  border: 1px solid #c0c4cc; border-radius: 4px; font-size: 12px; box-sizing: border-box; }",
        ".tm-settings-hint { font-size: 11px; color: #777; margin-top: 3px; }",
        "#tm-settings-footer { padding: 10px 16px; border-top: 1px solid #e0e0e0;",
        "  display: flex; gap: 8px; justify-content: flex-end;",
        "  background: #f7f8fb; border-radius: 0 0 8px 8px; }",
        "#tm-settings-footer button { padding: 6px 16px; border-radius: 4px; cursor: pointer;",
        "  border: 1px solid #c0c4cc; background: #fff; font-size: 12px; font-weight: 500; color: #333; }",
        "#tm-settings-footer .tm-settings-save { background: #1f4f1f; color: #fff; border-color: #1f4f1f; }",
        "#tm-settings-footer .tm-settings-save:hover { background: #2a6b2a; }",
        ".tm-settings-textarea { width: 100%; padding: 6px 8px; border: 1px solid #c0c4cc; border-radius: 4px; font-size: 12px; box-sizing: border-box; font-family: 'Segoe UI', Arial, sans-serif; resize: vertical; }",
        ".tm-settings-reset { font-size: 11px; color: #1f4f1f; cursor: pointer; text-decoration: underline; margin-top: 3px; display: inline-block; }",
        ".tm-settings-tabs { display: flex; gap: 2px; margin-bottom: -1px; flex-wrap: wrap; }",
        ".tm-settings-tab { padding: 5px 12px; border: 1px solid #c0c4cc; border-radius: 4px 4px 0 0; background: #f0f0f0; cursor: pointer; font-size: 12px; font-weight: 500; color: #555; border-bottom: none; }",
        ".tm-settings-tab.tm-tab-active { background: #fff; color: #1f4f1f; font-weight: 700; }",
        ".tm-settings-tab-pane { display: none; border: 1px solid #c0c4cc; border-radius: 0 4px 4px 4px; padding: 12px; background: #fff; }",
        ".tm-settings-tab-pane.tm-pane-active { display: block; }",
        ".tm-custom-prompt-list { max-height: 240px; overflow-y: auto; padding-right: 2px; }",
        ".tm-custom-prompt-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; padding: 6px 8px; border: 1px solid #e0e0e0; border-radius: 4px; margin-bottom: 6px; background: #f9f9f9; }",
        ".tm-custom-prompt-row span { font-size: 12px; font-weight: 600; color: #333; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }",
        ".tm-cp-actions { display: flex; gap: 4px; flex-shrink: 0; }",
        ".tm-cp-actions button { padding: 2px 8px; font-size: 11px; border-radius: 3px; border: 1px solid #c0c4cc; background: #fff; cursor: pointer; }",
        ".tm-output-list { display: flex; flex-direction: column; gap: 6px; }",
        ".tm-output-row { display: flex; align-items: center; gap: 8px; }",
        ".tm-output-row input[type='text'] { flex: 1; }",
        ".tm-output-row .tm-output-default { display: flex; align-items: center; gap: 4px; white-space: nowrap; font-size: 11px; color: #555; margin: 0; font-weight: 500; }",
        ".tm-output-row .tm-output-remove { padding: 2px 7px; border: 1px solid #c0c4cc; border-radius: 3px; background: #fff; cursor: pointer; color: #8b1e1e; }",
        ".tm-settings-checkbox-label { display: flex !important; align-items: center; gap: 8px; margin-bottom: 0 !important; }"
      ].join("\n");
      document.head.appendChild(style);
    }

    var overlay = document.createElement("div");
    overlay.id = "tm-settings-overlay";

    var panel = document.createElement("div");
    panel.id = "tm-settings-panel";

    /* Header */
    var header = document.createElement("div");
    header.id = "tm-settings-header";
    var headerTitle = document.createElement("span");
    headerTitle.textContent = "Copilot & Claude Assist \u2014 Settings";
    var headerClose = document.createElement("button");
    headerClose.textContent = "\u2715";
    headerClose.addEventListener("click", function () { overlay.remove(); });
    header.appendChild(headerTitle);
    header.appendChild(headerClose);

    /* Body */
    var body = document.createElement("div");
    body.id = "tm-settings-body";
    var componentSettings = getStoredAiComponents();

    /* ── Copilot section ── */
    function makeSection(titleText) {
      var sec = document.createElement("div");
      sec.className = "tm-settings-section";
      var t = document.createElement("div");
      t.className = "tm-settings-section-title";
      t.textContent = titleText;
      sec.appendChild(t);
      return sec;
    }

    function makeField(labelText, inputEl, hintText) {
      var field = document.createElement("div");
      field.className = "tm-settings-field";
      var lbl = document.createElement("label");
      lbl.textContent = labelText;
      field.appendChild(lbl);
      field.appendChild(inputEl);
      if (hintText) {
        var hint = document.createElement("div");
        hint.className = "tm-settings-hint";
        hint.textContent = hintText;
        field.appendChild(hint);
      }
      return field;
    }

    function makeCheckboxField(labelText, inputEl, hintText) {
      var field = document.createElement("div");
      field.className = "tm-settings-field";
      var lbl = document.createElement("label");
      lbl.className = "tm-settings-checkbox-label";
      lbl.appendChild(inputEl);
      lbl.appendChild(document.createTextNode(labelText));
      field.appendChild(lbl);
      if (hintText) {
        var hint = document.createElement("div");
        hint.className = "tm-settings-hint";
        hint.style.marginLeft = "24px";
        hint.textContent = hintText;
        field.appendChild(hint);
      }
      return field;
    }

    var componentSection = makeSection("AI Assist Components");
    var copilotEnabledInput = document.createElement("input");
    copilotEnabledInput.type = "checkbox";
    copilotEnabledInput.checked = componentSettings.copilotEnabled;
    var claudeEnabledInput = document.createElement("input");
    claudeEnabledInput.type = "checkbox";
    claudeEnabledInput.checked = componentSettings.claudeEnabled;

    componentSection.appendChild(makeCheckboxField(
      "Enable Copilot options",
      copilotEnabledInput,
      "When off, Copilot options are hidden from AI Assist menu."
    ));
    componentSection.appendChild(makeCheckboxField(
      "Enable Claude options",
      claudeEnabledInput,
      "When off, Claude options are hidden from AI Assist menu."
    ));
    body.appendChild(componentSection);

    var copilotSection = makeSection("Copilot Settings");

    var agentUrlInput = document.createElement("input");
    agentUrlInput.type = "url";
    agentUrlInput.placeholder = DEFAULT_COPILOT_CHAT_URL;
    agentUrlInput.value = getStoredPreferredAgentUrl() || "";
    copilotSection.appendChild(makeField(
      "Agent URL",
      agentUrlInput,
      "Optional. Must be https://m365.cloud.microsoft/chat\u2026 — leave blank to use standard chat."
    ));
    body.appendChild(copilotSection);

    /* ── Claude section ── */
    var claudeSection = makeSection("Claude Settings");

    var apiKeyInput = document.createElement("input");
    apiKeyInput.type = "password";
    apiKeyInput.placeholder = "sk-ant-\u2026";
    apiKeyInput.value = getStoredClaudeApiKey() || "";
    claudeSection.appendChild(makeField(
      "Anthropic API Key",
      apiKeyInput,
      "Stored securely in Tampermonkey. Get your key at console.anthropic.com."
    ));

    var modelSelect = document.createElement("select");
    var currentModel = getStoredClaudeModel();
    for (var mi = 0; mi < CLAUDE_AVAILABLE_MODELS.length; mi++) {
      var modelOpt = document.createElement("option");
      modelOpt.value = CLAUDE_AVAILABLE_MODELS[mi].value;
      modelOpt.textContent = CLAUDE_AVAILABLE_MODELS[mi].label;
      if (CLAUDE_AVAILABLE_MODELS[mi].value === currentModel) modelOpt.selected = true;
      modelSelect.appendChild(modelOpt);
    }
    claudeSection.appendChild(makeField(
      "Model",
      modelSelect,
      "Haiku is faster and cheaper; Sonnet provides higher-quality responses."
    ));

    var maxTokensInput = document.createElement("input");
    maxTokensInput.type = "number";
    maxTokensInput.min = "256";
    maxTokensInput.max = "8192";
    maxTokensInput.step = "256";
    maxTokensInput.value = String(getStoredClaudeMaxTokens());
    claudeSection.appendChild(makeField(
      "Max Response Tokens",
      maxTokensInput,
      "Length of Claude\u2019s response. Higher = longer output and more cost. Default: 3000."
    ));
    body.appendChild(claudeSection);

    /* ── Prompt Configuration section ── */
    var promptSection = makeSection("Prompt Configuration");

    /* Persona */
    var personaTextarea = document.createElement("textarea");
    personaTextarea.rows = 2;
    personaTextarea.className = "tm-settings-textarea";
    personaTextarea.placeholder = DEFAULT_PERSONA;
    personaTextarea.value = getStoredPersona() || "";
    var personaReset = document.createElement("span");
    personaReset.className = "tm-settings-reset";
    personaReset.textContent = "Reset to default";
    personaReset.addEventListener("click", function () { personaTextarea.value = DEFAULT_PERSONA; });
    var personaField = makeField(
      "AI Persona / System Context",
      personaTextarea,
      "Opening line of every prompt sent to any AI. Leave blank to use the default."
    );
    personaField.appendChild(personaReset);
    promptSection.appendChild(personaField);

    /* Mode Templates — tabbed */
    var tabBar = document.createElement("div");
    tabBar.className = "tm-settings-tabs";
    var tabPanesContainer = document.createElement("div");
    tabPanesContainer.style.marginBottom = "8px";

    var modeTemplatesLbl = document.createElement("label");
    modeTemplatesLbl.textContent = "Mode Templates";
    modeTemplatesLbl.style.display = "block";
    modeTemplatesLbl.style.marginBottom = "4px";
    modeTemplatesLbl.style.marginTop = "10px";
    var modeTemplatesHint = document.createElement("div");
    modeTemplatesHint.className = "tm-settings-hint";
    modeTemplatesHint.textContent = "Customise the Rules and Output Format for each built-in mode. Leave blank to use the defaults.";
    modeTemplatesHint.style.marginBottom = "6px";
    promptSection.appendChild(modeTemplatesLbl);
    promptSection.appendChild(modeTemplatesHint);

    var resetAllOutputsBtn = document.createElement("button");
    resetAllOutputsBtn.type = "button";
    resetAllOutputsBtn.className = "btn btn-default btn-xs";
    resetAllOutputsBtn.textContent = "Restore Default Output Items For All Modes";
    resetAllOutputsBtn.style.marginBottom = "8px";
    promptSection.appendChild(resetAllOutputsBtn);

    var BUILTIN_MODES = [
      { key: "both",      label: "Both" },
      { key: "response",  label: "Response" },
      { key: "diagnosis", label: "Diagnosis" }
    ];
    var storedModes  = (getStoredPromptConfig().modes) || {};
    var modeTextareas = {};

    function createOutputItemsEditor(initialItems, defaultItems) {
      var wrap = document.createElement("div");
      var listEl = document.createElement("div");
      listEl.className = "tm-output-list";
      var addBtn = document.createElement("button");
      addBtn.type = "button";
      addBtn.className = "btn btn-default btn-xs";
      addBtn.textContent = "+ Add Output Item";
      addBtn.style.marginTop = "6px";

      function updateAddState() {
        addBtn.disabled = listEl.querySelectorAll(".tm-output-row").length >= MAX_OUTPUT_FORMAT_ITEMS;
      }

      function addRow(item) {
        if (listEl.querySelectorAll(".tm-output-row").length >= MAX_OUTPUT_FORMAT_ITEMS) return;
        var row = document.createElement("div");
        row.className = "tm-output-row";

        var textInput = document.createElement("input");
        textInput.type = "text";
        textInput.value = String((item && item.text) || "");
        textInput.placeholder = "e.g. Quick understanding summary";

        var defaultWrap = document.createElement("label");
        defaultWrap.className = "tm-output-default";
        var defaultInput = document.createElement("input");
        defaultInput.type = "checkbox";
        defaultInput.checked = item ? item.defaultOn !== false : true;
        defaultWrap.appendChild(defaultInput);
        defaultWrap.appendChild(document.createTextNode("Default on"));

        var removeBtn = document.createElement("button");
        removeBtn.type = "button";
        removeBtn.className = "tm-output-remove";
        removeBtn.textContent = "Remove";
        removeBtn.addEventListener("click", function () {
          if (row.parentNode) row.parentNode.removeChild(row);
          updateAddState();
        });

        row.appendChild(textInput);
        row.appendChild(defaultWrap);
        row.appendChild(removeBtn);
        listEl.appendChild(row);
        updateAddState();
      }

      addBtn.addEventListener("click", function () {
        addRow({ text: "", defaultOn: true });
      });

      function setItems(items) {
        listEl.innerHTML = "";
        var safe = sanitizeOutputItems(items, "");
        for (var si = 0; si < safe.length; si++) addRow(safe[si]);
        updateAddState();
      }

      wrap.appendChild(listEl);
      wrap.appendChild(addBtn);
      setItems(sanitizeOutputItems(initialItems, ""));

      return {
        root: wrap,
        getItems: function () {
          var rows = listEl.querySelectorAll(".tm-output-row");
          var out = [];
          for (var ri = 0; ri < rows.length; ri++) {
            var txtEl = rows[ri].querySelector("input[type='text']");
            var chkEl = rows[ri].querySelector(".tm-output-default input[type='checkbox']");
            var txt = String((txtEl && txtEl.value) || "").trim();
            if (!txt) continue;
            out.push({ text: txt, defaultOn: !!(chkEl && chkEl.checked) });
            if (out.length >= MAX_OUTPUT_FORMAT_ITEMS) break;
          }
          return sanitizeOutputItems(out, "");
        },
        resetToDefault: function () {
          setItems(sanitizeOutputItems(defaultItems, ""));
        },
        setItems: function (items) {
          setItems(items);
        }
      };
    }

    for (var mti = 0; mti < BUILTIN_MODES.length; mti++) {
      (function (m, isFirst) {
        var tabBtn = document.createElement("button");
        tabBtn.type = "button";
        tabBtn.textContent = m.label;
        tabBtn.className = "tm-settings-tab" + (isFirst ? " tm-tab-active" : "");

        var pane = document.createElement("div");
        pane.className = "tm-settings-tab-pane" + (isFirst ? " tm-pane-active" : "");

        /* Rules */
        var rulesEl = document.createElement("textarea");
        rulesEl.rows = 5;
        rulesEl.className = "tm-settings-textarea";
        rulesEl.placeholder = DEFAULT_RULES;
        rulesEl.value = (storedModes[m.key] && storedModes[m.key].rules) || "";
        var rulesReset = document.createElement("span");
        rulesReset.className = "tm-settings-reset";
        rulesReset.textContent = "Reset to default";
        (function (el) {
          rulesReset.addEventListener("click", function () { el.value = ""; });
        })(rulesEl);
        var rulesField = makeField("Rules", rulesEl, "Override the default rules for this mode. Leave blank to use the defaults.");
        rulesField.appendChild(rulesReset);
        pane.appendChild(rulesField);

        /* Output Format */
        var outputEditor = createOutputItemsEditor(
          sanitizeOutputItems(
            storedModes[m.key] && storedModes[m.key].outputItems,
            storedModes[m.key] && storedModes[m.key].outputFormat
          ),
          getDefaultOutputItems()
        );
        var outputReset = document.createElement("span");
        outputReset.className = "tm-settings-reset";
        outputReset.textContent = "Reset to default";
        outputReset.addEventListener("click", function () { outputEditor.resetToDefault(); });
        var outputField = makeField("Output Format", outputEditor.root, "Use up to 10 output items. Each item can default on or off for new requests.");
        outputField.appendChild(outputReset);
        pane.appendChild(outputField);

        modeTextareas[m.key] = { rules: rulesEl, outputEditor: outputEditor };

        tabBtn.addEventListener("click", function () {
          var allTabs  = tabBar.querySelectorAll(".tm-settings-tab");
          var allPanes = tabPanesContainer.querySelectorAll(".tm-settings-tab-pane");
          for (var ti = 0; ti < allTabs.length; ti++)  allTabs[ti].className  = "tm-settings-tab";
          for (var pi = 0; pi < allPanes.length; pi++) allPanes[pi].className = "tm-settings-tab-pane";
          tabBtn.className = "tm-settings-tab tm-tab-active";
          pane.className   = "tm-settings-tab-pane tm-pane-active";
        });

        tabBar.appendChild(tabBtn);
        tabPanesContainer.appendChild(pane);
      })(BUILTIN_MODES[mti], mti === 0);
    }
    promptSection.appendChild(tabBar);
    promptSection.appendChild(tabPanesContainer);

    /* Custom Prompts */
    var customLabelEl = document.createElement("label");
    customLabelEl.textContent = "Custom Prompts";
    customLabelEl.style.display = "block";
    customLabelEl.style.marginTop = "14px";
    customLabelEl.style.marginBottom = "4px";
    var customHintEl = document.createElement("div");
    customHintEl.className = "tm-settings-hint";
    customHintEl.textContent = "Define additional prompt types that appear in the AI Assist menu alongside the built-in modes.";
    customHintEl.style.marginBottom = "6px";
    promptSection.appendChild(customLabelEl);
    promptSection.appendChild(customHintEl);

    var customListEl = document.createElement("div");
    customListEl.className = "tm-custom-prompt-list";

    var customEditArea = document.createElement("div");
    customEditArea.style.display      = "none";
    customEditArea.style.border       = "1px solid #c0c4cc";
    customEditArea.style.borderRadius = "4px";
    customEditArea.style.padding      = "12px";
    customEditArea.style.marginTop    = "8px";
    customEditArea.style.background   = "#f9fffe";

    var ceEditingKey = null;

    function renderCustomList() {
      customListEl.innerHTML = "";
      var cfg    = getStoredPromptConfig();
      var cpList = cfg.custom || [];
      if (!cpList.length) {
        var emptyEl = document.createElement("div");
        emptyEl.style.fontSize = "12px";
        emptyEl.style.color    = "#999";
        emptyEl.style.padding  = "4px 0";
        emptyEl.textContent = "No custom prompts yet.";
        customListEl.appendChild(emptyEl);
        return;
      }
      for (var cpi = 0; cpi < cpList.length; cpi++) {
        (function (p) {
          var row       = document.createElement("div");
          row.className = "tm-custom-prompt-row";
          var nameSpan  = document.createElement("span");
          nameSpan.textContent = truncatePromptLabel(p.label, 40);
          nameSpan.title = p.label;
          var acts = document.createElement("div");
          acts.className = "tm-cp-actions";
          var editBtn = document.createElement("button");
          editBtn.textContent = "Edit";
          editBtn.addEventListener("click", function () { showCustomEditForm(p.key); });
          var delBtn = document.createElement("button");
          delBtn.textContent = "Delete";
          delBtn.style.color = "#8b1e1e";
          delBtn.addEventListener("click", function () {
            var c = getStoredPromptConfig();
            c.custom = (c.custom || []).filter(function (x) { return x.key !== p.key; });
            setStoredPromptConfig(c);
            renderCustomList();
            document.dispatchEvent(new CustomEvent("tm-ai-assist-prompts-changed"));
          });
          acts.appendChild(editBtn);
          acts.appendChild(delBtn);
          row.appendChild(nameSpan);
          row.appendChild(acts);
          customListEl.appendChild(row);
        })(cpList[cpi]);
      }
    }

    /* Edit-form fields */
    var ceTitle = document.createElement("div");
    ceTitle.style.fontWeight   = "700";
    ceTitle.style.fontSize     = "12px";
    ceTitle.style.marginBottom = "10px";
    ceTitle.style.color        = "#333";

    var ceLabelInput = document.createElement("input");
    ceLabelInput.type        = "text";
    ceLabelInput.placeholder = "e.g. Manager Summary";
    ceLabelInput.style.cssText = "width:100%;padding:6px 8px;border:1px solid #c0c4cc;border-radius:4px;font-size:12px;box-sizing:border-box;";

    var ceTaskInput = document.createElement("textarea");
    ceTaskInput.rows      = 2;
    ceTaskInput.className = "tm-settings-textarea";
    ceTaskInput.placeholder = "e.g. Summarise this ticket concisely for a non-technical manager.";

    var ceRulesInput = document.createElement("textarea");
    ceRulesInput.rows      = 4;
    ceRulesInput.className = "tm-settings-textarea";
    ceRulesInput.placeholder = "(Leave blank to use default rules)";

    var ceOutputEditor = createOutputItemsEditor(getDefaultOutputItems(), getDefaultOutputItems());

    var ceSaveBtn   = document.createElement("button");
    ceSaveBtn.type  = "button";
    ceSaveBtn.className   = "btn btn-default btn-xs";
    ceSaveBtn.textContent = "Save Prompt";

    var ceCancelBtn   = document.createElement("button");
    ceCancelBtn.type  = "button";
    ceCancelBtn.className   = "btn btn-default btn-xs";
    ceCancelBtn.textContent = "Cancel";
    ceCancelBtn.addEventListener("click", function () {
      customEditArea.style.display = "none";
      ceEditingKey = null;
    });

    ceSaveBtn.addEventListener("click", function () {
      var lbl = String(ceLabelInput.value || "").trim();
      if (!lbl) { ceLabelInput.style.borderColor = "#c0392b"; ceLabelInput.focus(); return; }
      var c   = getStoredPromptConfig();
      c.custom = c.custom || [];
      var key   = ceEditingKey || ("cp_" + Date.now());
      var entry = {
        key:          key,
        label:        lbl,
        taskLine:     String(ceTaskInput.value   || "").trim(),
        rules:        String(ceRulesInput.value  || "").trim(),
        outputItems:  ceOutputEditor.getItems(),
        outputFormat: ""
      };
      var found = false;
      for (var ei = 0; ei < c.custom.length; ei++) {
        if (c.custom[ei].key === key) { c.custom[ei] = entry; found = true; break; }
      }
      if (!found) c.custom.push(entry);
      setStoredPromptConfig(c);
      ceEditingKey = null;
      customEditArea.style.display = "none";
      renderCustomList();
      document.dispatchEvent(new CustomEvent("tm-ai-assist-prompts-changed"));
    });

    function showCustomEditForm(key) {
      ceEditingKey = key || null;
      var c = getStoredPromptConfig();
      var p = null;
      if (key) {
        for (var si = 0; si < (c.custom || []).length; si++) {
          if (c.custom[si].key === key) { p = c.custom[si]; break; }
        }
      }
      ceTitle.textContent        = p ? "Edit Prompt: " + p.label : "New Custom Prompt";
      ceLabelInput.value         = p ? (p.label        || "") : "";
      ceTaskInput.value          = p ? (p.taskLine      || "") : "";
      ceRulesInput.value         = p ? (p.rules         || "") : "";
      ceOutputEditor.setItems(sanitizeOutputItems(p && p.outputItems, p && p.outputFormat));
      ceLabelInput.style.borderColor = "";
      customEditArea.style.display = "block";
      customEditArea.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }

    resetAllOutputsBtn.addEventListener("click", function () {
      var defaults = getDefaultOutputItems();

      var modeKeys = ["both", "response", "diagnosis"];
      for (var mi = 0; mi < modeKeys.length; mi++) {
        var mk = modeKeys[mi];
        if (modeTextareas[mk] && modeTextareas[mk].outputEditor) {
          modeTextareas[mk].outputEditor.setItems(defaults);
        }
      }

      var cfg = getStoredPromptConfig();
      cfg.custom = cfg.custom || [];
      for (var ci = 0; ci < cfg.custom.length; ci++) {
        cfg.custom[ci].outputItems = sanitizeOutputItems(defaults, "");
        cfg.custom[ci].outputFormat = "";
      }
      setStoredPromptConfig(cfg);

      if (ceEditingKey) {
        ceOutputEditor.setItems(defaults);
      }

      showToast("Default output items restored for all modes and custom prompts.", false);
    });

    customEditArea.appendChild(ceTitle);
    customEditArea.appendChild(makeField("Name",                       ceLabelInput,  "Label shown in the AI Assist menu."));
    customEditArea.appendChild(makeField("Task Instruction",           ceTaskInput,   "The goal/instruction that follows the persona in the prompt."));
    customEditArea.appendChild(makeField("Rules (optional)",           ceRulesInput,  "Leave blank to use the default rules."));
    customEditArea.appendChild(makeField("Output Format",              ceOutputEditor.root, "Use up to 10 output items. Each item can default on or off."));
    var ceBtnsDiv = document.createElement("div");
    ceBtnsDiv.style.cssText = "display:flex;gap:6px;margin-top:8px;";
    ceBtnsDiv.appendChild(ceSaveBtn);
    ceBtnsDiv.appendChild(ceCancelBtn);
    customEditArea.appendChild(ceBtnsDiv);

    var addCustomBtn = document.createElement("button");
    addCustomBtn.type      = "button";
    addCustomBtn.className = "btn btn-default btn-xs";
    addCustomBtn.textContent = "+ Add Custom Prompt";
    addCustomBtn.style.marginTop = "8px";
    addCustomBtn.addEventListener("click", function () { showCustomEditForm(null); });

    renderCustomList();
    promptSection.appendChild(customListEl);
    promptSection.appendChild(customEditArea);
    promptSection.appendChild(addCustomBtn);

    body.appendChild(promptSection);

    /* Footer */
    var footer = document.createElement("div");
    footer.id = "tm-settings-footer";

    var cancelBtn = document.createElement("button");
    cancelBtn.textContent = "Cancel";
    cancelBtn.addEventListener("click", function () { overlay.remove(); });

    var saveBtn = document.createElement("button");
    saveBtn.textContent = "Save Settings";
    saveBtn.className = "tm-settings-save";
    saveBtn.addEventListener("click", function () {
      /* Validate & save Copilot URL */
      var rawUrl = String(agentUrlInput.value || "").trim();
      if (rawUrl) {
        var validUrl = validateCopilotUrl(rawUrl);
        if (!validUrl) {
          agentUrlInput.style.borderColor = "#c0392b";
          agentUrlInput.focus();
          showToast("Invalid Copilot URL. Must be https://m365.cloud.microsoft/chat\u2026", true);
          return;
        }
        setStoredPreferredAgentUrl(validUrl);
      } else {
        setStoredPreferredAgentUrl("");
      }

      /* Validate & save Claude API key */
      var rawKey = String(apiKeyInput.value || "").trim();
      if (rawKey && !rawKey.startsWith("sk-")) {
        apiKeyInput.style.borderColor = "#c0392b";
        apiKeyInput.focus();
        showToast("API key must start with 'sk-'. Please check your Anthropic key.", true);
        return;
      }
      setStoredClaudeApiKey(rawKey);

      if (!copilotEnabledInput.checked && !claudeEnabledInput.checked) {
        showToast("At least one AI Assist component must be enabled.", true);
        return;
      }
      setStoredAiComponents({
        copilotEnabled: copilotEnabledInput.checked,
        claudeEnabled: claudeEnabledInput.checked
      });

      /* Save model */
      setStoredClaudeModel(modelSelect.value);

      /* Save max tokens */
      var tokens = parseInt(maxTokensInput.value, 10);
      if (isNaN(tokens) || tokens < 256) tokens = CLAUDE_DEFAULT_MAX_TOKENS;
      setStoredClaudeMaxTokens(tokens);

      /* Save persona */
      setStoredPersona(String(personaTextarea.value || "").trim());

      /* Save mode template overrides */
      var promptCfg = getStoredPromptConfig();
      promptCfg.modes = promptCfg.modes || {};
      var bmKeys = ["both", "response", "diagnosis"];
      for (var bmk = 0; bmk < bmKeys.length; bmk++) {
        var bk = bmKeys[bmk];
        if (modeTextareas[bk]) {
          promptCfg.modes[bk] = {
            rules:        String(modeTextareas[bk].rules.value        || "").trim(),
            outputItems:  modeTextareas[bk].outputEditor.getItems(),
            outputFormat: ""
          };
        }
      }
      setStoredPromptConfig(promptCfg);

      overlay.remove();
      showToast("Settings saved.", false);
    });

    footer.appendChild(cancelBtn);
    footer.appendChild(saveBtn);

    panel.appendChild(header);
    panel.appendChild(body);
    panel.appendChild(footer);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    overlay.addEventListener("click", function (e) { if (e.target === overlay) overlay.remove(); });

    function onEsc(e) {
      if (e.key === "Escape") { overlay.remove(); document.removeEventListener("keydown", onEsc); }
    }
    document.addEventListener("keydown", onEsc);
  }

  /* ═══════════════════ CLAUDE MAIN FLOW ═══════════════════ */

  var CLAUDE_MODE_LABELS = {
    both:      "Both (Response + Diagnosis)",
    response:  "Response Draft",
    diagnosis: "Diagnosis Help"
  };

  function showOutputSelectionModal(modeKey, providerLabel) {
    var cfg = getStoredPromptConfig();
    var template = getModeTemplateForRequest(cfg, modeKey);
    var items = sanitizeOutputItems(template.outputItems, "");

    return new Promise(function (resolve) {
      var existing = document.getElementById("tm-output-select-overlay");
      if (existing) existing.remove();

      var overlay = document.createElement("div");
      overlay.id = "tm-output-select-overlay";
      overlay.style.position = "fixed";
      overlay.style.inset = "0";
      overlay.style.zIndex = "350000";
      overlay.style.background = "rgba(0,0,0,0.5)";
      overlay.style.display = "flex";
      overlay.style.alignItems = "center";
      overlay.style.justifyContent = "center";

      var panel = document.createElement("div");
      panel.style.background = "#fff";
      panel.style.width = "min(520px, 95vw)";
      panel.style.borderRadius = "8px";
      panel.style.boxShadow = "0 8px 24px rgba(0,0,0,0.3)";
      panel.style.fontFamily = "Segoe UI, Arial, sans-serif";
      panel.style.fontSize = "13px";

      var header = document.createElement("div");
      header.style.padding = "10px 14px";
      header.style.background = "#1f4f1f";
      header.style.color = "#fff";
      header.style.fontWeight = "700";
      header.style.borderRadius = "8px 8px 0 0";
      header.textContent = providerLabel + " Output Selection";

      var body = document.createElement("div");
      body.style.padding = "12px 14px";

      var intro = document.createElement("div");
      intro.style.fontSize = "12px";
      intro.style.color = "#555";
      intro.style.marginBottom = "8px";
      intro.textContent = "Choose which output sections to include for this request.";
      body.appendChild(intro);

      var list = document.createElement("div");
      list.style.display = "flex";
      list.style.flexDirection = "column";
      list.style.gap = "6px";

      var checkboxes = [];
      for (var i = 0; i < items.length; i++) {
        var row = document.createElement("label");
        row.style.display = "flex";
        row.style.alignItems = "center";
        row.style.gap = "8px";
        row.style.padding = "6px 8px";
        row.style.border = "1px solid #e5e7eb";
        row.style.borderRadius = "4px";

        var cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = items[i].defaultOn !== false;
        checkboxes.push({ el: cb, text: items[i].text });

        var txt = document.createElement("span");
        txt.textContent = items[i].text;

        row.appendChild(cb);
        row.appendChild(txt);
        list.appendChild(row);
      }
      body.appendChild(list);

      var guidanceLabel = document.createElement("div");
      guidanceLabel.style.marginTop = "10px";
      guidanceLabel.style.marginBottom = "4px";
      guidanceLabel.style.fontSize = "12px";
      guidanceLabel.style.fontWeight = "600";
      guidanceLabel.textContent = "Additional guidance (optional)";
      body.appendChild(guidanceLabel);

      var guidanceInput = document.createElement("textarea");
      guidanceInput.rows = 3;
      guidanceInput.placeholder = "Add any one-off instructions for this specific request...";
      guidanceInput.style.width = "100%";
      guidanceInput.style.boxSizing = "border-box";
      guidanceInput.style.padding = "6px 8px";
      guidanceInput.style.border = "1px solid #c0c4cc";
      guidanceInput.style.borderRadius = "4px";
      guidanceInput.style.fontSize = "12px";
      guidanceInput.style.resize = "vertical";
      body.appendChild(guidanceInput);

      var footer = document.createElement("div");
      footer.style.display = "flex";
      footer.style.justifyContent = "flex-end";
      footer.style.gap = "8px";
      footer.style.padding = "10px 14px";
      footer.style.borderTop = "1px solid #e5e7eb";
      footer.style.background = "#f8fafc";
      footer.style.borderRadius = "0 0 8px 8px";

      var cancel = document.createElement("button");
      cancel.type = "button";
      cancel.textContent = "Cancel";
      cancel.className = "btn btn-default btn-xs";
      cancel.addEventListener("click", function () {
        overlay.remove();
        resolve(null);
      });

      var cont = document.createElement("button");
      cont.type = "button";
      cont.textContent = "Continue";
      cont.className = "btn btn-default btn-xs";
      cont.addEventListener("click", function () {
        var selected = [];
        for (var si = 0; si < checkboxes.length; si++) {
          if (checkboxes[si].el.checked) selected.push({ text: checkboxes[si].text, defaultOn: true });
        }
        if (!selected.length) {
          showToast("Select at least one output section.", true);
          return;
        }
        overlay.remove();
        resolve({
          selectedItems: selected,
          additionalGuidance: String(guidanceInput.value || "").trim()
        });
      });

      footer.appendChild(cancel);
      footer.appendChild(cont);

      panel.appendChild(header);
      panel.appendChild(body);
      panel.appendChild(footer);
      overlay.appendChild(panel);
      document.body.appendChild(overlay);

      overlay.addEventListener("click", function (e) {
        if (e.target === overlay) {
          overlay.remove();
          resolve(null);
        }
      });
    });
  }

  async function runClaudeAssist(mode) {
    var components = getStoredAiComponents();
    if (!components.claudeEnabled) {
      showToast("Claude Assist is disabled in settings.", true);
      return;
    }

    var outputSelection = await showOutputSelectionModal(mode, "Claude");
    if (!outputSelection) return;

    if (!getStoredClaudeApiKey()) {
      showToast("No Claude API key configured. Opening Settings\u2026", true);
      showSettingsModal();
      return;
    }

    var panelParts = showClaudePanel(CLAUDE_MODE_LABELS[mode] || mode);

    if (AUTO_EXPAND_SHOW_MORE_COMMENTS) {
      setClaudeLoading(panelParts.body, "Expanding comment history\u2026");
      var expandInfo = await expandAllShowMoreComments();
      if (expandInfo.expandedCount > 0) {
        showToast("Loaded " + expandInfo.expandedCount + " additional comment section(s).", false);
      }
    }

    setClaudeLoading(panelParts.body, "Building prompt and asking Claude\u2026");

    var details = collectTicketDetails();
    var prompt  = buildPrompt(
      mode,
      details,
      outputSelection.selectedItems,
      outputSelection.additionalGuidance
    );

    function doApiCall() {
      setClaudeLoading(panelParts.body, "Waiting for Claude response\u2026");
      callClaudeApi(prompt).then(function (responseText) {
        setClaudeResult(panelParts.body, panelParts.footer, responseText, prompt);
      }).catch(function (err) {
        setClaudeError(
          panelParts.body,
          panelParts.footer,
          err.message || "Unknown error",
          prompt,
          function () { doApiCall(); }
        );
      });
    }

    doApiCall();
  }

  function collectTicketDetails() {
    var communicationEntries = getCommunicationEntries();

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
      communicationHistory: formatCommunicationHistory(communicationEntries),
      url: window.location.href
    };
  }

  async function runAssistForMode(mode) {
    var components = getStoredAiComponents();
    if (!components.copilotEnabled) {
      showToast("Copilot Assist is disabled in settings.", true);
      return;
    }

    var outputSelection = await showOutputSelectionModal(mode, "Copilot");
    if (!outputSelection) return;

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
    var prompt = buildPrompt(
      mode,
      details,
      outputSelection.selectedItems,
      outputSelection.additionalGuidance
    );
    var copilotUrl = getStoredPreferredAgentUrl() || DEFAULT_COPILOT_CHAT_URL;

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
    if (document.getElementById("tm-ai-assist-wrap")) return;

    var targetBar = document.querySelector(".title-btns") || document.querySelector(".btn-bar");
    if (!targetBar) return;

    var wrap = document.createElement("div");
    wrap.id = "tm-ai-assist-wrap";
    wrap.style.position = "relative";
    wrap.style.display = "inline-block";
    wrap.style.marginRight = "8px";

    var btn = document.createElement("button");
    btn.id = "tm-ai-assist-btn";
    btn.type = "button";
    btn.className = "btn btn-default btn-xs";
    btn.textContent = "AI Assist \u25be";
    btn.title = "Open AI Assist menu for Copilot or Claude options.";

    var menu = document.createElement("div");
    menu.id = "tm-ai-assist-menu";
    menu.style.position = "absolute";
    menu.style.top = "100%";
    menu.style.left = "0";
    menu.style.minWidth = "260px";
    menu.style.marginTop = "4px";
    menu.style.padding = "6px";
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

    function makeSectionLabel(text) {
      var lbl = document.createElement("div");
      lbl.textContent = text;
      lbl.style.fontSize = "10px";
      lbl.style.fontWeight = "700";
      lbl.style.textTransform = "uppercase";
      lbl.style.letterSpacing = "0.06em";
      lbl.style.color = "#888";
      lbl.style.padding = "4px 6px 3px";
      return lbl;
    }

    function makeDivider() {
      var hr = document.createElement("hr");
      hr.style.margin = "5px 0";
      hr.style.border = "none";
      hr.style.borderTop = "1px solid #e8e8e8";
      return hr;
    }

    function makeMenuItem(labelText, onClick) {
      var item = document.createElement("button");
      item.type = "button";
      item.className = "btn btn-default btn-xs";
      item.textContent = labelText;
      item.style.display = "block";
      item.style.width = "100%";
      item.style.margin = "0 0 3px 0";
      item.style.textAlign = "left";
      item.style.whiteSpace = "normal";
      item.addEventListener("click", function (event) {
        event.preventDefault();
        event.stopPropagation();
        setMenuOpen(false);
        onClick();
      });
      return item;
    }

    function makeInfoRow(text) {
      var row = document.createElement("div");
      row.textContent = text;
      row.style.fontSize = "11px";
      row.style.color = "#777";
      row.style.padding = "6px";
      return row;
    }

    function rebuildMenu() {
      var modeOptions = getAssistModeOptions();
      var components = getStoredAiComponents();
      menu.innerHTML = "";

      if (!components.copilotEnabled && !components.claudeEnabled) {
        menu.appendChild(makeInfoRow("No providers enabled. Open Settings to enable Copilot or Claude."));
        menu.appendChild(makeDivider());
        menu.appendChild(makeMenuItem("\u2699\ufe0f Settings", function () {
          showSettingsModal();
        }));
        return;
      }

      /* ── Copilot section ── */
      if (components.copilotEnabled) {
        menu.appendChild(makeSectionLabel("Copilot"));
        for (var i = 0; i < modeOptions.length; i++) {
          (function (opt) {
            var item = makeMenuItem(opt.label, async function () {
              await runAssistForMode(opt.key);
            });
            if (opt.title) item.title = opt.title;
            menu.appendChild(item);
          })(modeOptions[i]);
        }
        menu.appendChild(makeDivider());
      }

      /* ── Claude section ── */
      if (components.claudeEnabled) {
        menu.appendChild(makeSectionLabel("Claude"));
        for (var ci = 0; ci < modeOptions.length; ci++) {
          (function (opt) {
            var item = makeMenuItem(opt.label, async function () {
              await runClaudeAssist(opt.key);
            });
            if (opt.title) item.title = opt.title;
            menu.appendChild(item);
          })(modeOptions[ci]);
        }
        menu.appendChild(makeDivider());
      }

      /* ── Settings ── */
      menu.appendChild(makeMenuItem("\u2699\ufe0f Settings", function () {
        showSettingsModal();
      }));
    }

    rebuildMenu();

    document.addEventListener("tm-ai-assist-prompts-changed", function () {
      if (document.getElementById("tm-ai-assist-wrap")) rebuildMenu();
    });

    btn.addEventListener("click", function (event) {
      event.preventDefault();
      event.stopPropagation();
      rebuildMenu();
      setMenuOpen(menu.style.display !== "block");
    });

    document.addEventListener("click", function (event) {
      if (!wrap.contains(event.target)) setMenuOpen(false);
    });

    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape") setMenuOpen(false);
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
