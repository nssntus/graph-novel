/**
 * 番茄小说工坊 — 浮动创意助手「小番」
 *
 * Floating chat widget: injects a FAB + slide-up panel into every page.
 * Calls /api/<projectId>/chat with message + history, renders assistant replies.
 *
 * Modes:
 *   - creative (no project): free brainstorm, no push to fill forms
 *   - project context: reads world/chars/outline from current project
 */

(function () {
  "use strict";

  let isOpen = false;
  let isLoading = false;
  let chatHistory = [];
  let projectId = "";

  // --------------- DOM construction ---------------

  function createWidget() {
    // Find projectId from the page: data attribute on body or URL
    const bodyData = document.body.dataset.projectId;
    const pathMatch = window.location.pathname.match(/\/project\/([^\/]+)/);
    projectId = bodyData || (pathMatch ? pathMatch[1] : "");

    // FAB button
    const fab = document.createElement("button");
    fab.className = "chat-fab";
    fab.id = "chat-fab";
    fab.innerHTML = '🍅<span class="fab-dot"></span>';
    fab.title = "和小番聊聊创意";
    fab.addEventListener("click", toggleChat);
    document.body.appendChild(fab);

    // Chat panel
    const panel = document.createElement("div");
    panel.className = "chat-panel";
    panel.id = "chat-panel";
    panel.innerHTML = `
      <div class="chat-header">
        <div class="avatar">🍅</div>
        <div class="title-block">
          <div class="title">小番 · 创意助手</div>
          <div class="subtitle">你的番茄小说写作搭档</div>
        </div>
        <button class="chat-close" id="chat-close" title="关闭">✕</button>
      </div>
      <div class="chat-messages" id="chat-messages">
        <div class="chat-empty">
          <div class="empty-icon">💡</div>
          <p>嗨！我是小番，你的创意搭档。<br>聊聊你的小说想法吧～</p>
          <div class="hint-list">
            <button class="hint-btn" data-hint="我想写一个都市题材的小说，帮我发散一下创意？">发散创意</button>
            <button class="hint-btn" data-hint="我有个主角设定，帮我看看有没有爆款潜力">主角设定</button>
            <button class="hint-btn" data-hint="番茄小说现在什么题材最火？">热门题材</button>
            <button class="hint-btn" data-hint="怎么设计一个能留住读者的开篇？">黄金三章</button>
            <button class="hint-btn" data-hint="我有个情节想法，帮我看看合不合理">情节诊断</button>
          </div>
        </div>
      </div>
      <div class="chat-input-wrap">
        <textarea id="chat-input" rows="1" placeholder="输入你的想法……" maxlength="2000"></textarea>
        <button class="send-btn" id="send-btn" title="发送">➤</button>
      </div>
    `;
    document.body.appendChild(panel);

    // Events
    document.getElementById("chat-close").addEventListener("click", closeChat);
    document.getElementById("send-btn").addEventListener("click", sendMessage);
    const input = document.getElementById("chat-input");
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });
    input.addEventListener("input", autoResize);

    // Hint buttons
    panel.querySelectorAll(".hint-btn").forEach(function (btn) {
      btn.addEventListener("click", function () {
        const hint = this.dataset.hint;
        document.getElementById("chat-input").value = hint;
        sendMessage();
      });
    });
  }

  // --------------- Actions ---------------

  function toggleChat() {
    isOpen ? closeChat() : openChat();
  }

  function openChat() {
    isOpen = true;
    const fab = document.getElementById("chat-fab");
    const panel = document.getElementById("chat-panel");
    fab.classList.add("open");
    panel.classList.add("open");
    document.getElementById("chat-input").focus();
    scrollToBottom();
  }

  function closeChat() {
    isOpen = false;
    const fab = document.getElementById("chat-fab");
    const panel = document.getElementById("chat-panel");
    fab.classList.remove("open");
    panel.classList.remove("open");
    // Reset for next open — start fresh conversation visually
    document.getElementById("chat-input").value = "";
    document.getElementById("chat-input").style.height = "auto";
  }

  async function sendMessage() {
    if (isLoading) return;

    const input = document.getElementById("chat-input");
    const message = input.value.trim();
    if (!message) return;

    input.value = "";
    autoResize.call(input);

    // Remove empty state
    const empty = document.querySelector(".chat-empty");
    if (empty) empty.remove();

    // Add user message
    appendMessage("user", message);
    chatHistory.push({ role: "user", content: message });

    // Show typing
    setLoading(true);

    try {
      // If no project context, fall back to creative-only chat mode
      const apiProjectId = projectId || "creative";

      const resp = await fetch("/api/" + apiProjectId + "/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: message, history: chatHistory }),
      });

      const data = await resp.json();

      if (data.success) {
        appendMessage("assistant", data.reply);
        chatHistory.push({ role: "assistant", content: data.reply });
      } else {
        appendMessage("assistant", "抱歉，出了点问题：" + (data.error || "未知错误") + "。请再试一次。");
      }
    } catch (err) {
      appendMessage("assistant", "网络连接失败：" + err.message + "。请确认服务器在运行。");
      chatHistory.pop();  // remove the user message that could not be sent
    }

    setLoading(false);
  }

  // --------------- Rendering ---------------

  function appendMessage(role, text) {
    const container = document.getElementById("chat-messages");
    const msg = document.createElement("div");
    msg.className = "chat-msg " + role;

    const content = document.createElement("div");
    content.className = "msg-content";
    content.innerHTML = formatMessage(text);

    const time = document.createElement("div");
    time.className = "msg-time";
    time.textContent = new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });

    msg.appendChild(content);
    msg.appendChild(time);
    container.appendChild(msg);
    scrollToBottom();
  }

  function formatMessage(text) {
    // Simple markdown-like formatting
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/\n/g, "<br>")
      .replace(/`([^`]+)`/g, "<code>$1</code>");
  }

  function setLoading(loading) {
    isLoading = loading;
    const sendBtn = document.getElementById("send-btn");
    const input = document.getElementById("chat-input");

    if (loading) {
      sendBtn.disabled = true;
      input.disabled = true;

      // Add typing indicator
      const container = document.getElementById("chat-messages");
      const typing = document.createElement("div");
      typing.className = "chat-msg assistant typing-indicator";
      typing.id = "typing-indicator";
      typing.innerHTML = '<div class="typing-dots"><span></span><span></span><span></span></div>';
      container.appendChild(typing);
      scrollToBottom();
    } else {
      sendBtn.disabled = false;
      input.disabled = false;
      const typing = document.getElementById("typing-indicator");
      if (typing) typing.remove();
      input.focus();
    }
  }

  function scrollToBottom() {
    const container = document.getElementById("chat-messages");
    setTimeout(function () {
      container.scrollTop = container.scrollHeight;
    }, 50);
  }

  function autoResize() {
    this.style.height = "auto";
    this.style.height = Math.min(this.scrollHeight, 100) + "px";
  }

  // Clear empty-state hints when they become irrelevant
  if (history.length > 0) {
    const empty = document.querySelector(".chat-empty");
    if (empty) empty.remove();
  }

  // --------------- Init ---------------

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", createWidget);
  } else {
    createWidget();
  }
})();
