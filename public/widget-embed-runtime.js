/* Appended after window.__APPOINTBOT_WIDGET__ = {...} by /widget.js */
(function () {
  var cfg = window.__APPOINTBOT_WIDGET__;
  if (!cfg || !cfg.apiKey || !cfg.baseUrl) return;
  try {
    delete window.__APPOINTBOT_WIDGET__;
  } catch (e) {}

  if (window.__appointbotWidgetLoaded) return;
  window.__appointbotWidgetLoaded = true;

  var BASE = String(cfg.baseUrl).replace(/\/$/, "");
  var KEY = cfg.apiKey;
  var bizLabel = cfg.brandName || "Chat";
  var slug = cfg.slug || "widget";

  var FONT =
    "https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700&family=Outfit:wght@500;600;700&display=swap";
  if (!document.querySelector('link[data-ab-w="1"]')) {
    var fl = document.createElement("link");
    fl.rel = "stylesheet";
    fl.href = FONT;
    fl.setAttribute("data-ab-w", "1");
    document.head.appendChild(fl);
  }

  var panel = document.createElement("div");
  panel.setAttribute("data-ab-widget-panel", "1");
  panel.style.cssText = [
    "position:fixed",
    "right:max(16px, env(safe-area-inset-right))",
    "bottom:max(16px, env(safe-area-inset-bottom))",
    "width:min(400px, calc(100vw - 32px))",
    "height:min(580px, calc(100dvh - 96px))",
    "z-index:2147483000",
    "display:none",
    "background:#fff",
    "overflow:hidden",
    "border-radius:20px",
    "box-shadow:0 25px 80px rgba(15,23,42,0.35), 0 0 0 1px rgba(15,23,42,0.06)",
  ].join(";");

  var btn = document.createElement("button");
  btn.type = "button";
  btn.setAttribute("aria-label", "Open chat");
  btn.style.cssText = [
    "position:fixed",
    "right:max(16px, env(safe-area-inset-right))",
    "bottom:max(16px, env(safe-area-inset-bottom))",
    "width:58px",
    "height:58px",
    "border:0",
    "border-radius:999px",
    "cursor:pointer",
    "z-index:2147483001",
    "background:linear-gradient(145deg,#0d9488,#0f766e)",
    "color:#fff",
    "box-shadow:0 12px 40px rgba(13,148,136,0.45), 0 2px 8px rgba(0,0,0,0.12)",
    "display:flex",
    "align-items:center",
    "justify-content:center",
  ].join(";");
  btn.innerHTML =
    '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>';

  var shadow = panel.attachShadow({ mode: "open" });
  var style = document.createElement("style");
  style.textContent = cfg.css || "";
  shadow.appendChild(style);

  var shell = document.createElement("div");
  shell.className = "shell";
  shell.innerHTML =
    '<header class="header">' +
    '<div class="avatar" id="ab-av" aria-hidden="true">✦</div>' +
    '<div class="header-text">' +
    '<div class="header-name" id="ab-name">Appointbot</div>' +
    '<div class="header-sub">AI booking assistant</div></div>' +
    '<div class="header-actions">' +
    '<button type="button" class="reset-btn" id="ab-reset">Reset</button>' +
    '<button type="button" class="close-btn" id="ab-close" aria-label="Close chat">' +
    '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12"/></svg>' +
    "</button></div></header>" +
    '<div class="messages" id="ab-msg" role="log" aria-live="polite"></div>' +
    '<div class="quick-cmds" aria-label="Quick actions">' +
    '<button type="button" class="cmd-btn" data-q="HELP">Help</button>' +
    '<button type="button" class="cmd-btn" data-q="Book haircut tomorrow at 5pm">Book</button>' +
    '<button type="button" class="cmd-btn" data-q="My appointments">My bookings</button>' +
    '<button type="button" class="cmd-btn" data-q="Cancel my appointment">Cancel</button></div>' +
    '<div class="input-area">' +
    '<div class="input-wrap"><textarea id="ab-in" rows="1" placeholder="Type a message…" aria-label="Message"></textarea></div>' +
    '<button type="button" class="send-btn" id="ab-send" aria-label="Send message">' +
    '<svg viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg></button></div>' +
    '<div class="footer-note">' +
    'Powered by <a href="https://appointbot.com" target="_blank" rel="noopener noreferrer">Appointbot</a></div>';

  shadow.appendChild(shell);

  var messagesEl = shadow.getElementById("ab-msg");
  var input = shadow.getElementById("ab-in");
  var open = false;

  function setOpen(v) {
    open = v;
    panel.style.display = v ? "block" : "none";
    // Hide floating launcher while panel is open so it never overlaps the send row.
    btn.style.display = v ? "none" : "flex";
    btn.setAttribute("aria-label", "Open chat");
    btn.innerHTML =
      '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>';
    if (v) {
      try {
        input.focus();
      } catch (e) {}
    }
  }

  btn.addEventListener("click", function () {
    if (!open) setOpen(true);
  });

  shadow.getElementById("ab-close").addEventListener("click", function () {
    setOpen(false);
  });

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && open) setOpen(false);
  });

  function applyBranding() {
    shadow.getElementById("ab-name").textContent = bizLabel;
    var av = shadow.getElementById("ab-av");
    av.textContent = (bizLabel || "A").trim().charAt(0).toUpperCase();
  }

  function now() {
    return new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
  }

  function formatText(text) {
    return String(text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\*([^*]+)\*/g, "<b>$1</b>")
      .replace(/_([^_]+)_/g, "<i>$1</i>")
      .replace(/~([^~]+)~/g, "<s>$1</s>")
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\n/g, "<br>");
  }

  function addBubble(text, type) {
    var wrap = document.createElement("div");
    wrap.className = "bubble-wrap " + type;
    wrap.innerHTML =
      '<div class="bubble ' +
      type +
      '"><span>' +
      formatText(text) +
      "</span><time>" +
      now() +
      "</time></div>";
    messagesEl.appendChild(wrap);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function showTyping() {
    var el = document.createElement("div");
    el.className = "bubble-wrap bot";
    el.id = "ab-typing";
    el.innerHTML = '<div class="bubble bot typing"><span></span><span></span><span></span></div>';
    messagesEl.appendChild(el);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return el;
  }

  function removeTyping() {
    var t = shadow.getElementById("ab-typing");
    if (t) t.remove();
  }

  function autoResize(el) {
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 100) + "px";
  }

  input.addEventListener("input", function () {
    autoResize(input);
  });

  input.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  shadow.getElementById("ab-reset").addEventListener("click", resetChat);
  shadow.getElementById("ab-send").addEventListener("click", sendMessage);

  shell.querySelectorAll(".cmd-btn").forEach(function (b) {
    b.addEventListener("click", function () {
      var t = b.getAttribute("data-q") || "";
      input.value = t;
      sendMessage();
    });
  });

  function sendMessage() {
    var text = (input.value || "").trim();
    if (!text) return;
    input.value = "";
    autoResize(input);

    addBubble(text, "user");
    var typingEl = showTyping();

    fetch(BASE + "/api/widget/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Widget-Api-Key": KEY,
      },
      body: JSON.stringify({
        message: text,
        source: "web_chat_widget",
        campaign: "",
        utmSource: "",
      }),
    })
      .then(function (res) {
        return res.text();
      })
      .then(function (raw) {
        var data;
        try {
          data = JSON.parse(raw);
        } catch (e) {
          removeTyping();
          addBubble("Could not reach the assistant. Please try again in a moment.", "bot");
          return;
        }
        removeTyping();
        if (data.businessName) {
          bizLabel = data.businessName;
          applyBranding();
        }
        addBubble(data.reply || "(no reply)", "bot");
      })
      .catch(function () {
        removeTyping();
        addBubble("Could not reach the assistant. Please try again in a moment.", "bot");
      });
  }

  function resetChat() {
    fetch(BASE + "/api/widget/session", {
      method: "DELETE",
      headers: { "X-Widget-Api-Key": KEY },
    }).catch(function () {});
    messagesEl.innerHTML = "";
    addBubble(
      "Session reset. Say *HELP* anytime, or ask to book an appointment.",
      "bot",
    );
  }

  document.body.appendChild(panel);
  document.body.appendChild(btn);

  applyBranding();
  addBubble(
    "👋 Hi! I'm your assistant at *" +
      bizLabel +
      '*.\n\nAsk *HELP* for options, or say something like _"Book a haircut tomorrow at 5pm"_.',
    "bot",
  );
})();
