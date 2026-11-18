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
const seenMessageIds = new Set();
let pollingStartedAt = Date.now() - 1500;
let pollingBusy = false;

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
function chatIsActiveElsewhere() { return isChatPage; }
function canShowToast() {
  return document.visibilityState === "visible" && !chatIsActiveElsewhere();
}
function ensureToast() {
  if (toast) return toast;
  const fontLink = document.createElement("link");
  fontLink.rel = "stylesheet";
  fontLink.href = "https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@500;600;700;800&display=swap";
  document.head.appendChild(fontLink);
  const style = document.createElement("style");
  style.textContent = [
    ".cg-mention-toast,.cg-mention-toast *{font-family:'Plus Jakarta Sans',system-ui,sans-serif!important}",
    ".cg-mention-toast{position:fixed;z-index:2147483647!important;isolation:isolate;top:max(14px,env(safe-area-inset-top));left:14px;width:min(370px,calc(100vw - 28px));padding:14px 16px;text-align:left;color:#f8fafc;background:rgba(23,26,39,.48);-webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px);border:1px solid rgba(203,213,225,.22);border-radius:13px;box-shadow:0 10px 28px rgba(0,0,0,.16);font:inherit;cursor:default;pointer-events:none;transform:translateX(calc(-100% - 24px));opacity:0;transition:transform .28s cubic-bezier(.2,.8,.2,1),opacity .22s ease;overflow:hidden}",
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
  (document.documentElement || document.body).appendChild(toast);
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
  el.dataset.target = targetUrl || "";
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
async function refreshDMMemberships() {
  const { data, error } = await backend.from("chat_conversation_members")
    .select("conversation_id").eq("user_id", currentUser.id);
  if (error) {
    console.warn("[CG notifications] Could not load DM memberships:", error.message);
    return;
  }
  dmMemberships = new Set((data || []).map(row => row.conversation_id).filter(Boolean));
}
function rememberMessage(message) {
  if (!message?.id || seenMessageIds.has(message.id)) return false;
  seenMessageIds.add(message.id);
  if (seenMessageIds.size > 1500) seenMessageIds.delete(seenMessageIds.values().next().value);
  return true;
}
function processNaMessage(message) {
  if (!rememberMessage(message)) return;
  notifyNaMessage(message);
}
async function processDMMessage(message) {
  if (!rememberMessage(message)) return;
  await notifyDMMessage(message);
}
async function pollForMentions() {
  if (pollingBusy || !currentUser?.id || document.visibilityState !== "visible") return;
  pollingBusy = true;
  try {
    const since = pollingStartedAt;
    const [naResult, dmResult] = await Promise.all([
      backend.from("messages")
        .select("id,text,username,userId,role,type,isWhisper,isSystemMessage,server_id,channel_id,timestamp")
        .eq("server_id", NA_SERVER_ID)
        .gt("timestamp", since)
        .order("timestamp", { ascending: true })
        .limit(100),
      dmMemberships.size
        ? backend.from("chat_dm_messages")
            .select("id,conversation_id,sender_id,content,created_at,deleted_at")
            .in("conversation_id", Array.from(dmMemberships))
            .gt("created_at", new Date(since).toISOString())
            .order("created_at", { ascending: true })
            .limit(100)
        : Promise.resolve({ data: [], error: null })
    ]);
    if (naResult.error) console.warn("[CG notifications] NA polling error:", naResult.error.message);
    else (naResult.data || []).forEach(processNaMessage);
    if (dmResult.error) console.warn("[CG notifications] DM polling error:", dmResult.error.message);
    else for (const message of (dmResult.data || [])) {
      if (!message.deleted_at) await processDMMessage(message);
    }
    pollingStartedAt = Date.now();
  } catch (error) {
    console.warn("[CG notifications] Polling failed:", error);
  } finally {
    pollingBusy = false;
  }
}
async function start() {
  const { data: authData, error: authError } = await backend.auth.getUser();
  currentUser = authData?.user || null;
  if (authError || !currentUser?.id) {
    console.warn("[CG notifications] No signed-in user on this game page.", authError?.message || "");
    return;
  }
  const { data: profile, error: profileError } = await backend.from("users").select("username").eq("id", currentUser.id).maybeSingle();
  currentUsername = profile?.username || currentUser.user_metadata?.username || currentUser.username || "";
  if (profileError) console.warn("[CG notifications] Profile lookup failed:", profileError.message);
  if (!currentUsername) {
    console.warn("[CG notifications] Could not determine the signed-in username.");
    return;
  }

  await refreshDMMemberships();
  pollingStartedAt = Date.now() - 1500;

  activeChannel = backend.channel("mention-notifications:" + currentUser.id)
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages" }, payload => {
      if (document.visibilityState === "visible") processNaMessage(payload.new);
    })
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "chat_dm_messages" }, payload => {
      if (document.visibilityState === "visible") processDMMessage(payload.new);
    })
    .subscribe((status, error) => {
      console.info("[CG notifications] Realtime status:", status, error?.message || "");
    });

  // Polling is a fallback for games/browsers where the Realtime WebSocket is blocked.
  pollForMentions();
  const pollTimer = setInterval(pollForMentions, 3500);
  const membershipTimer = setInterval(refreshDMMemberships, 30000);
  window.addEventListener("pagehide", () => {
    clearInterval(pollTimer);
    clearInterval(membershipTimer);
    if (activeChannel) backend.removeChannel(activeChannel);
  }, { once: true });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") dismissToast();
    else pollForMentions();
  });
  console.info("[CG notifications] Ready for @" + currentUsername + " on this game page.");
}
start().catch(error => console.warn("Mention notifications could not start:", error));
