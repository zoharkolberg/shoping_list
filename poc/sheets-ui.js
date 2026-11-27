import { googleRequest, shoppingSheets } from "./sheets.js";

const messages = {
  api: "הבקשה ל־Google נדחתה.",
  network: "קריאת Google נכשלה או חרגה מזמן ההמתנה.",
  schema: "מבנה הגיליון או הערכים אינם תואמים לסכמה.",
  unrelated: "הקובץ לא זוהה כקובץ דמה בבעלות החשבון.",
  initializing: "הקובץ עדיין במצב initializing.",
  duplicateList: "נמצאו קבצים עם אותו list_id. הכתיבה חסומה.",
  duplicateItem: "נמצאו שורות עם אותו item_id. הכתיבה חסומה.",
  readOnly: "לחשבון אין יכולת עריכה בקובץ.",
  input: "בחרו פריט והזינו כמות חיובית בעת עריכת כמות.",
  itemMissing: "הפריט חסר או מסומן כמחוק.",
  discovery: "לא ניתן לאמת את גילוי הקובץ ב־Drive. נסו לגלות שוב.",
  pending: "קיימת פעולה שתוצאתה טרם אומתה.",
  uncertain: "תוצאת הכתיבה טרם אומתה. אפשר לבדוק שוב לפי המזהה.",
};

export function attachSheetsUI(ui, currentSession, expire) {
  const pendingByClient = new Map();
  let state;

  function pendingFor(session, clientId) {
    if (!pendingByClient.has(clientId)) pendingByClient.set(clientId, new Map());
    const accounts = pendingByClient.get(clientId);
    if (!accounts.has(session.account.id)) accounts.set(session.account.id, {});
    return accounts.get(session.account.id);
  }

  function option(select, value, label) {
    const node = document.createElement("option");
    node.value = value;
    node.textContent = label;
    select.append(node);
  }

  function showItems(current) {
    ui.sheetQuantity.value = "";
    ui.sheetItem.replaceChildren();
    ui.sheetRows.replaceChildren();
    option(ui.sheetItem, "", "בחירת פריט");
    for (const { id, row } of current?.snapshot?.items ?? []) {
      if (!row[9]) option(ui.sheetItem, id, row[1] + " · " + id);
      const line = document.createElement("li");
      line.textContent = [row[1], row[0], "כמות " + row[2], row[9] ? "נמחק לוגית"
        : row[5] ? "נרכש" : "פתוח", row[6]].join(" · ");
      ui.sheetRows.append(line);
    }
  }

  function render() {
    const enabled = Boolean(state && !state.busy);
    const chosen = state?.files.find(entry => entry.file.id === ui.sheetSelect.value);
    const file = chosen?.file;
    const loaded = Boolean(state?.snapshot && state.snapshot.file.id === file?.id);
    const pending = state?.pending.operation;
    const writable = enabled && loaded && !pending && state.snapshot.file.capabilities?.canEdit === true;
    ui.sheetCreate.disabled = !enabled || Boolean(pending);
    ui.sheetDiscover.disabled = !enabled;
    ui.sheetSelect.disabled = !enabled || !state.files.length;
    ui.sheetLoad.disabled = !enabled || !file || Boolean(chosen.issue);
    ui.sheetAppend.disabled = !writable;
    ui.sheetItem.disabled = !enabled || !loaded;
    for (const button of [ui.sheetQuantitySave, ui.sheetComplete, ui.sheetDelete]) {
      button.disabled = !writable || !ui.sheetItem.value;
    }
    ui.sheetQuantity.disabled = ui.sheetQuantitySave.disabled;
    ui.sheetReconcile.disabled = !enabled || !pending;
    ui.sheetPending.textContent = pending ? "מזהה לבדיקה חוזרת " + (pending.listId ?? pending.itemId) : "";
    ui.sheetListId.textContent = file?.appProperties?.list_id ?? "—";
    ui.sheetId.textContent = file?.id ?? "—";
    ui.sheetInit.textContent = file?.appProperties?.initialization_status ?? "—";
    ui.sheetOpen.hidden = !file || Boolean(chosen.issue);
    if (ui.sheetOpen.hidden) ui.sheetOpen.removeAttribute("href");
    else ui.sheetOpen.href = "https://docs.google.com/spreadsheets/d/" + encodeURIComponent(file.id) + "/edit";
  }

  function selectFiles(current, files, id) {
    current.files = files;
    current.snapshot = undefined;
    ui.sheetSelect.replaceChildren();
    option(ui.sheetSelect, "", "בחירת גיליון");
    for (const { file, issue } of files) {
      option(ui.sheetSelect, file.id, issue ? file.name + " · " + messages[issue] : file.name);
    }
    ui.sheetSelect.value = id ?? "";
    showItems(current);
  }

  async function run(action) {
    const current = state;
    if (!current || current.busy) return;
    current.busy = true;
    ui.sheetStatus.textContent = "פעולה מול Google מתבצעת…";
    render();
    try {
      const result = await action(current);
      if (state !== current) return;
      ui.sheetStatus.textContent = result;
    } catch (error) {
      if (state !== current) return;
      if (error.code === "expired") {
        expire(current.session);
        return;
      }
      current.snapshot = undefined;
      showItems(current);
      ui.sheetStatus.textContent = (messages[error.code] ?? "פעולת הגיליון נכשלה.") +
        (Number.isInteger(error.status) ? " HTTP " + error.status : "");
    } finally {
      if (state === current) {
        current.busy = false;
        render();
      }
    }
  }

  async function load(current, id) {
    const snapshot = await current.service.load(id);
    if (state !== current) return;
    current.snapshot = snapshot;
    showItems(current);
  }

  async function createOrReconcile(current, action) {
    const result = await action();
    if (state !== current) return;
    const { snapshot } = result;
    const files = current.files.filter(entry => entry.file.id !== snapshot.file.id);
    selectFiles(current, [...files, { file: snapshot.file, issue: "" }], snapshot.file.id);
    current.snapshot = snapshot;
    showItems(current);
    return "הכתיבה אומתה בקריאה חוזרת.";
  }

  ui.sheetCreate.addEventListener("click", () => void run(current =>
    createOrReconcile(current, current.service.create)));
  ui.sheetReconcile.addEventListener("click", () => void run(current =>
    createOrReconcile(current, current.service.reconcile)));
  ui.sheetDiscover.addEventListener("click", () => void run(async current => {
    const files = await current.service.discover();
    if (state === current) selectFiles(current, files, ui.sheetSelect.value);
    return "התגלו " + files.length + " קובצי דמה.";
  }));
  ui.sheetSelect.addEventListener("change", () => {
    if (!state || state.busy) return;
    state.snapshot = undefined;
    showItems(state);
    const issue = state.files.find(entry => entry.file.id === ui.sheetSelect.value)?.issue;
    ui.sheetStatus.textContent = issue ? messages[issue] : "אפשר לטעון את הגיליון שנבחר.";
    render();
  });
  ui.sheetLoad.addEventListener("click", () => void run(async current => {
    await load(current, ui.sheetSelect.value);
    return "הגיליון נקרא ואומת.";
  }));
  ui.sheetItem.addEventListener("change", () => {
    const item = state?.snapshot?.items.find(item => item.id === ui.sheetItem.value);
    ui.sheetQuantity.value = item?.row[2] ?? "";
    render();
  });

  function write(action) {
    return run(async current => {
      const id = ui.sheetSelect.value;
      const { snapshot } = await action(current.service, id);
      if (state !== current) return;
      current.snapshot = snapshot;
      showItems(current);
      return "הכתיבה אומתה בקריאה חוזרת.";
    });
  }

  ui.sheetAppend.addEventListener("click", () => void write((service, id) => service.append(id)));
  for (const [button, field] of [
    [ui.sheetQuantitySave, "quantity"], [ui.sheetComplete, "completed"], [ui.sheetDelete, "deleted"],
  ]) {
    button.addEventListener("click", () => void write((service, id) => service.update(
      id, ui.sheetItem.value, field, field === "quantity" ? ui.sheetQuantity.valueAsNumber : true,
    )));
  }

  return (session, clientId) => {
    if (state?.session !== session) {
      state = undefined;
      if (session) {
        const pending = pendingFor(session, clientId);
        const request = googleRequest(session, () => currentSession() === session);
        state = { session, pending, service: shoppingSheets(request, pending), files: [] };
      }
      ui.sheetSelect.replaceChildren();
      option(ui.sheetSelect, "", "בחירת גיליון");
      ui.sheetQuantity.value = "";
      showItems(state);
      ui.sheetStatus.textContent = session ? "אפשר ליצור גיליון או לגלות קובצי דמה." : "נדרש חיבור ל־Google.";
    }
    render();
  };
}
