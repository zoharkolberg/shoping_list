const scopes = [
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/userinfo.email",
  "openid",
];
const gisTimeoutMs = 15000;
const oauthTimeoutMs = 120000;
const configKey = "shoping-list-poc.oauth-client-id";
const validClient = value => /^[0-9]+-[a-z0-9_-]+\.apps\.googleusercontent\.com$/i.test(value);
const ui = Object.fromEntries(Array.from(document.querySelectorAll("[id]"), element => [element.id, element]));

const messages = {
  connecting: "ממתין להרשאה ולזיהוי חשבון",
  connected: "מחובר ל־Google",
  disconnected: "מנותק",
  expired: "תוקף האסימון הסתיים או שהגישה נדחתה. אפשר להתחבר מחדש.",
  denied: "ההרשאה נדחתה בחלון של Google.",
  popupClosed: "חלון ההרשאה נסגר לפני השלמת החיבור.",
  popupFailed: "פתיחת חלון ההרשאה נכשלה.",
  oauthTimeout: "זמן ההמתנה להרשאה הסתיים. סגרו את חלון Google אם הוא פתוח ונסו להתחבר מחדש.",
  oauthFailed: "החיבור דרך Google נכשל.",
  missingScopes: "Google העניקה רק חלק מההרשאות הדרושות או שלא העניקה אותן כלל.",
  invalidToken: "Google החזירה תשובת אסימון לא תקינה.",
  identityFailed: "אימות החשבון מול Google נכשל.",
  network: "בקשת הרשת נכשלה או חרגה מזמן ההמתנה.",
  driveFailed: "בדיקת הקריאה מ־Google Drive נכשלה.",
  drivePassed: "בדיקת הקריאה מ־Google Drive הצליחה.",
};

let clientId = "";
try {
  const saved = localStorage.getItem(configKey) ?? "";
  if (validClient(saved)) clientId = saved;
} catch {
  // The form remains usable when storage is unavailable.
}
ui.client.value = clientId;

let library = "loading";
let configurationNote = "";
let session;
let status = "disconnected";
let expirationTimer;

function log(event) {
  const item = document.createElement("li");
  item.textContent = messages[event];
  ui.log.prepend(item);
  if (ui.log.children.length > 12) ui.log.lastElementChild.remove();
}

function render() {
  const configuration = configurationNote || (clientId ? "OAuth Client ID הוגדר." : "נדרש OAuth Client ID.");
  const libraryNote = {
    loading: " ספריית Google נטענת.",
    failed: " טעינת ספריית Google נכשלה.",
    timedOut: " זמן ההמתנה לטעינת ספריית Google הסתיים.",
    ready: "",
  };
  ui.configuration.textContent = configuration + libraryNote[library];
  ui.retryLibrary.hidden = library !== "failed" && library !== "timedOut";
  ui.status.textContent = messages[status];
  ui.email.textContent = session?.account?.email ?? "—";
  ui.scopes.textContent = session?.scopeStatus ?? "—";
  ui.expiration.textContent = status === "expired" ? "פג או נדחה"
    : session?.account ? "בתוקף עד " + new Date(session.expiresAt).toLocaleTimeString("he-IL") : "—";
  const ready = Boolean(clientId) && library === "ready";
  ui.connect.disabled = !ready || status !== "disconnected";
  ui.reconnect.disabled = !ready || status === "connecting" || status === "disconnected";
  ui.disconnect.textContent = status === "connecting" ? "ביטול ניסיון החיבור" : "התנתקות מקומית";
  ui.disconnect.disabled = status === "disconnected";
  ui.drive.disabled = status !== "connected" || session.testing;
}

function reset(nextStatus) {
  if (session) {
    clearTimeout(session.oauthTimer);
    session.token = undefined;
    session.account = undefined;
    session.controller.abort();
  }
  session = undefined;
  clearTimeout(expirationTimer);
  status = nextStatus;
  ui.driveStatus.textContent = "טרם נבדק";
}

function expire(attempt) {
  if (session !== attempt) return;
  reset("expired");
  log("expired");
  render();
}

function fail(attempt, event) {
  if (session !== attempt) return;
  clearTimeout(attempt.oauthTimer);
  attempt.controller.abort();
  attempt.token = undefined;
  clearTimeout(expirationTimer);
  status = event;
  log(event);
  render();
}

async function readGoogle(url, token, controller) {
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { Authorization: "Bearer " + token },
      signal: controller.signal,
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
    });
    if (!response.ok) return { status: response.status };
    try {
      return { status: response.status, data: await response.json() };
    } catch {
      return { status: response.status };
    }
  } finally {
    clearTimeout(timeout);
  }
}

function awaitingOAuth(attempt) {
  if (session !== attempt || status !== "connecting" || attempt.token) return false;
  if (Date.now() < attempt.oauthDeadline) return true;
  fail(attempt, "oauthTimeout");
  return false;
}

async function acceptToken(attempt, response) {
  if (!awaitingOAuth(attempt)) return;
  clearTimeout(attempt.oauthTimer);
  if (response.error) {
    fail(attempt, response.error === "access_denied" ? "denied" : "oauthFailed");
    return;
  }
  const granted = new Set(typeof response.scope === "string" ? response.scope.split(/\s+/) : []);
  if (granted.has("email")) granted.add(scopes[1]);
  if (!scopes.every(scope => granted.has(scope))) {
    attempt.scopeStatus = "חסרות הרשאות דרושות";
    fail(attempt, "missingScopes");
    return;
  }

  const lifetime = Number(response.expires_in) * 1000;
  if (typeof response.access_token !== "string" || !response.access_token ||
      !Number.isFinite(lifetime) || lifetime <= 0 || lifetime > 2147483647) {
    fail(attempt, "invalidToken");
    return;
  }
  attempt.scopeStatus = "כל שלוש ההרשאות הדרושות אומתו";
  attempt.token = response.access_token;
  attempt.expiresAt = Date.now() + lifetime;
  expirationTimer = setTimeout(() => expire(attempt), lifetime);

  try {
    const result = await readGoogle("https://openidconnect.googleapis.com/v1/userinfo", attempt.token, attempt.controller);
    if (session !== attempt || status !== "connecting") return;
    if (Date.now() >= attempt.expiresAt || result.status === 401) {
      expire(attempt);
      return;
    }
    const { sub, email } = result.data ?? {};
    if (typeof sub !== "string" || !sub.trim() || typeof email !== "string" || !email.trim()) {
      fail(attempt, "identityFailed");
      return;
    }
    attempt.account = { id: sub, email };
    status = "connected";
    log("connected");
    render();
  } catch {
    if (status === "connecting") fail(attempt, "network");
  }
}

function connect() {
  if (!clientId || library !== "ready" || status === "connecting") return;
  reset("connecting");
  const attempt = { controller: new AbortController() };
  session = attempt;
  attempt.oauthDeadline = Date.now() + oauthTimeoutMs;
  attempt.oauthTimer = setTimeout(() => fail(attempt, "oauthTimeout"), oauthTimeoutMs);
  log("connecting");
  render();
  try {
    const tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: scopes.join(" "),
      include_granted_scopes: false,
      callback: response => void acceptToken(attempt, response),
      error_callback: error => {
        if (!awaitingOAuth(attempt)) return;
        const popupErrors = {
          popup_closed: "popupClosed",
          popup_failed_to_open: "popupFailed",
        };
        const type = error.type;
        fail(attempt, Object.hasOwn(popupErrors, type) ? popupErrors[type] : "oauthFailed");
      },
    });
    tokenClient.requestAccessToken({ prompt: "select_account" });
  } catch {
    fail(attempt, "oauthFailed");
  }
}

async function testDrive() {
  const attempt = session;
  if (status !== "connected" || attempt.testing) return;
  if (Date.now() >= attempt.expiresAt) {
    expire(attempt);
    return;
  }
  attempt.testing = true;
  ui.driveStatus.textContent = "בודק חיבור…";
  render();

  const url = new URL("https://www.googleapis.com/drive/v3/files");
  url.search = new URLSearchParams({ pageSize: "1", fields: "files(id)", q: "trashed = false" });

  try {
    // Give this request its own timeout while still cancelling it when the session ends.
    const controller = new AbortController();
    const cancel = () => controller.abort();
    attempt.controller.signal.addEventListener("abort", cancel, { once: true });
    let result;
    try {
      result = await readGoogle(url, attempt.token, controller);
    } finally {
      attempt.controller.signal.removeEventListener("abort", cancel);
    }
    if (session !== attempt) return;
    if (Date.now() >= attempt.expiresAt || result.status === 401) {
      expire(attempt);
      return;
    }
    if (!Array.isArray(result.data?.files)) {
      ui.driveStatus.textContent = messages.driveFailed + " HTTP " + result.status;
      log("driveFailed");
      return;
    }
    ui.driveStatus.textContent = messages.drivePassed +
      (result.data.files.length === 0 ? " בדף התוצאות שהתקבל לא הופיעו קבצים." : "");
    log("drivePassed");
  } catch {
    if (session !== attempt) return;
    ui.driveStatus.textContent = messages.network;
    log("network");
  } finally {
    if (session === attempt) {
      attempt.testing = false;
      render();
    }
  }
}

ui.config.addEventListener("submit", event => {
  event.preventDefault();
  const value = ui.client.value.trim();
  if (value && !validClient(value)) {
    configurationNote = "מזהה OAuth Client ID אינו בתבנית הצפויה. ההגדרה הקודמת נשמרה.";
    render();
    return;
  }
  if (value !== clientId) reset("disconnected");
  clientId = value;
  ui.client.value = value;
  configurationNote = "";
  try {
    if (value) localStorage.setItem(configKey, value);
    else localStorage.removeItem(configKey);
  } catch {
    configurationNote = "האחסון המקומי אינו זמין. השינוי חל בדף הזה בלבד.";
  }
  render();
});
ui.connect.addEventListener("click", connect);
ui.reconnect.addEventListener("click", connect);
ui.disconnect.addEventListener("click", () => {
  reset("disconnected");
  log("disconnected");
  render();
});
ui.drive.addEventListener("click", testDrive);
document.addEventListener("visibilitychange", () => {
  if (document.hidden || !session) return;
  if (session.token && Date.now() >= session.expiresAt) expire(session);
  else if (status === "connecting" && !session.token) awaitingOAuth(session);
});

ui.retryLibrary.addEventListener("click", () => window.location.reload());

const gis = document.createElement("script");
const gisDeadline = Date.now() + gisTimeoutMs;
const gisTimer = setTimeout(() => finishLibraryLoad("timedOut"), gisTimeoutMs);

function finishLibraryLoad(result) {
  if (library !== "loading") return;
  clearTimeout(gisTimer);
  library = Date.now() >= gisDeadline ? "timedOut" : result;
  if (library !== "ready") gis.remove();
  render();
}

gis.src = "https://accounts.google.com/gsi/client";
gis.async = true;
gis.onload = () => finishLibraryLoad(
  typeof window.google?.accounts?.oauth2?.initTokenClient === "function" ? "ready" : "failed",
);
gis.onerror = () => finishLibraryLoad("failed");
document.head.append(gis);
render();
