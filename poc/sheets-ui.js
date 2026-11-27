import { googleRequest, shoppingSheets } from "./sheets.js";
import { shoppingSharing } from "./sharing.js";
import { pickSpreadsheet, pickerConfiguration } from "./picker.js";

const messages = {
  api: "הבקשה ל־Google נדחתה.",
  network: "קריאת Google נכשלה או חרגה מזמן ההמתנה.",
  response: "התקבלה תשובה לא תקינה מ־Google.",
  schema: "מבנה הגיליון או הערכים אינם תואמים לסכמה.",
  unrelated: "הקובץ לא זוהה כקובץ דמה מתאים לחשבון.",
  initializing: "הקובץ עדיין במצב initializing. אם האתחול חלקי, עצרו כתיבה ותעדו את המזהים לפי מדריך הבדיקה.",
  duplicateList: "נמצאו קבצים עם אותו list_id. הכתיבה חסומה.",
  duplicateItem: "נמצאו שורות עם אותו item_id. הכתיבה חסומה.",
  readOnly: "לחשבון אין יכולת עריכה בקובץ.",
  input: "בחרו פריט והזינו כמות חיובית בעת עריכת כמות.",
  itemMissing: "הפריט חסר או מסומן כמחוק.",
  discovery: "לא ניתן לאמת את גילוי הקובץ ב־Drive. נסו לגלות שוב.",
  wrongAccount: "זהות החשבון אינה תואמת לחיבור הנוכחי. התחברו מחדש.",
  fileId: "הזינו מזהה גיליון בלבד.",
  pickerConfig: "הזינו מספר פרויקט ומפתח API מוגבל ל־Picker.",
  pickerLoad: "טעינת Google Picker נכשלה. אפשר לנסות לפתוח אותו שוב.",
  pickerFailure: "Google Picker לא החזיר בחירת גיליון תקינה.",
  sharingDenied: "ההרשאה השתנתה או שניהולה אינו זמין לחשבון הבעלים.",
  sharingInput: "הזינו כתובת יחידה של חשבון בדיקה אחר ובחרו צופה או עורך.",
  sharingExists: "כבר קיימת הרשאת משתמש. בדקו את ההרשאות לפני שינוי התפקיד.",
  sharingRestriction: "לא אומתה הגבלת השיתוף לבעלים ב־Drive. מתן גישת עורך חסום.",
  sharingUncertain: "תוצאת שינוי ההרשאה אינה ידועה. בדקו הרשאות לפני פעולה נוספת.",
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

  function clearPermissions(current) {
    if (current) current.permissions = undefined;
    ui.recipient.value = "";
    ui.permissionRole.value = "reader";
    ui.permissionSummary.replaceChildren();
    ui.permissionSelect.replaceChildren();
    option(ui.permissionSelect, "", "בחירת הרשאה");
    ui.sharingStatus.textContent = "";
  }

  function showPermissions(current, entries) {
    current.permissions = entries;
    for (const [index, entry] of entries.entries()) {
      const role = { owner: "בעלים", reader: "צופה", writer: "עורך" }[entry.role] ?? "תפקיד אחר";
      const type = { user: "משתמש", group: "קבוצה", domain: "דומיין", anyone: "גישה כללית" }[entry.type] ?? "סוג אחר";
      const label = [role, type, entry.email || "הרשאה " + (index + 1)].join(" · ");
      const line = document.createElement("li");
      line.textContent = label;
      line.dir = "auto";
      ui.permissionSummary.append(line);
      if (entry.controllable) option(ui.permissionSelect, entry.id, label);
    }
  }

  function showItems(current) {
    ui.sheetQuantity.value = "";
    ui.sheetItem.replaceChildren();
    ui.sheetRows.replaceChildren();
    option(ui.sheetItem, "", "בחירת פריט");
    for (const { id, row, displayCategory, needsCategoryRepair } of current?.snapshot?.items ?? []) {
      if (!row[9]) option(ui.sheetItem, id, row[1] + " · " + id);
      const line = document.createElement("li");
      line.textContent = [row[1], row[0], "כמות " + row[2], row[9] ? "נמחק לוגית"
        : row[5] ? "נרכש" : "פתוח", displayCategory + (needsCategoryRepair ? " (שיוך מחלקה דורש תיקון)" : ""), row[6]].join(" · ");
      ui.sheetRows.append(line);
    }
  }

  function render() {
    const enabled = Boolean(state && !state.busy);
    const chosen = state?.files.find(entry => entry.file.id === ui.sheetSelect.value);
    const file = chosen?.file;
    const loaded = Boolean(state?.snapshot && state.snapshot.file.id === file?.id);
    const pending = state?.pending.operation;
    const sharingPending = state?.pending.sharing;
    const writesBlocked = Boolean(pending || sharingPending);
    const writable = enabled && loaded && !writesBlocked && state.snapshot.file.capabilities?.canEdit === true;
    ui.sheetCreate.disabled = !enabled || writesBlocked;
    ui.sheetDiscover.disabled = !enabled;
    ui.sheetSelect.disabled = !enabled || !state.files.length;
    ui.sheetLoad.disabled = !enabled || !file || Boolean(chosen.issue);
    ui.sheetAppend.disabled = !writable;
    ui.picker.disabled = !enabled;
    ui.probe.disabled = !enabled;
    ui.probeId.disabled = !enabled;
    const manageable = enabled && loaded && state.snapshot.file.ownedByMe === true &&
      state.snapshot.file.capabilities.canShare === true;
    ui.inspectPermissions.disabled = !manageable;
    const restricted = loaded && state.snapshot.file.writersCanShare === false;
    ui.sharingRestriction.textContent = !loaded || !state.snapshot.file.ownedByMe ? ""
      : restricted ? "הגבלת השיתוף לבעלים אומתה ב־Drive." : messages.sharingRestriction;
    ui.restrictSharing.disabled = !manageable || writesBlocked || restricted;
    ui.reconcileSharing.disabled = !enabled || !sharingPending;
    ui.sharingPending.textContent = sharingPending
      ? "מזהה גיליון לבדיקה חוזרת " + sharingPending.id + " · פעולות כתיבה מושהות."
      : "";
    const inspected = manageable && !writesBlocked && Boolean(state.permissions);
    ui.share.disabled = !inspected;
    ui.recipient.disabled = !inspected;
    ui.permissionRole.disabled = !inspected;
    ui.permissionSelect.disabled = !inspected || ui.permissionSelect.options.length < 2;
    ui.changePermission.disabled = ui.permissionSelect.disabled || !ui.permissionSelect.value;
    ui.removePermission.disabled = ui.changePermission.disabled;
    ui.sheetItem.disabled = !enabled || !loaded;
    for (const button of [ui.sheetQuantitySave, ui.sheetComplete, ui.sheetDelete]) {
      button.disabled = !writable || !ui.sheetItem.value;
    }
    ui.sheetQuantity.disabled = ui.sheetQuantitySave.disabled;
    ui.sheetReconcile.disabled = !enabled || !pending;
    ui.sheetPending.textContent = pending
      ? "מזהה לבדיקה חוזרת " + (pending.itemId ?? pending.listId) +
        (pending.id ? " · מזהה גיליון " + pending.id : "") + " · פעולות כתיבה מושהות."
      : "";
    ui.sheetListId.textContent = file?.appProperties?.list_id ?? "—";
    ui.sheetId.textContent = file?.id ?? "—";
    ui.sheetInit.textContent = file?.appProperties?.initialization_status ?? "—";
    ui.sheetOpen.hidden = !file || Boolean(chosen.issue);
    if (ui.sheetOpen.hidden) ui.sheetOpen.removeAttribute("href");
    else ui.sheetOpen.href = "https://docs.google.com/spreadsheets/d/" + encodeURIComponent(file.id) + "/edit";
  }

  function selectFiles(current, files, id) {
    clearPermissions(current);
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

  async function run(action, output = ui.sheetStatus) {
    const current = state;
    if (!current || current.busy) return;
    current.busy = true;
    output.textContent = "פעולה מול Google מתבצעת…";
    render();
    try {
      const result = await action(current);
      if (state !== current) return;
      output.textContent = result;
    } catch (error) {
      if (state !== current) return;
      if (error.code === "expired") {
        expire(current.session);
        return;
      }
      if (output === ui.sheetStatus) {
        current.snapshot = undefined;
        clearPermissions(current);
        showItems(current);
      }
      output.textContent = errorMessage(error);
    } finally {
      if (state === current) {
        current.busy = false;
        render();
      }
    }
  }

  function errorMessage(error) {
    return (messages[error.code] ?? "פעולת הגיליון נכשלה.") +
      (Number.isInteger(error.status) ? " HTTP " + error.status : "");
  }

  async function load(current, id) {
    clearPermissions(current);
    const expected = current.files.find(entry => entry.file.id === id)?.file.appProperties?.list_id;
    const snapshot = await current.service.load(id, expected);
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
    clearPermissions(state);
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
      const listId = current.snapshot?.metadata.get("list_id");
      if (!listId) return "יש לטעון גיליון לפני הכתיבה.";
      clearPermissions(current);
      const { snapshot } = await action(current.service, id, listId);
      if (state !== current) return;
      current.snapshot = snapshot;
      showItems(current);
      return "הכתיבה אומתה בקריאה חוזרת.";
    });
  }

  ui.sheetAppend.addEventListener("click", () => void write((service, id, listId) => service.append(id, listId)));
  for (const [button, field] of [
    [ui.sheetQuantitySave, "quantity"], [ui.sheetComplete, "completed"], [ui.sheetDelete, "deleted"],
  ]) {
    button.addEventListener("click", () => void write((service, id, listId) => service.update(
      id, ui.sheetItem.value, field, field === "quantity" ? ui.sheetQuantity.valueAsNumber : true, listId,
    )));
  }

  ui.probe.addEventListener("click", () => void run(current =>
    current.service.diagnose(ui.probeId.value.trim()), ui.probeStatus));

  ui.picker.addEventListener("click", () => void run(async current => {
    const config = pickerConfiguration(ui.pickerProject.value.trim(), ui.pickerKey.value.trim());
    const id = await pickSpreadsheet(current.session, config);
    if (state !== current) return;
    if (!id) return "הבחירה בוטלה.";
    const { diagnostics, snapshot, error } = await current.service.selected(id);
    if (state !== current) return;
    if (error) {
      if (current.snapshot?.file.id === id) {
        selectFiles(current, current.files.filter(entry => entry.file.id !== id));
      }
      return diagnostics + " | אימות גיליון · " + errorMessage(error);
    }
    const files = current.files.filter(entry => entry.file.id !== id);
    selectFiles(current, [...files, { file: snapshot.file, issue: "" }], id);
    current.snapshot = snapshot;
    showItems(current);
    return diagnostics + " | אימות גיליון · עבר";
  }, ui.pickerStatus));

  async function inspect(current) {
    const id = current.snapshot?.file.id;
    const listId = current.snapshot?.metadata.get("list_id");
    clearPermissions(current);
    const { entries, writersCanShare } = await current.sharing.inspect(id, listId);
    if (state === current) {
      current.snapshot.file.writersCanShare = writersCanShare;
      showPermissions(current, entries);
    }
    return "הרשאות השיתוף נקראו.";
  }

  function changePermission(action) {
    return run(async current => {
      const id = current.snapshot?.file.id;
      const listId = current.snapshot?.metadata.get("list_id");
      const permissionId = ui.permissionSelect.value;
      const currentRole = current.permissions?.find(entry => entry.id === permissionId)?.role;
      const role = ui.permissionRole.value;
      const email = ui.recipient.value.trim();
      clearPermissions(current);
      await current.sharing.change(id, listId, action, { email, role, permissionId, currentRole });
      if (state !== current) return;
      if (action === "restrict") current.snapshot.file.writersCanShare = false;
      return "השינוי אומת בקריאה חוזרת מ־Google.";
    }, ui.sharingStatus);
  }

  ui.restrictSharing.addEventListener("click", () => void changePermission("restrict"));
  ui.reconcileSharing.addEventListener("click", () => void run(async current => {
    const operation = current.pending.sharing;
    clearPermissions(current);
    await current.sharing.reconcile();
    if (state !== current) return;
    if (operation.action === "restrict" && current.snapshot?.file.id === operation.id) {
      current.snapshot.file.writersCanShare = false;
    }
    return "שינוי השיתוף אומת בקריאה חוזרת.";
  }, ui.sharingStatus));
  ui.inspectPermissions.addEventListener("click", () => void run(inspect, ui.sharingStatus));
  ui.permissionSelect.addEventListener("change", render);
  ui.sharingForm.addEventListener("submit", event => {
    event.preventDefault();
    void changePermission("add");
  });
  ui.changePermission.addEventListener("click", () => void changePermission("role"));
  ui.removePermission.addEventListener("click", () => void changePermission("remove"));

  return (session, clientId) => {
    if (state?.session !== session) {
      state = undefined;
      if (session) {
        const pending = pendingFor(session, clientId);
        const request = googleRequest(session, () => currentSession() === session);
        const service = shoppingSheets(request, pending, session.account);
        state = { session, pending, service, sharing: shoppingSharing(request, service, session.account, pending), files: [] };
      }
      clearPermissions(state);
      ui.probeId.value = "";
      ui.probeStatus.textContent = "";
      ui.pickerStatus.textContent = "";
      ui.sheetSelect.replaceChildren();
      option(ui.sheetSelect, "", "בחירת גיליון");
      ui.sheetQuantity.value = "";
      showItems(state);
      ui.sheetStatus.textContent = !session ? "נדרש חיבור ל־Google."
        : state.pending.operation ? messages.uncertain : "אפשר ליצור גיליון או לגלות קובצי דמה.";
    }
    render();
  };
}
