const state = {
  socket: null,
  me: null,
  users: [],
  dmPeer: null,
  dmThreads: new Map(),
  unreadDms: new Set()
};

const els = {
  themeSelect: document.querySelector("#themeSelect"),
  status: document.querySelector("#connectionStatus"),
  messages: document.querySelector("#messages"),
  messageForm: document.querySelector("#messageForm"),
  messageInput: document.querySelector("#messageInput"),
  usersList: document.querySelector("#usersList"),
  userCount: document.querySelector("#userCount"),
  currentUser: document.querySelector("#currentUser"),
  dmPanel: document.querySelector("#dmPanel"),
  dmTitle: document.querySelector("#dmTitle"),
  closeDm: document.querySelector("#closeDm"),
  dmMessages: document.querySelector("#dmMessages"),
  dmForm: document.querySelector("#dmForm"),
  dmInput: document.querySelector("#dmInput")
};

const availableThemes = new Set(["dark", "light", "terminal", "dracula"]);
const savedThemeValue = localStorage.getItem("cubechat-theme") || "dark";
const savedTheme = availableThemes.has(savedThemeValue) ? savedThemeValue : "dark";
document.documentElement.dataset.theme = savedTheme;
els.themeSelect.value = savedTheme;

connect();

els.themeSelect.addEventListener("change", () => {
  document.documentElement.dataset.theme = els.themeSelect.value;
  localStorage.setItem("cubechat-theme", els.themeSelect.value);
});

els.messageForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = els.messageInput.value.trim();
  if (!text) return;
  send({ type: "global-message", text });
  els.messageInput.value = "";
  setTypingState(els.messageInput, false);
});

els.dmForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = els.dmInput.value.trim();
  if (!text || !state.dmPeer) return;
  send({ type: "dm-message", to: state.dmPeer.id, text });
  els.dmInput.value = "";
  setTypingState(els.dmInput, false);
});

els.closeDm.addEventListener("click", () => {
  state.dmPeer = null;
  els.dmPanel.hidden = true;
});

bindTypingState(els.messageInput);
bindTypingState(els.dmInput);

function connect() {
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  const socket = new WebSocket(`${protocol}://${location.host}`);
  state.socket = socket;

  socket.addEventListener("open", () => setStatus("online", true));
  socket.addEventListener("close", () => {
    setStatus("reconnecting", false);
    setTimeout(connect, 900);
  });
  socket.addEventListener("error", () => setStatus("connection issue", false));
  socket.addEventListener("message", (event) => {
    const payload = JSON.parse(event.data);
    handlePayload(payload);
  });
}

function handlePayload(payload) {
  if (payload.type === "welcome") {
    state.me = payload.user;
    state.users = payload.activeUsers;
    renderCurrentUser();
    renderUsers();
    els.messages.replaceChildren();
    payload.globalMessages.forEach((message) => appendMessage(message, false));
    scrollToBottom(els.messages);
    return;
  }

  if (payload.type === "users") {
    state.users = payload.users;
    renderUsers();
    if (state.dmPeer && !state.users.some((user) => user.id === state.dmPeer.id)) {
      state.dmPeer = null;
      els.dmPanel.hidden = true;
    }
    return;
  }

  if (payload.type === "global-message") {
    appendMessage(payload.message, payload.message.from.id === state.me?.id);
    return;
  }

  if (payload.type === "system") {
    appendSystem(payload.message);
    return;
  }

  if (payload.type === "dm-message") {
    rememberDm(payload.message);
    if (state.dmPeer && isDmForPeer(payload.message, state.dmPeer.id)) {
      renderDmThread();
      send({ type: "dm-opened", peerId: state.dmPeer.id });
    } else if (payload.message.from.id !== state.me?.id) {
      state.unreadDms.add(payload.message.from.id);
      renderUsers();
    }
    return;
  }

  if (payload.type === "dm-history") {
    state.dmThreads.set(payload.peerId, payload.messages);
    if (state.dmPeer?.id === payload.peerId) renderDmThread();
  }
}

function renderCurrentUser() {
  if (!state.me) return;
  els.currentUser.innerHTML = "";
  const row = document.createElement("div");
  row.className = "user-button";
  row.append(createDot(state.me.color), document.createTextNode(`${state.me.name} (you)`));
  els.currentUser.append(row);
}

function renderUsers() {
  els.userCount.textContent = String(state.users.length);
  els.usersList.replaceChildren();

  state.users.forEach((user) => {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "user-button";
    button.classList.toggle("has-unread", state.unreadDms.has(user.id));
    button.disabled = user.id === state.me?.id;
    button.append(createDot(user.color), document.createTextNode(user.id === state.me?.id ? `${user.name} (you)` : user.name));
    button.addEventListener("click", () => openDm(user));
    item.append(button);
    els.usersList.append(item);
  });
}

function openDm(user) {
  if (user.id === state.me?.id) return;
  state.dmPeer = user;
  state.unreadDms.delete(user.id);
  els.dmTitle.textContent = user.name;
  els.dmPanel.hidden = false;
  renderDmThread();
  renderUsers();
  send({ type: "dm-opened", peerId: user.id });
  setTimeout(() => els.dmInput.focus(), 0);
}

function appendMessage(message, sentByMe) {
  const isSelf = message.from.id === state.me?.id;
  const wrapper = document.createElement("article");
  wrapper.className = `message${isSelf ? " is-self" : ""}${sentByMe ? " is-sent" : ""}`;

  const meta = document.createElement("div");
  meta.className = "message__meta";
  meta.append(createDot(message.from.color));

  const name = document.createElement("button");
  name.type = "button";
  name.className = "message__name";
  name.style.setProperty("--name-color", message.from.color);
  name.textContent = isSelf ? `${message.from.name} (you)` : message.from.name;
  name.addEventListener("click", () => openDm(message.from));

  const time = document.createElement("span");
  time.textContent = formatTime(message.createdAt);
  meta.append(name, time);

  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.textContent = message.text;

  wrapper.append(meta, bubble);
  els.messages.append(wrapper);
  scrollToBottom(els.messages);
}

function appendSystem(text) {
  const element = document.createElement("div");
  element.className = "system-message";
  element.textContent = text;
  els.messages.append(element);
  scrollToBottom(els.messages);
}

function rememberDm(message) {
  const peerId = message.from.id === state.me?.id ? message.to : message.from.id;
  const thread = state.dmThreads.get(peerId) || [];
  if (!thread.some((item) => item.id === message.id)) {
    thread.push(message);
    state.dmThreads.set(peerId, thread);
  }
}

function renderDmThread() {
  if (!state.dmPeer) return;
  const thread = state.dmThreads.get(state.dmPeer.id) || [];
  els.dmMessages.replaceChildren();
  thread.forEach((message) => {
    const isSelf = message.from.id === state.me?.id;
    const wrapper = document.createElement("article");
    wrapper.className = `message${isSelf ? " is-self" : ""}`;

    const meta = document.createElement("div");
    meta.className = "message__meta";
    meta.append(createDot(message.from.color));

    const name = document.createElement("span");
    name.style.color = message.from.color;
    name.textContent = isSelf ? "you" : message.from.name;

    const time = document.createElement("span");
    time.textContent = formatTime(message.createdAt);
    meta.append(name, time);

    const bubble = document.createElement("div");
    bubble.className = "bubble";
    bubble.textContent = message.text;
    wrapper.append(meta, bubble);
    els.dmMessages.append(wrapper);
  });
  scrollToBottom(els.dmMessages);
}

function isDmForPeer(message, peerId) {
  return message.from.id === peerId || message.to === peerId;
}

function send(payload) {
  if (state.socket?.readyState === WebSocket.OPEN) {
    state.socket.send(JSON.stringify(payload));
  }
}

function bindTypingState(input) {
  input.addEventListener("input", () => setTypingState(input, input.value.length > 0));
  input.addEventListener("blur", () => setTypingState(input, false));
}

function setTypingState(input, isTyping) {
  input.closest(".input-shell")?.classList.toggle("is-typing", isTyping);
}

function setStatus(text, online) {
  els.status.textContent = text;
  els.status.classList.toggle("is-online", online);
}

function createDot(color) {
  const dot = document.createElement("span");
  dot.className = "color-dot";
  dot.style.setProperty("--dot", color);
  return dot;
}

function scrollToBottom(element) {
  requestAnimationFrame(() => {
    element.scrollTop = element.scrollHeight;
  });
}

function formatTime(timestamp) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(timestamp));
}
