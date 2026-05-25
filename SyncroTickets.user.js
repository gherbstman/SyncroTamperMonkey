// ==UserScript==
// @name         Syncro – Ticket Helper
// @homepageURL  https://github.com/gherbstman/SyncroTamperMonkey
// @namespace    http://tampermonkey.net/
// @version      2.8.2
// @description  Add smart duration presets + ticket page efficiency tools (copy buttons, sticky header, priority/SLA hotkeys, WoC submit, canned response context menu)
// @author       Nick F + Gary Herbstman
// @match        https://*.syncromsp.com/tickets/*
// @match        https://*.shield.syncromsp.com/tickets/*
// @grant        none
// @downloadURL  https://raw.githubusercontent.com/gherbstman/SyncroTamperMonkey/main/SyncroTickets.user.js
// @updateURL    https://raw.githubusercontent.com/gherbstman/SyncroTamperMonkey/main/SyncroTickets.user.js
// ==/UserScript==

(function () {
  "use strict";

  var nativeSetter =
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  var widgetCacheByHeader = null;

  /* ═══════════════════ SHARED UTILITIES ═══════════════════ */
  function parse12h(str) {
    var m = str.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
    if (!m) return null;
    var h = +m[1], min = +m[2];
    var pm = m[3].toUpperCase() === "PM";
    if (pm && h !== 12) h += 12;
    if (!pm && h === 12) h = 0;
    return { h: h, m: min };
  }
  function pad2(n) { return n < 10 ? "0" + n : "" + n; }
  function fmt12h(h, m) {
    var per = h >= 12 ? "PM" : "AM";
    var dh = h % 12;
    if (dh === 0) dh = 12;
    return pad2(dh) + ":" + pad2(m) + " " + per;
  }
  function calcEndTime(fromStr, hours, minutes) {
    var from = parse12h(fromStr);
    if (!from) return null;
    var totalMin = from.h * 60 + from.m + hours * 60 + minutes;
    totalMin = totalMin % (24 * 60);
    var endH = Math.floor(totalMin / 60);
    var endM = totalMin % 60;
    return { h: endH, m: endM, display: fmt12h(endH, endM) };
  }
  function calcStartFromHM(endH, endM, hours, minutes) {
    var totalMin = endH * 60 + endM - (hours * 60 + minutes);
    totalMin = (totalMin % (24 * 60) + (24 * 60)) % (24 * 60);
    var startH = Math.floor(totalMin / 60);
    var startM = totalMin % 60;
    return { h: startH, m: startM, display: fmt12h(startH, startM) };
  }
  function nowHM() {
    var d = new Date();
    return { h: d.getHours(), m: d.getMinutes() };
  }
  function makeDurLabel(hours, minutes) {
    if (hours > 0) return hours + "h" + (minutes > 0 ? " " + minutes + "m" : "");
    return minutes + "m";
  }
  function formatDurationFromMinutes(totalMin) {
    totalMin = Math.max(0, Math.round(totalMin || 0));
    var h = Math.floor(totalMin / 60);
    var m = totalMin % 60;
    if (h === 0) return m + "m";
    if (m === 0) return h + "h";
    return h + ":" + pad2(m);
  }
  function parseDurationInput(raw) {
    if (!raw) return null;
    var s = String(raw).trim();
    if (!s) return null;
    s = s.replace(/\s+/g, " ").trim();

    if (s.indexOf(":") !== -1) {
      var parts = s.split(":");
      if (parts.length !== 2) return null;
      var hh = parseInt(parts[0], 10);
      var mm = parseInt(parts[1], 10);
      if (isNaN(hh) || isNaN(mm)) return null;
      if (mm < 0 || mm > 59 || hh < 0) return null;
      return { h: hh, m: mm };
    }

    if (/^\d+(\.\d+)?$/.test(s)) {
      var hrs = parseFloat(s);
      if (isNaN(hrs) || hrs <= 0) return null;
      var totalMin = Math.round(hrs * 60);
      return { h: Math.floor(totalMin / 60), m: totalMin % 60 };
    }

    var lower = s.toLowerCase();
    var hasH = /h/.test(lower);
    var hasM = /m/.test(lower);
    var hours = 0;
    var minutes = 0;

    if (hasH) {
      var hm = lower.match(/(\d+(?:\.\d+)?)\s*h/);
      if (!hm) return null;
      hours = parseFloat(hm[1]);
      if (isNaN(hours) || hours < 0) return null;
    }
    if (hasM) {
      var mmatch = lower.match(/(\d+)\s*m/);
      if (!mmatch) return null;
      minutes = parseInt(mmatch[1], 10);
      if (isNaN(minutes) || minutes < 0) return null;
    }
    if (!hasH && !hasM) return null;

    var total = Math.round(hours * 60) + minutes;
    if (total < 0) return null;
    return { h: Math.floor(total / 60), m: total % 60 };
  }

  function safeText(el) {
    return el ? String(el.textContent || "").replace(/\s+/g, " ").trim() : "";
  }

  async function copyToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      try {
        var ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.left = "-9999px";
        ta.style.top = "-9999px";
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        document.execCommand("copy");
        ta.remove();
        return true;
      } catch (e2) {
        return false;
      }
    }
  }

  function flashButton(btn, ok) {
    if (!btn) return;
    var old = btn.style.backgroundColor;
    btn.style.backgroundColor = ok ? "#d6f5d6" : "#ffd6d6";
    setTimeout(function () { btn.style.backgroundColor = old; }, 350);
  }

  // Appendable CSS injector (supports multiple modules)
  function injectStyle(css, styleId) {
    styleId = styleId || "tm-extra-style";
    var s = document.getElementById(styleId);
    if (!s) {
      s = document.createElement("style");
      s.id = styleId;
      s.type = "text/css";
      document.head.appendChild(s);
    }
    if (!s.textContent.includes(css)) s.textContent += "\n" + css + "\n";
  }

  function decodeHtmlEntities(s) {
    if (!s) return "";
    var ta = document.createElement("textarea");
    ta.innerHTML = s;
    return ta.value;
  }

  /* ═══════════════════ BAR BUILDER ═══════════════════ */
  function createBar(id) {
    var pageStyles = window.getComputedStyle(document.body);
    var fg = pageStyles.color || "#ddd";

    function rgba(color, alpha) {
      if (!color || !color.startsWith("rgb")) return color || "rgba(0,0,0," + alpha + ")";
      var vals = color.match(/\d+/g);
      if (!vals || vals.length < 3) return color;
      return "rgba(" + vals[0] + "," + vals[1] + "," + vals[2] + "," + alpha + ")";
    }

    var isDark =
      pageStyles.backgroundColor &&
      pageStyles.backgroundColor.match(/\d+/g) &&
      pageStyles.backgroundColor
        .match(/\d+/g)
        .slice(0, 3)
        .map(Number)
        .reduce(function (a, b) { return a + b; }, 0) / 3 < 128;

    var subtleBg = isDark ? rgba(fg, 0.06) : "#f7f8fb";
    var subtleBorder = isDark ? rgba(fg, 0.18) : "#d9dce3";
    var buttonBg = isDark ? rgba(fg, 0.10) : "#ffffff";
    var buttonHover = isDark ? rgba(fg, 0.18) : "#eef2f7";

    function makeEl(tag, attrs, text) {
      var el = document.createElement(tag);
      if (attrs) {
        for (var key in attrs) {
          if (key === "style" && typeof attrs[key] === "object") Object.assign(el.style, attrs[key]);
          else if (key === "className") el.className = attrs[key];
          else el.setAttribute(key, attrs[key]);
        }
      }
      if (text) el.textContent = text;
      return el;
    }

    function themedButton(text, className, extraAttrs) {
      var btn = makeEl(
        "button",
        Object.assign(
          {
            className: className,
            type: "button",
            style: {
              padding: "3px 10px",
              background: buttonBg,
              color: fg,
              border: "1px solid " + subtleBorder,
              borderRadius: "4px",
              cursor: "pointer",
              fontSize: "12px",
              fontWeight: "500",
              transition: "all 0.15s ease",
              whiteSpace: "nowrap",
            },
          },
          extraAttrs || {}
        ),
        text
      );
      btn.addEventListener("mouseenter", function () { btn.style.background = buttonHover; });
      btn.addEventListener("mouseleave", function () { btn.style.background = buttonBg; });
      return btn;
    }

    var bar = document.createElement("div");
    bar.id = id;
    Object.assign(bar.style, {
      display: "flex",
      flexDirection: "column",
      gap: "6px",
      marginTop: "6px",
      padding: "5px 8px",
      width: "100%",
      maxWidth: "100%",
      boxSizing: "border-box",
      overflowX: "hidden",
      overflowY: "visible",
      background: subtleBg,
      color: fg,
      border: "1px solid " + subtleBorder,
      borderRadius: "8px",
      fontFamily: "Roboto, Helvetica, Arial, sans-serif",
      backdropFilter: "blur(4px)",
    });

    var rowTop = makeEl("div", {
      className: "tm-row-top",
      style: { display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" },
    });
    var rowBottom = makeEl("div", {
      className: "tm-row-bottom",
      style: { display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" },
    });
    bar.appendChild(rowTop);
    bar.appendChild(rowBottom);

    var label = makeEl(
      "span",
      { style: { fontSize: "13px", fontWeight: "600", color: fg, marginRight: "2px", whiteSpace: "nowrap" } },
      "⏱ Duration:"
    );
    rowTop.appendChild(label);

    var durInput = makeEl("input", {
      className: "tm-dur",
      type: "text",
      value: "15m",
      placeholder: "e.g. 25m, 2h, 1.5, 1:25",
      style: {
        width: "170px",
        maxWidth: "100%",
        padding: "4px 8px",
        background: isDark ? rgba(fg, 0.04) : "#ffffff",
        color: fg,
        border: "1px solid " + subtleBorder,
        borderRadius: "4px",
        fontSize: "13px",
        boxSizing: "border-box",
      },
    });
    rowTop.appendChild(durInput);

    var applyBtn = themedButton("Apply", "tm-apply", {
      style: {
        background: isDark ? "rgba(25,118,210,0.18)" : "#eaf2ff",
        color: isDark ? fg : "#174ea6",
        border: isDark ? "1px solid rgba(25,118,210,0.45)" : "1px solid #9bbcf2",
        display: "none",
      },
    });
    rowTop.appendChild(applyBtn);

    var nowEl = makeEl(
      "span",
      {
        className: "tm-now",
        style: {
          fontSize: "11px",
          color: rgba(fg, 0.65),
          whiteSpace: "nowrap",
          display: "none",
          paddingLeft: "4px",
        },
      },
      "Ends at now"
    );
    rowTop.appendChild(nowEl);

    var presets = [
      { h: 0, m: 5, text: "5m" },
      { h: 0, m: 10, text: "10m" },
      { h: 0, m: 15, text: "15m" },
      { h: 0, m: 30, text: "30m" },
      { h: 0, m: 45, text: "45m" },
      { h: 1, m: 0, text: "1h" },
      { h: 1, m: 30, text: "1.5h" },
      { h: 2, m: 0, text: "2h" },
    ];

    var presetsWrap = makeEl("div", {
      className: "tm-presets-wrap",
      style: { display: "flex", flexWrap: "wrap", gap: "6px", alignItems: "center", maxWidth: "100%", boxSizing: "border-box" },
    });
    rowBottom.appendChild(presetsWrap);

    for (var i = 0; i < presets.length; i++) {
      presetsWrap.appendChild(
        themedButton(presets[i].text, "tm-preset", { "data-h": String(presets[i].h), "data-m": String(presets[i].m) })
      );
    }

    bar.appendChild(makeEl("span", { className: "tm-status", style: { display: "none" } }));
    return bar;
  }

  function wireBar(bar, applyFn) {
    var durInput = bar.querySelector(".tm-dur");
    var applyBtn = bar.querySelector(".tm-apply");
    var nowEl = bar.querySelector(".tm-now");

    function setNowIndicator(on) { if (nowEl) nowEl.style.display = on ? "inline" : "none"; }
    function showApply(on) { if (applyBtn) applyBtn.style.display = on ? "inline-block" : "none"; }

    (function bindDurWheel() {
      if (!durInput || durInput.__tmDurWheelBound) return;
      durInput.__tmDurWheelBound = true;
      durInput.addEventListener("wheel", function (e) {
        if (!e || e.deltaY === 0) return;
        e.preventDefault(); e.stopPropagation();
        var dir = e.deltaY < 0 ? 1 : -1;
        var parsed = parseDurationInput(durInput.value);
        var curMin = parsed ? parsed.h * 60 + parsed.m : 0;
        var nextMin = Math.max(0, curMin + dir * 5);
        durInput.value = formatDurationFromMinutes(nextMin);
        setNowIndicator(false);
        showApply(true);
      }, { passive: false });
    })();

    function applyFromInput() {
      var parsed = parseDurationInput(durInput.value);
      if (!parsed || (parsed.h === 0 && parsed.m === 0)) { setNowIndicator(false); return; }
      applyFn(parsed.h, parsed.m, function () {}, setNowIndicator);
    }

    applyBtn.addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); applyFromInput(); });

    var presetBtns = bar.querySelectorAll(".tm-preset");
    for (var i = 0; i < presetBtns.length; i++) {
      (function (btn) {
        btn.addEventListener("click", function (e) {
          e.preventDefault(); e.stopPropagation();
          var h = parseInt(btn.getAttribute("data-h"), 10) || 0;
          var m = parseInt(btn.getAttribute("data-m"), 10) || 0;
          durInput.value = btn.textContent || makeDurLabel(h, m);
          showApply(false);
          applyFn(h, m, function () {}, setNowIndicator);
        });
      })(presetBtns[i]);
    }

    durInput.addEventListener("focus", function () { showApply(true); });
    durInput.addEventListener("input", function () { showApply(true); });
    durInput.addEventListener("blur", function () {
      setTimeout(function () { if (document.activeElement !== applyBtn) showApply(false); }, 150);
    });

    durInput.addEventListener("keydown", function (e) {
      var key = e.key;
      if (key === "Enter") { e.preventDefault(); e.stopPropagation(); applyFromInput(); return; }
      if (key === "Escape") { e.preventDefault(); e.stopPropagation(); durInput.value = ""; setNowIndicator(false); showApply(false); return; }

      var delta = 0;
      if (!e.shiftKey && !e.ctrlKey && !e.altKey) {
        if (key === "ArrowUp") delta = +15;
        else if (key === "ArrowDown") delta = -15;
      }
      if (e.shiftKey && !e.ctrlKey && !e.altKey) {
        if (key === "ArrowUp") delta = +30;
        else if (key === "ArrowDown") delta = -30;
      }
      if (delta !== 0) {
        e.preventDefault(); e.stopPropagation();
        var parsed = parseDurationInput(durInput.value);
        var curMin = parsed ? parsed.h * 60 + parsed.m : 0;
        var nextMin = Math.max(0, curMin + delta);
        durInput.value = formatDurationFromMinutes(nextMin);
        setNowIndicator(false);
        showApply(true);
      }
    });
  }

  function wireTimeFieldArrows(inputEl, setFn) {
    if (!inputEl || inputEl.__tmTimeArrowsBound) return;
    inputEl.__tmTimeArrowsBound = true;

    function toTotalMinutes(t) { return t.h * 60 + t.m; }
    function fromTotalMinutes(total) {
      total = (total % (24 * 60) + 24 * 60) % (24 * 60);
      return { h: Math.floor(total / 60), m: total % 60 };
    }

    inputEl.addEventListener("keydown", function (e) {
      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
      var dir = e.key === "ArrowUp" ? 1 : -1;
      var deltaMin = 0;
      if (e.ctrlKey || e.altKey) deltaMin = 60 * dir;
      else if (e.shiftKey) deltaMin = 5 * dir;
      else deltaMin = 1 * dir;

      e.preventDefault(); e.stopPropagation();

      var cur = (inputEl.value || "").trim();
      var parsed = cur ? parse12h(cur) : null;
      if (!parsed) {
        var now = nowHM();
        parsed = { h: now.h, m: now.m };
      }
      var next = fromTotalMinutes(toTotalMinutes(parsed) + deltaMin);
      setFn(fmt12h(next.h, next.m));
    });
  }

  function wireTimeFieldWheel(inputEl, setFn, stepMin) {
    if (!inputEl || inputEl.__tmTimeWheelBound) return;
    inputEl.__tmTimeWheelBound = true;
    stepMin = stepMin || 5;

    function toTotalMinutes(t) { return t.h * 60 + t.m; }
    function fromTotalMinutes(total) {
      total = (total % (24 * 60) + 24 * 60) % (24 * 60);
      return { h: Math.floor(total / 60), m: total % 60 };
    }

    inputEl.addEventListener("wheel", function (e) {
      if (!e || e.deltaY === 0) return;
      e.preventDefault(); e.stopPropagation();
      var dir = e.deltaY < 0 ? 1 : -1;

      var cur = (inputEl.value || "").trim();
      var parsed = cur ? parse12h(cur) : null;
      if (!parsed) {
        var now = nowHM();
        parsed = { h: now.h, m: now.m };
      }
      var next = fromTotalMinutes(toTotalMinutes(parsed) + dir * stepMin);
      setFn(fmt12h(next.h, next.m));
    }, { passive: false });
  }

  function wireSelectWheel(selectEl) {
    if (!selectEl || selectEl.__tmSelectWheelBound) return;
    selectEl.__tmSelectWheelBound = true;

    selectEl.addEventListener("wheel", function (e) {
      if (!e || e.deltaY === 0) return;
      e.preventDefault(); e.stopPropagation();
      var dir = e.deltaY < 0 ? -1 : 1;
      var idx = selectEl.selectedIndex;
      var next = Math.max(0, Math.min(selectEl.options.length - 1, idx + dir));
      if (next === idx) return;
      selectEl.selectedIndex = next;
      selectEl.dispatchEvent(new Event("change", { bubbles: true }));
    }, { passive: false });
  }

  function parseMMDDYY(str) {
    var m = String(str || "").trim().match(/^(\d{1,2})-(\d{1,2})-(\d{2,4})$/);
    if (!m) return null;
    var mm = +m[1], dd = +m[2], yy = +m[3];
    if (yy < 100) yy = yy < 70 ? 2000 + yy : 1900 + yy;
    var d = new Date(yy, mm - 1, dd);
    if (isNaN(d.getTime())) return null;
    return d;
  }
  function formatMMDDYY(d) { return pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) + "-" + pad2(d.getFullYear() % 100); }

  function wireDateFieldWheel(inputEl) {
    if (!inputEl || inputEl.__tmDateWheelBound) return;
    inputEl.__tmDateWheelBound = true;

    inputEl.addEventListener("wheel", function (e) {
      if (!e || e.deltaY === 0) return;
      e.preventDefault(); e.stopPropagation();
      var dir = e.deltaY < 0 ? 1 : -1;
      var d = parseMMDDYY(inputEl.value) || new Date();
      d.setDate(d.getDate() + dir);

      var $ = window.jQuery;
      try {
        if ($ && typeof $(inputEl).datepicker === "function") {
          $(inputEl).datepicker("setDate", d);
          $(inputEl).trigger("change");
          return;
        }
      } catch (err) {}

      inputEl.value = formatMMDDYY(d);
      inputEl.dispatchEvent(new Event("change", { bubbles: true }));
    }, { passive: false });
  }

  /* ═══════════════════ 1. LABOR LOG MODAL (React/MUI) ═══════════════════ */
  function setReactValue(el, value) {
    nativeSetter.call(el, value);

    var keys = Object.keys(el);
    var propsKey = null;
    var fiberKey = null;

    for (var i = 0; i < keys.length; i++) {
      if (keys[i].indexOf("__reactProps$") === 0) propsKey = keys[i];
      if (keys[i].indexOf("__reactFiber$") === 0 || keys[i].indexOf("__reactInternalInstance$") === 0) fiberKey = keys[i];
    }

    var syntheticEvent = {
      target: el,
      currentTarget: el,
      type: "change",
      nativeEvent: new Event("change", { bubbles: true }),
      preventDefault: function () {},
      stopPropagation: function () {},
      persist: function () {},
      bubbles: true,
      cancelable: true,
      defaultPrevented: false,
      eventPhase: 0,
      isTrusted: false,
      timeStamp: Date.now(),
    };

    if (propsKey && el[propsKey] && typeof el[propsKey].onChange === "function") {
      el[propsKey].onChange(syntheticEvent);
      return true;
    }

    if (fiberKey) {
      var node = el[fiberKey];
      for (var depth = 0; depth < 25 && node; depth++) {
        var props = node.memoizedProps || node.pendingProps;
        if (props && typeof props.onChange === "function") {
          nativeSetter.call(el, value);
          props.onChange(syntheticEvent);
          return true;
        }
        node = node.return;
      }
    }
    return false;
  }

  function injectLaborLog() {
    if (document.getElementById("tm-laborlog-helper")) return;

    var allP = document.querySelectorAll("p.MuiTypography-root");
    var heading = null;
    for (var i = 0; i < allP.length; i++) {
      if (allP[i].textContent.trim() === "Labor Log") { heading = allP[i]; break; }
    }
    if (!heading) return;

    var allLabels = document.querySelectorAll("label.MuiFormLabel-root");
    var durationLabel = null;
    for (var j = 0; j < allLabels.length; j++) {
      if (allLabels[j].textContent.trim() === "Duration") { durationLabel = allLabels[j]; break; }
    }
    if (!durationLabel) return;

    var wrapper = durationLabel.closest(".MuiFormControl-root");
    if (!wrapper) return;

    var fromInput = wrapper.querySelector('input[placeholder="From"]');
    var toInput = wrapper.querySelector('input[placeholder="To"]');
    if (!fromInput || !toInput) return;

    var bar = createBar("tm-laborlog-helper");
    wrapper.appendChild(bar);

    wireBar(bar, function (hours, minutes, showStatus, setNowIndicator) {
      if (hours === 0 && minutes === 0) { setNowIndicator(false); return; }

      var fromVal = fromInput.value ? fromInput.value.trim() : "";
      if (!fromVal) {
        var now = nowHM();
        var endDisplay = fmt12h(now.h, now.m);
        var start = calcStartFromHM(now.h, now.m, hours, minutes);
        var ok1 = setReactValue(fromInput, start.display);
        var ok2 = setReactValue(toInput, endDisplay);
        setNowIndicator(true);
        if (!ok1 || !ok2) setNowIndicator(false);
        return;
      }
      setNowIndicator(false);
      var result = calcEndTime(fromVal, hours, minutes);
      if (!result) return;
      setReactValue(toInput, result.display);
    });
  }

  function cleanupLaborLog() {
    var el = document.getElementById("tm-laborlog-helper");
    if (!el) return;

    var allP = document.querySelectorAll("p.MuiTypography-root");
    var found = false;
    for (var i = 0; i < allP.length; i++) {
      if (allP[i].textContent.trim() === "Labor Log") { found = true; break; }
    }
    if (!found) el.remove();
  }

  /* ═══════════════════ 2. COMMENT FORM (jQuery/Bootstrap) ═══════════════════ */
  function setTimepickerValue(inputEl, timeStr) {
    var $ = window.jQuery;
    if ($) {
      var $input = $(inputEl);
      try {
        var tpData = $input.data("timepicker");
        if (tpData && typeof tpData.setTime === "function") {
          tpData.setTime(timeStr);
          $input.trigger("change");
          return true;
        }
      } catch (e) {}
      $input.val(timeStr).trigger("change");
      return true;
    }
    inputEl.value = timeStr;
    inputEl.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  function injectCommentForm() {
    if (document.getElementById("tm-comment-helper")) return;

    var startInput = document.getElementById("comment_start_at");
    var endInput = document.getElementById("comment_end_at");
    if (!startInput || !endInput) return;

    wireTimeFieldArrows(startInput, function (v) { setTimepickerValue(startInput, v); });
    wireTimeFieldArrows(endInput, function (v) { setTimepickerValue(endInput, v); });

    wireTimeFieldWheel(startInput, function (v) { setTimepickerValue(startInput, v); }, 5);
    wireTimeFieldWheel(endInput, function (v) { setTimepickerValue(endInput, v); }, 5);

    wireSelectWheel(document.getElementById("comment_product_id"));
    wireDateFieldWheel(document.getElementById("comment_date_label"));

    var durationRow = endInput.closest(".row");
    if (!durationRow) return;

    var bar = createBar("tm-comment-helper");
    var wrapperRow = document.createElement("div");
    wrapperRow.className = "row";
    wrapperRow.style.marginTop = "8px";

    var spacerCol = document.createElement("div");
    spacerCol.className = "col-sm-2";

    var contentCol = document.createElement("div");
    contentCol.className = "col-sm-10";
    contentCol.style.width = "100%";
    contentCol.appendChild(bar);

    wrapperRow.appendChild(spacerCol);
    wrapperRow.appendChild(contentCol);

    if (durationRow.nextSibling) durationRow.parentNode.insertBefore(wrapperRow, durationRow.nextSibling);
    else durationRow.parentNode.appendChild(wrapperRow);

    wireBar(bar, function (hours, minutes, showStatus, setNowIndicator) {
      if (hours === 0 && minutes === 0) { setNowIndicator(false); return; }

      var fromVal = startInput.value ? startInput.value.trim() : "";
      if (!fromVal) {
        var now = nowHM();
        var endDisplay = fmt12h(now.h, now.m);
        var start = calcStartFromHM(now.h, now.m, hours, minutes);
        setTimepickerValue(startInput, start.display);
        setTimepickerValue(endInput, endDisplay);
        setNowIndicator(true);
        return;
      }

      setNowIndicator(false);
      var result = calcEndTime(fromVal, hours, minutes);
      if (!result) return;
      setTimepickerValue(endInput, result.display);
    });
  }

  /* ═══════════════════ 3. TICKET PAGE BOOSTERS ═══════════════════ */
  function getTicketIdFromPath() {
    var m = window.location.pathname.match(/\/tickets\/(\d+)/);
    return m ? m[1] : null;
  }
  function getCsrfToken() {
    var meta = document.querySelector('meta[name="csrf-token"]');
    if (meta && meta.getAttribute("content")) return meta.getAttribute("content");
    var hidden = document.querySelector('input[name="authenticity_token"]');
    return hidden ? String(hidden.value || "") : "";
  }

  function getWidgetByHeaderText(hText) {
    if (widgetCacheByHeader && Object.prototype.hasOwnProperty.call(widgetCacheByHeader, hText)) {
      return widgetCacheByHeader[hText];
    }

    var hs = document.querySelectorAll(".widget-header h3");
    for (var i = 0; i < hs.length; i++) {
      if (safeText(hs[i]) === hText) {
        var widget = hs[i].closest(".widget");
        if (widgetCacheByHeader) widgetCacheByHeader[hText] = widget || null;
        return widget;
      }
    }

    if (widgetCacheByHeader) widgetCacheByHeader[hText] = null;
    return null;
  }

  function getCreatedFull() {
    var ticketInfo = getWidgetByHeaderText("Ticket Info");
    if (!ticketInfo) return "";
    var ths = ticketInfo.querySelectorAll("th");
    for (var i = 0; i < ths.length; i++) {
      if (safeText(ths[i]) === "Created") {
        var td = ths[i].nextElementSibling;
        if (!td) return "";
        var span = td.querySelector("span[title], span[data-original-title], span.tooltipper[title]");
        var t = span ? (span.getAttribute("data-original-title") || span.getAttribute("title")) : "";
        return t || safeText(td);
      }
    }
    return "";
  }

  function getDueFull() {
    var a = document.querySelector("a.bhv-DueDateEdit");
    if (!a) return "";
    var t = a.getAttribute("data-title") || "";
    var txt = safeText(a);
    if (t && txt) return txt + " (" + t + ")";
    return txt || t;
  }

  function getTicketNumber() {
    var h1 = document.querySelector(".row h1") || document.querySelector("h1");
    var t = safeText(h1);
    var m = t.match(/#(\d+)/);
    if (m) return m[1];

    var fromPath = getTicketIdFromPath();
    if (fromPath) return fromPath;

    return t.replace("#", "").trim();
  }
  function getTicketSubject() {
    var input = document.getElementById("ticket-subject");
    if (input && String(input.value || "").trim()) return String(input.value || "").trim();

    var h3 = document.querySelector("h3.ticket-subject-title");
    return safeText(h3);
  }
  function getTicketStatus() {
    var sel = document.getElementById("ticket_status");
    if (sel) {
      var opt = sel.options[sel.selectedIndex];
      if (opt) return safeText(opt);
    }
    return getTicketInfoField("Status");
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

  function getTicketInfoField(label) {
    var ticketInfo = getWidgetByHeaderText("Ticket Info");
    if (!ticketInfo) return "";
    var ths = ticketInfo.querySelectorAll("th");
    for (var i = 0; i < ths.length; i++) {
      if (safeText(ths[i]) === label) {
        var td = ths[i].nextElementSibling;
        return td ? safeText(td) : "";
      }
    }
    return "";
  }

  function findAiSummaryText() {
    var candidates = document.querySelectorAll(
      '[data-sidepack-react-class*="ai-summary"], [data-testid*="ai-summary"], .ai-summary, .ticket-ai-summary, [id*="ai-summary"]'
    );
    for (var i = 0; i < candidates.length; i++) {
      var txt = safeText(candidates[i]);
      if (txt && txt.length > 20) return txt;
    }

    var widgets = document.querySelectorAll(".widget-header h3");
    for (var j = 0; j < widgets.length; j++) {
      if (safeText(widgets[j]) === "Summary") {
        var w = widgets[j].closest(".widget");
        if (w) {
          var body = w.querySelector(".widget-content") || w;
          var t = safeText(body);
          if (t && t.length > 20) return t;
        }
      }
    }
    return "";
  }

  function getCustomerInfoField(label) {
    var w = getWidgetByHeaderText("Customer Info");
    if (!w) return "";
    var ths = w.querySelectorAll("th, .small-table-header, strong");
    for (var i = 0; i < ths.length; i++) {
      if (safeText(ths[i]) === label) {
        var th = ths[i].closest("th") || ths[i];
        var immediateTd = th.nextElementSibling;
        if (immediateTd) {
          var direct = safeText(immediateTd);
          if (direct) return direct;
        }

        var row = ths[i].closest("tr") || ths[i].closest(".row") || ths[i].parentElement;
        if (row) {
          var t = safeText(row);
          t = t.replace(new RegExp("^" + label + "\\s*:?\\s*", "i"), "");
          if (t && t !== label) return t;
          var td = ths[i].closest("th") ? ths[i].nextElementSibling : null;
          if (td) return safeText(td);
        }
      }
    }
    return "";
  }

  function getCustomerName() {
    var w = getWidgetByHeaderText("Customer Info");
    if (!w) return "";
    var a = w.querySelector('a[href^="/customers/"]');
    return safeText(a) || "";
  }

  function getPrimaryContactName() {
    var w = getWidgetByHeaderText("Customer Info");
    if (!w) return "";
    var labelVal = getCustomerInfoField("Assigned Contact");
    if (labelVal) return labelVal;
    var a = w.querySelector('a[href*="/contacts/"], a[href^="/contacts/"]');
    return safeText(a) || "";
  }

  function getPrimaryContactEmail() {
    var w = getWidgetByHeaderText("Customer Info");
    if (!w) return "";
    var a = w.querySelector('a[href^="mailto:"]');
    if (a) return (a.getAttribute("href") || "").replace(/^mailto:/i, "").trim() || safeText(a);
    var t = safeText(w);
    var m = t.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    return m ? m[0] : "";
  }

  function getPhone() {
    var w = getWidgetByHeaderText("Customer Info");
    if (!w) return "";
    var tel = w.querySelector('a[href^="tel:"]');
    if (tel) return (tel.getAttribute("href") || "").replace(/^tel:/i, "").trim() || safeText(tel);
    var t = safeText(w);
    var m = t.match(/(\+?1[\s-]?)?\(?\d{3}\)?[\s-]\d{3}[\s-]\d{4}/);
    return m ? m[0] : "";
  }

  function getContactMobile() {
    var v = getCustomerInfoField("Contact Mobile");
    if (v) return v;

    var w = getWidgetByHeaderText("Customer Info");
    if (!w) return "";
    var rowText = "";
    var ths = w.querySelectorAll("th");
    for (var i = 0; i < ths.length; i++) {
      if (safeText(ths[i]).toLowerCase().indexOf("contact mobile") !== -1) {
        var td = ths[i].nextElementSibling;
        rowText = safeText(td);
        break;
      }
    }
    return rowText;
  }

  function getPrimaryAddress() {
    return getCustomerInfoField("Primary Address");
  }

  function getTicketAddress() {
    return getCustomerInfoField("Ticket Address");
  }

  function buildTicketSummaryText() {
    var tn = getTicketNumber();
    var subj = getTicketSubject();
    var status = getTicketStatus();
    var created = getCreatedFull();
    var due = getDueFull();
    var assignee = getAssignee();
    var ai = findAiSummaryText();
    var link = window.location.href;

    return [
      "Ticket #: " + tn,
      "Subject: " + subj,
      "Status: " + status,
      "Created: " + created,
      "Due: " + due,
      "Assignee: " + assignee,
      "AI Summary: " + (ai || ""),
      "Ticket Link: " + link
    ].join("\n");
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

  function applyNativeTooltipBehavior(element, hideOnClick) {
    if (!element) return;

    var nativeTitle = element.getAttribute("title") || element.getAttribute("data-original-title") || "";

    // Force native browser tooltip behavior for consistency.
    if (nativeTitle) element.setAttribute("title", nativeTitle);

    if (!hideOnClick || element.__tmTooltipClickBlurBound) return;
    element.__tmTooltipClickBlurBound = true;

    element.addEventListener("click", function () {
      if (typeof element.blur === "function") element.blur();
    });
  }

  function cleanupLegacyStickyTopBar() {
    var oldBar = document.getElementById("tm-sticky-topbar");
    if (oldBar) oldBar.remove();
    document.body.classList.remove("tm-has-sticky");
    document.documentElement.style.removeProperty("--tmStickyPad");
  }

  function getStickyHeaderRows() {
    var backRow = document.querySelector(".back-button-container");
    if (!backRow) return null;

    var titleRow = backRow.nextElementSibling;
    if (!titleRow || !titleRow.classList || !titleRow.classList.contains("row")) {
      titleRow = backRow.parentElement ? backRow.parentElement.querySelector(".row h1") : null;
      titleRow = titleRow ? titleRow.closest(".row") : null;
    }

    var subjectRow = document.querySelector(".row.mts.mbm");
    return {
      backRow: backRow,
      titleRow: titleRow,
      subjectRow: subjectRow,
      container: backRow.closest(".col-md-12") || backRow.parentElement,
    };
  }

  function ensureStickyTicketHeaderRows() {
    var parts = getStickyHeaderRows();
    if (!parts || !parts.backRow || !parts.titleRow || !parts.container) return;

    injectStyle(`
      .tm-sticky-row {
        position: fixed !important;
        z-index: 1030 !important;
        background: #fff !important;
        box-sizing: border-box !important;
        margin-top: 0 !important;
        margin-bottom: 0 !important;
      }
      .tm-sticky-back-row {
        z-index: 1035 !important;
      }
      .tm-sticky-title-row {
        z-index: 1040 !important;
      }
      .tm-sticky-subject-row {
        z-index: 1038 !important;
      }
      .tm-sticky-title-row {
        border-bottom: 1px solid #eceff4;
      }
      .tm-sticky-subject-row {
        border-bottom: 1px solid #eceff4;
      }
      .tm-sticky-title-row .dropdown-menu,
      .tm-sticky-title-row .open > .dropdown-menu {
        z-index: 1045 !important;
      }
      .tm-sticky-title-row.row,
      .tm-sticky-subject-row.row,
      .tm-sticky-back-row.row {
        margin-top: 0 !important;
        margin-bottom: 0 !important;
      }
      .tm-sticky-title-row + .tm-sticky-subject-row {
        margin-top: 0 !important;
      }
      #tm-sticky-header-spacer {
        width: 100%;
      }
      .tm-copy-strip {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        margin-left: 8px;
        vertical-align: middle;
      }
      .tm-inline-mini {
        display: inline-block !important;
        width: auto !important;
        max-width: 120px !important;
        white-space: nowrap !important;
        vertical-align: middle !important;
      }
    `, "tm-sticky-style");

    parts.backRow.classList.add("tm-sticky-row", "tm-sticky-back-row");
    parts.titleRow.classList.add("tm-sticky-row", "tm-sticky-title-row");
    if (parts.subjectRow) parts.subjectRow.classList.add("tm-sticky-row", "tm-sticky-subject-row");

    var spacer = document.getElementById("tm-sticky-header-spacer");
    if (!spacer) {
      spacer = document.createElement("div");
      spacer.id = "tm-sticky-header-spacer";
      var afterNode = parts.subjectRow || parts.titleRow;
      if (afterNode && afterNode.parentNode) {
        if (afterNode.nextSibling) afterNode.parentNode.insertBefore(spacer, afterNode.nextSibling);
        else afterNode.parentNode.appendChild(spacer);
      }
    }

    function calcTopOffset() {
      var header = document.getElementById("section_header");
      return header ? header.offsetHeight : 0;
    }

    function placeRow(row, topPx, leftPx, widthPx) {
      if (!row) return 0;
      row.style.top = topPx + "px";
      row.style.left = "0px";
      row.style.width = Math.max(document.documentElement.clientWidth || widthPx || 0, 0) + "px";
      row.style.right = "auto";
      return row.getBoundingClientRect().height;
    }

    function applyLayout() {
      var containerRect = parts.container.getBoundingClientRect();
      if (!containerRect || !containerRect.width) return;

      var top = calcTopOffset();
      var left = containerRect.left;
      var width = containerRect.width;

      top += placeRow(parts.backRow, top, left, width);
      top += placeRow(parts.titleRow, top, left, width);
      if (parts.subjectRow) top += placeRow(parts.subjectRow, top, left, width);

      if (spacer) spacer.style.height = (top - calcTopOffset() + 8) + "px";
    }

    function scheduleApplyLayout() {
      if (window.__tmStickyLayoutRaf) return;
      window.__tmStickyLayoutRaf = window.requestAnimationFrame(function () {
        window.__tmStickyLayoutRaf = null;
        applyLayout();
      });
    }

    window.__tmStickyApplyLayout = scheduleApplyLayout;
    applyLayout();

    if (!window.__tmStickyRowsBound) {
      window.__tmStickyRowsBound = true;
      window.addEventListener("resize", function () {
        if (typeof window.__tmStickyApplyLayout === "function") window.__tmStickyApplyLayout();
      });
    }
  }

  function ensureTicketCopyButtons() {
    var ticketTitleHeading = document.querySelector(".row h1") || document.querySelector("h1");
    if (!ticketTitleHeading) return;

    ticketTitleHeading.style.display = "inline-block";
    ticketTitleHeading.style.cursor = "copy";
    ticketTitleHeading.setAttribute("title", "Click to copy Ticket #");

    if (!ticketTitleHeading.__tmTicketCopyBound) {
      ticketTitleHeading.__tmTicketCopyBound = true;
      ticketTitleHeading.addEventListener("click", async function () {
        var ticketNumber = (getTicketNumber() || "").trim();
        if (!ticketNumber) {
          flashButton(ticketTitleHeading, false);
          return;
        }
        var ok = await copyToClipboard(ticketNumber);
        flashButton(ticketTitleHeading, ok);
      });
    }
    applyNativeTooltipBehavior(ticketTitleHeading, true);

    var legacySummaryButton = document.getElementById("tm-copy-summary");
    if (legacySummaryButton) legacySummaryButton.remove();

    var topCopyGroup = document.getElementById("tm-top-copy-group");
    if (!topCopyGroup) {
      topCopyGroup = document.createElement("span");
      topCopyGroup.id = "tm-top-copy-group";
      topCopyGroup.style.display = "inline-flex";
      topCopyGroup.style.alignItems = "center";
      topCopyGroup.style.gap = "6px";
      topCopyGroup.style.marginLeft = "0";
      topCopyGroup.style.marginRight = "8px";
      ticketTitleHeading.insertAdjacentElement("afterend", topCopyGroup);
    }

    // Keep copy controls in a consistent place: left of + New in the top action button row.
    var topActionButtonBar = document.querySelector(".title-btns") || document.querySelector(".btn-bar");
    if (topActionButtonBar) {
      topCopyGroup.style.marginLeft = "0";
      topCopyGroup.style.marginRight = "8px";
      topCopyGroup.style.flexWrap = "nowrap";
      if (topActionButtonBar.firstElementChild) {
        topActionButtonBar.insertBefore(topCopyGroup, topActionButtonBar.firstElementChild);
      } else {
        topActionButtonBar.appendChild(topCopyGroup);
      }
    }

    if (!document.getElementById("tm-copy-url-top")) {
      var btnUrl = createMiniButton("Copy URL", "Copy Ticket URL");
      btnUrl.id = "tm-copy-url-top";
      btnUrl.classList.add("tm-inline-mini");
      btnUrl.addEventListener("click", async function () {
        var ticketUrl = (window.location.href || "").trim();
        if (!ticketUrl) {
          flashButton(btnUrl, false);
          return;
        }
        flashButton(btnUrl, await copyToClipboard(ticketUrl));
      });
      topCopyGroup.appendChild(btnUrl);
      applyNativeTooltipBehavior(btnUrl, true);
    }

    if (!document.getElementById("tm-copy-tsu")) {
      var btnTSU = createMiniButton("Copy TSU", "Copy Ticket # + Subject + URL");
      btnTSU.id = "tm-copy-tsu";
      btnTSU.classList.add("tm-inline-mini");
      btnTSU.addEventListener("click", async function () {
        var txt = ("TN: " + getTicketNumber() + " " + getTicketSubject() + " " + window.location.href).trim();
        if (!txt || txt === "TN:") {
          flashButton(btnTSU, false);
          return;
        }
        flashButton(btnTSU, await copyToClipboard(txt));
      });
      topCopyGroup.appendChild(btnTSU);
      applyNativeTooltipBehavior(btnTSU, true);
    }

    if (!document.getElementById("tm-copy-details")) {
      var btnDetails = createMiniButton("Copy Details", "Copy formatted ticket details");
      btnDetails.id = "tm-copy-details";
      btnDetails.classList.add("tm-inline-mini");
      btnDetails.addEventListener("click", async function () {
        var detailsText = (buildTicketSummaryText() || "").trim();
        if (!detailsText) {
          flashButton(btnDetails, false);
          return;
        }
        flashButton(btnDetails, await copyToClipboard(detailsText));
      });
      topCopyGroup.appendChild(btnDetails);
      applyNativeTooltipBehavior(btnDetails, true);
    }

    var actionButtonBar = topActionButtonBar;
    if (!actionButtonBar) return;

    if (!document.getElementById("tm-copy-micro-group")) {
      var microCopyGroup = document.createElement("span");
      microCopyGroup.id = "tm-copy-micro-group";
      microCopyGroup.className = "tm-copy-strip";

      actionButtonBar.appendChild(microCopyGroup);

      applyNativeTooltipBehavior(document.getElementById("tm-copy-url-top"), true);
      applyNativeTooltipBehavior(document.getElementById("tm-copy-tsu"), true);
      applyNativeTooltipBehavior(document.getElementById("tm-copy-details"), true);
      applyNativeTooltipBehavior(ticketTitleHeading, true);
    }

    var customerWidget = getWidgetByHeaderText("Customer Info");
    if (!customerWidget) return;

    function removeOldFieldCopyButtons() {
      var oldIds = [
        "tm-copy-customer-name-field",
        "tm-copy-primary-contact-field",
        "tm-copy-email-field",
        "tm-copy-phone-field",
      ];
      for (var i = 0; i < oldIds.length; i++) {
        var oldBtn = document.getElementById(oldIds[i]);
        if (oldBtn) oldBtn.remove();
      }
    }

    function bindFieldIconCopy(fieldKey, isMatchingLabel, title, getCopyValue) {
      var headerCells = customerWidget.querySelectorAll("th");
      var matchingHeaderCell = null;

      for (var i = 0; i < headerCells.length; i++) {
        var txt = safeText(headerCells[i]).toLowerCase();
        if (isMatchingLabel(txt)) {
          matchingHeaderCell = headerCells[i];
          break;
        }
      }
      if (!matchingHeaderCell) return;

      var row = matchingHeaderCell.closest("tr");
      if (!row) return;

      var icon = row.querySelector("i");
      if (!icon) return;

      var copyBindingFlag = "__tmCopyBound_" + fieldKey;
      if (icon[copyBindingFlag]) return;
      icon[copyBindingFlag] = true;

      icon.style.cursor = "copy";
      icon.setAttribute("title", title);

      var copyFieldValue = async function () {
        var textToCopy = (getCopyValue() || "").trim();
        if (!textToCopy) {
          flashButton(icon, false);
          return;
        }
        var ok = await copyToClipboard(textToCopy);
        flashButton(icon, ok);
      };

      icon.addEventListener("click", copyFieldValue);

      applyNativeTooltipBehavior(icon, false);
    }

    removeOldFieldCopyButtons();

    bindFieldIconCopy(
      "customer",
      function (t) { return t === "customer"; },
      "Copy Customer Name",
      getCustomerName
    );

    bindFieldIconCopy(
      "primaryContact",
      function (t) { return t.indexOf("assigned contact") !== -1 || t.indexOf("primary contact") !== -1; },
      "Copy Primary Contact Name",
      getPrimaryContactName
    );

    bindFieldIconCopy(
      "email",
      function (t) { return t === "email" || t.indexOf("email") !== -1; },
      "Copy Primary Contact Email",
      getPrimaryContactEmail
    );

    bindFieldIconCopy(
      "phone",
      function (t) { return t === "phone" || t.indexOf("phone") !== -1; },
      "Copy Phone",
      getPhone
    );

    bindFieldIconCopy(
      "mobile",
      function (t) { return t.indexOf("contact mobile") !== -1 || t === "mobile"; },
      "Copy Contact Mobile",
      getContactMobile
    );

    bindFieldIconCopy(
      "primaryAddress",
      function (t) { return t.indexOf("primary address") !== -1; },
      "Copy Primary Address",
      getPrimaryAddress
    );

    bindFieldIconCopy(
      "ticketAddress",
      function (t) { return t.indexOf("ticket address") !== -1; },
      "Copy Ticket Address",
      getTicketAddress
    );
  }

  function addWoCSubmitButton() {
    if (document.getElementById("tm-woc-btn")) return;

    var group = document.querySelector(".btn-group.btn-submitComment");
    if (!group) return;

    var btn = document.createElement("button");
    btn.type = "button";
    btn.id = "tm-woc-btn";
    btn.className = "btn btn-default btn-sm";
    btn.textContent = "WoC";
    btn.setAttribute("title", "Submit and set Ticket Status to 'Waiting on Customer'");

    btn.addEventListener("click", function () {
      var sel = document.getElementById("ticket_status");
      if (sel) {
        for (var i = 0; i < sel.options.length; i++) {
          if (String(sel.options[i].value || "") === "Waiting on Customer") {
            sel.selectedIndex = i;
            sel.dispatchEvent(new Event("change", { bubbles: true }));
            break;
          }
        }
      }

      var submit = document.querySelector(".bhv-submitComment") || document.querySelector("#new_comment input[type='submit']");
      if (submit) submit.click();
    });

    group.parentNode.insertBefore(btn, group);
  }

  function buildContextMenu() {
    if (document.getElementById("tm-context-menu")) return;

    injectStyle(`
      #tm-context-menu{
        position:fixed;
        z-index:100000;
        background:#fff;
        border:1px solid #d9dce3;
        box-shadow:0 6px 18px rgba(0,0,0,.18);
        border-radius:6px;
        padding:4px;
        min-width: 240px;
        font-family: "Open Sans", Arial, sans-serif;
        font-size: 13px;
        display:none;
      }
      #tm-context-menu .tm-item{
        padding:6px 10px;
        cursor:pointer;
        border-radius:4px;
        user-select:none;
        display:flex;
        gap:8px;
        align-items:center;
      }
      #tm-context-menu .tm-item:hover{ background:#eef2f7; }
      #tm-context-menu .tm-sep{ height:1px; background:#e6e9ef; margin:4px 0; }
      #tm-context-menu .tm-hdr{
        padding:6px 10px;
        font-weight:700;
        color:#444;
        user-select:none;
      }
    `, "tm-context-style");

    var menu = document.createElement("div");
    menu.id = "tm-context-menu";

    function hide() { menu.style.display = "none"; }

    function item(label, onClick) {
      var d = document.createElement("div");
      d.className = "tm-item";
      d.textContent = label;
      d.addEventListener("click", function (e) {
        e.preventDefault(); e.stopPropagation();
        hide();
        onClick();
      });
      return d;
    }
    function sep() { var d = document.createElement("div"); d.className = "tm-sep"; return d; }
    function hdr(t) { var d = document.createElement("div"); d.className = "tm-hdr"; d.textContent = t; return d; }

    document.body.appendChild(menu);
    document.addEventListener("click", hide);
    document.addEventListener("scroll", hide, true);
    window.addEventListener("blur", hide);

    function getEditorEl() {
      return document.querySelector(".note-editable") || document.getElementById("comment_body");
    }

    async function pasteIntoEditor(text) {
      var ed = getEditorEl();
      if (!ed) return;

      // OPTIONAL (included): if it looks like HTML, always insert as HTML (prevents truncation/format-loss)
      var looksHtml = /<\/?[a-z][\s\S]*>/i.test(text);

      if (ed.isContentEditable) {
        ed.focus();
        if (looksHtml) document.execCommand("insertHTML", false, text);
        else document.execCommand("insertText", false, text);
        return;
      }

      ed.focus();
      var start = ed.selectionStart || 0;
      var end = ed.selectionEnd || 0;
      var val = ed.value || "";
      ed.value = val.slice(0, start) + text + val.slice(end);
      ed.selectionStart = ed.selectionEnd = start + text.length;
      ed.dispatchEvent(new Event("input", { bubbles: true }));
    }

    // ✅ FIX: always use the real data-body attribute (not truncated cell text)
    function getCannedRows() {
      var wanted = ((document.getElementById("comment_subject") && document.getElementById("comment_subject").value) || "").trim().toLowerCase();
      var rows = document.querySelectorAll("#canny-datatable tbody tr");
      var out = [];

      for (var i = 0; i < rows.length; i++) {
        var tr = rows[i];
        var tds = tr.querySelectorAll("td");
        if (!tds || tds.length < 2) continue;

        var title = safeText(tds[1]) || safeText(tds[0]);
        if (!title) continue;

        var subjCell = tds[2] ? safeText(tds[2]).toLowerCase() : "";
        var subjAttr = ((tr.getAttribute("data-subject") || (tr.dataset && tr.dataset.subject) || "") + "").trim().toLowerCase();
        var subj = subjAttr || subjCell;

        if (wanted) {
          if (!subj || subj !== wanted) continue;
        }

        // Find the element that actually holds data-body
        var bodyEl = tr.querySelector("[data-body]");
        var body = bodyEl ? (bodyEl.getAttribute("data-body") || (bodyEl.dataset && bodyEl.dataset.body) || "") : "";

        // Fallback: sometimes it sits on the tr itself
        if (!body) body = tr.getAttribute("data-body") || (tr.dataset && tr.dataset.body) || "";

        if (!body) continue;

        body = decodeHtmlEntities(body);
        out.push({ title: title, body: body });
      }
      return out;
    }

    function showAt(x, y) {
      menu.innerHTML = "";

      menu.appendChild(item("Copy", function () { document.execCommand("copy"); }));
      menu.appendChild(item("Cut", function () { document.execCommand("cut"); }));
      menu.appendChild(item("Paste", async function () {
        try {
          var txt = await navigator.clipboard.readText();
          await pasteIntoEditor(txt);
        } catch (e) {}
      }));

      var canned = getCannedRows();
      if (canned && canned.length) {
        menu.appendChild(sep());
        menu.appendChild(hdr("Canned responses"));
        for (var i = 0; i < canned.length; i++) {
          (function (row) {
            menu.appendChild(item(row.title, function () { pasteIntoEditor(row.body); }));
          })(canned[i]);
        }
      }

      var vw = Math.max(document.documentElement.clientWidth || 0, window.innerWidth || 0);
      var vh = Math.max(document.documentElement.clientHeight || 0, window.innerHeight || 0);

      menu.style.display = "block";
      menu.style.left = "0px";
      menu.style.top = "0px";

      var rect = menu.getBoundingClientRect();
      var nx = Math.min(x, vw - rect.width - 8);
      var ny = Math.min(y, vh - rect.height - 8);

      menu.style.left = Math.max(8, nx) + "px";
      menu.style.top = Math.max(8, ny) + "px";
    }

    if (!window.__tmContextMenuBound) {
      window.__tmContextMenuBound = true;
      document.addEventListener("contextmenu", function (e) {
        var ed = e.target && (e.target.closest(".note-editable") || e.target.id === "comment_body");
        if (!ed) return;
        e.preventDefault(); e.stopPropagation();
        showAt(e.clientX, e.clientY);
      }, true);
    }
  }

  /* ═══════════════════ DETECTION ═══════════════════ */
  function runInjectionStep(name, fn) {
    try {
      fn();
    } catch (err) {
      console.warn("[SyncroTM] Injection step failed:", name, err);
    }
  }

  function beginInjectionCycleCache() {
    widgetCacheByHeader = {};
  }

  function runInjections() {
    beginInjectionCycleCache();
    runInjectionStep("cleanupLaborLog", cleanupLaborLog);
    runInjectionStep("injectLaborLog", injectLaborLog);
    runInjectionStep("injectCommentForm", injectCommentForm);

    runInjectionStep("cleanupLegacyStickyTopBar", cleanupLegacyStickyTopBar);
    runInjectionStep("ensureStickyTicketHeaderRows", ensureStickyTicketHeaderRows);
    runInjectionStep("ensureTicketCopyButtons", ensureTicketCopyButtons);
    runInjectionStep("addWoCSubmitButton", addWoCSubmitButton);
    runInjectionStep("buildContextMenu", buildContextMenu);

    widgetCacheByHeader = null;
  }

  var runQueued = false;
  function scheduleRunInjections() {
    if (runQueued) return;
    runQueued = true;
    window.requestAnimationFrame(function () {
      runQueued = false;
      runInjections();
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
    if (mutationHasExternalChanges(mutationList)) scheduleRunInjections();
  });
  observer.observe(getObservationRoot(), { childList: true, subtree: true });

  var pollCount = 0;
  var maxPollAttempts = 15;
  var pollInterval = setInterval(function () {
    pollCount++;

    if (document.getElementById("tm-comment-helper") && document.getElementById("tm-copy-micro-group")) {
      clearInterval(pollInterval);
      return;
    }

    scheduleRunInjections();

    if (pollCount >= maxPollAttempts) clearInterval(pollInterval);
  }, 2000);

  window.addEventListener("load", scheduleRunInjections);
  if (document.readyState === "complete" || document.readyState === "interactive") setTimeout(scheduleRunInjections, 0);
  else document.addEventListener("DOMContentLoaded", scheduleRunInjections);

})();