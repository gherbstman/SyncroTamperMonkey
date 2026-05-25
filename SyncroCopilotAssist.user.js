// ==UserScript==
// @name         Syncro - Copilot Assist
// @namespace    http://tampermonkey.net/
// @version      1.0.0
// @description  Copy key Syncro ticket details into a Copilot-ready prompt and open Copilot for fast response/diagnosis help.
// @author       Gary Herbstman
// @match        https://*.syncromsp.com/tickets/*
// @match        https://*.shield.syncromsp.com/tickets/*
// @grant        GM_setClipboard
// @grant        GM_openInTab
// @downloadURL  https://raw.githubusercontent.com/gherbstman/SyncroTamperMonkey/main/SyncroCopilotAssist.user.js
// @updateURL    https://raw.githubusercontent.com/gherbstman/SyncroTamperMonkey/main/SyncroCopilotAssist.user.js
// ==/UserScript==

(function () {
  "use strict";

  function safeText(el) {
    return el ? String(el.textContent || "").replace(/\s+/g, " ").trim() : "";
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

  function getLatestCommentSnippet() {
    var candidates = document.querySelectorAll(
      ".ticket-comment .note-editable, .ticket-comment .comment-body, .comment .note-editable, .comment .comment-body"
    );

    for (var i = candidates.length - 1; i >= 0; i--) {
      var text = safeText(candidates[i]);
      if (text && text.length > 20) {
        return text.slice(0, 1200);
      }
    }

    return "";
  }

  function detectRequestType() {
    var choice = window.prompt(
      "Copilot Assist mode:\nType 'r' for response draft, 'd' for diagnosis help, or leave blank for both.",
      "both"
    );

    if (!choice) return "both";
    var normalized = String(choice).trim().toLowerCase();

    if (normalized === "r" || normalized === "response") return "response";
    if (normalized === "d" || normalized === "diagnosis") return "diagnosis";
    return "both";
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
      "Latest comment/context:",
      details.latestComment || "No comment snippet found.",
      "",
      "Output format:",
      "1) Quick understanding summary",
      "2) Most likely root causes",
      "3) Immediate next actions",
      "4) Draft response text",
      "5) Follow-up questions"
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

  function openCopilot() {
    var url = "https://copilot.microsoft.com/";
    try {
      if (typeof GM_openInTab === "function") {
        GM_openInTab(url, { active: true, insert: true, setParent: true });
      } else {
        window.open(url, "_blank", "noopener,noreferrer");
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
      latestComment: getLatestCommentSnippet(),
      url: window.location.href
    };
  }

  function addAssistButton() {
    if (document.getElementById("tm-copilot-assist-btn")) return;

    var targetBar = document.querySelector(".title-btns") || document.querySelector(".btn-bar");
    if (!targetBar) return;

    var btn = document.createElement("button");
    btn.id = "tm-copilot-assist-btn";
    btn.type = "button";
    btn.className = "btn btn-default btn-xs";
    btn.textContent = "Copilot Assist";
    btn.title = "Copy ticket context and open Copilot for response/diagnosis help";
    btn.style.marginRight = "8px";

    btn.addEventListener("click", function () {
      var mode = detectRequestType();
      var details = collectTicketDetails();
      var prompt = buildPrompt(mode, details);

      var copied = copyText(prompt);
      var opened = openCopilot();

      if (copied && opened) {
        showToast("Ticket context copied. Copilot opened. Paste with Ctrl+V.", false);
        return;
      }

      if (copied && !opened) {
        showToast("Ticket context copied, but Copilot window could not be opened automatically.", true);
        return;
      }

      showToast("Could not copy ticket context automatically. Browser permission may be blocking clipboard access.", true);
    });

    if (targetBar.firstElementChild) {
      targetBar.insertBefore(btn, targetBar.firstElementChild);
    } else {
      targetBar.appendChild(btn);
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
