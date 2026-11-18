import { createClient } from "./backend-client.js";

const backend = createClient();
const NA_SERVER_ID = "10000000-0000-4000-8000-000000000001";
const CHAT_PATH = new URL("../chat/", import.meta.url);
const isChatPage = /\/chat(?:\/|$)/i.test(location.pathname);
let currentUser = null;
let currentUsername = "";
let toast = null;
let hideTimer = null;
let replaceTimer = null;
let activeChannel = null;
let dmMemberships = new Set();

function escapeRegExp(value) {
  return String(value || "").split("").map(char => "\\^$.*+?()[]{}|".includes(char) ? "\\" + char : char).join("");
}
function containsMention(content, username) {
  const text = String(content || "");
  if (!username || String(username).toLowerCase() === "here") return false;
  const userPattern = new RegExp("(^|[^A-Za-z0-9_.-])@" + escapeRegExp(username) + "(?![A-Za-z0-9_.-])", "i");
  return userPattern.test(text);
}
function containsEveryone(content) {
  return /(^|[^A-Za-z0-9_.-])@everyone(?![A-Za-z0-9_.-])/i.test(String(content || ""));
}
function isIgnoredDM(userId, conversationId) {
  try {
    const ignored = JSON.parse(localStorage.getItem("cg-ignored-dms:" + userId) || "[]");
    return Array.isArray(ignored) && ignored.includes(conversationId);
  } catch (_) { return false; }
}
function chatIsActiveElsewhere() {
  if (isChatPage) return true;
  if (!currentUser?.id) return false;
  const stamp = Number(localStorage.getItem("cg-chat-active:" + currentUser.id) || 0);
  return stamp > 0 && Date.now() - stamp < 6500;
}
function canShowToast() {
  return document.visibilityState === "visible" && !chatIsActiveElsewhere();
}
function ensureToast() {
  if (toast) return toast;
  const style = document.createElement("style");
  style.textContent = [
    ".cg-mention-toast{position:fixed;z-index:2147483000;top:max(14px,env(safe-area-inset-top));left:14px;width:min(370px,calc(100vw - 28px));padding:14px 16px;text-align:left;color:#f8fafc;background:linear-gradient(145deg,#24283a,#171a27);border:1px solid rgba(148,163,184,.26);border-radius:13px;box-shadow:0 16px 42px rgba(0,0,0,.42);font:inherit;cursor:pointer;transform:translateX(calc(-100% - 24px));opacity:0;transition:transform .28s cubic-bezier(.2,.8,.2,1),opacity .22s ease;overflow:hidden}",
    ".cg-mention-toast.cg-visible{transform:translateX(0);opacity:1}",
    ".cg-mention-toast-title{display:block;font-size:13px;font-weight:750;line-height:1.35;margin:0 0 5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
    ".cg-mention-toast-message{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3;overflow:hidden;overflow-wrap:anywhere;color:#cbd5e1;font-size:12px;line-height:1.45;max-height:52px}",
    "@media(prefers-reduced-motion:reduce){.cg-mention-toast{transition:none}}"
  ].join("");
  document.head.appendChild(style);
  toast = document.createElement("button");
  toast.type = "button";
  toast.className = "cg-mention-toast";
  toast.setAttribute("aria-live", "polite");
  toast.setAttribute("aria-label", "Chat mention notification");
  toast.innerHTML = '<span class="cg-mention-toast-title"></span><span class="cg-mention-toast-message"></span>';
  document.body.appendChild(toast);
  toast.addEventListener("click", () => {
    const target = toast?.dataset.target;
    clearTimeout(hideTimer);
    toast.classList.remove("cg-visible");
    if (target) location.href = target;
  });
  return toast;
}
function dismissToast() {
  if (!toast) return;
  toast.classList.remove("cg-visible");
  clearTimeout(hideTimer);
}
function showMentionToast(title, message, targetUrl) {
  if (!canShowToast()) return;
  const el = ensureToast();
  clearTimeout(hideTimer);
  clearTimeout(replaceTimer);
  if (el.classList.contains("cg-visible")) {
    el.classList.remove("cg-visible");
    replaceTimer = setTimeout(() => fillAndShow(el, title, message, targetUrl), 190);
  } else {
    fillAndShow(el, title, message, targetUrl);
  }
}
function fillAndShow(el, title, message, targetUrl) {
  if (!canShowToast()) return;
  el.querySelector(".cg-mention-toast-title").textContent = title;
  el.querySelector(".cg-mention-toast-message").textContent = message || "";
  el.dataset.target = targetUrl;
  requestAnimationFrame(() => el.classList.add("cg-visible"));
  hideTimer = setTimeout(dismissToast, 6000);
}
function chatUrlFor(params) {
  const url = new URL(CHAT_PATH.href);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  return url.href;
}
async function senderName(userId, fallback) {
  if (!userId) return fallback || "Someone";
  const { data } = await backend.from("users").select("username").eq("id", userId).maybeSingle();
  return data?.username || fallback || "Someone";
}
function notifyNaMessage(message) {
  if (!message || message.userId === currentUser.id || message.isWhisper || message.isSystemMessage || message.role === "system") return;
  if (message.server_id !== NA_SERVER_ID) return;
  const content = String(message.text || "");
  const everyone = containsEveryone(content);
  if (!everyone && !containsMention(content, currentUsername)) return;
  const sender = message.username || "Someone";
  showMentionToast("@" + sender + " mentioned you in NA Chat", content, chatUrlFor({ channel: message.channel_id }));
}
async function notifyDMMessage(message) {
  if (!message || message.sender_id === currentUser.id || !message.conversation_id || !dmMemberships.has(message.conversation_id)) return;
  if (isIgnoredDM(currentUser.id, message.conversation_id)) return;
  if (!containsMention(message.content, currentUsername)) return;
  const sender = await senderName(message.sender_id, "Someone");
  if (!canShowToast()) return;
  showMentionToast("@" + sender + " mentioned you in a DM", message.content, chatUrlFor({ dm: message.conversation_id }));
}
async function start() {
  const { data: authData, error: authError } = await backend.auth.getUser();
  currentUser = authData?.user || null;
  if (authError || !currentUser?.id) return;
  const { data: profile } = await backend.from("users").select("username").eq("id", currentUser.id).maybeSingle();
  currentUsername = profile?.username || currentUser.user_metadata?.username || "";
  if (!currentUsername) return;

  if (isChatPage) {
    const key = "cg-chat-active:" + currentUser.id;
    const setActive = () => {
      if (document.visibilityState === "visible") localStorage.setItem(key, String(Date.now()));
      else localStorage.removeItem(key);
    };
    setActive();
    const heartbeat = setInterval(setActive, 2000);
    document.addEventListener("visibilitychange", setActive);
    window.addEventListener("pagehide", () => {
      clearInterval(heartbeat);
      localStorage.removeItem(key);
    }, { once: true });
  }

  const { data: memberships } = await backend.from("chat_conversation_members").select("conversation_id").eq("user_id", currentUser.id);
  dmMemberships = new Set((memberships || []).map(row => row.conversation_id).filter(Boolean));

  activeChannel = backend.channel("mention-notifications:" + currentUser.id)
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages" }, payload => {
      if (!canShowToast()) return;
      notifyNaMessage(payload.new);
    })
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "chat_dm_messages" }, payload => {
      if (!canShowToast()) return;
      notifyDMMessage(payload.new);
    })
    .subscribe((status, error) => {
      if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") console.warn("Mention notifications realtime:", status, error || "");
    });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") dismissToast();
  });
}
start().catch(error => console.warn("Mention notifications could not start:", error));
