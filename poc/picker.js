import { SheetsError } from "./sheets.js";

let library;

function loadPicker() {
  if (library) return library;
  library = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    const timeout = setTimeout(fail, 15000);
    function fail() {
      clearTimeout(timeout);
      script.remove();
      reject(new SheetsError("pickerLoad"));
    }
    script.src = "https://apis.google.com/js/api.js";
    script.onerror = fail;
    script.onload = () => {
      try {
        window.gapi.load("picker", {
          callback: () => {
            if (!window.google?.picker?.PickerBuilder) return fail();
            clearTimeout(timeout);
            resolve(window.google.picker);
          },
          onerror: fail,
        });
      } catch {
        fail();
      }
    };
    document.head.append(script);
  }).catch(error => {
    library = undefined;
    throw error;
  });
  return library;
}

export function pickerConfiguration(project, key) {
  if (!/^[0-9]{1,30}$/.test(project) || !/^AIza[a-zA-Z0-9_-]{35}$/.test(key)) {
    throw new SheetsError("pickerConfig");
  }
  return { project, key };
}

export function pickSpreadsheet(session, config) {
  const signal = session.controller.signal;
  return new Promise((resolve, reject) => {
    let dialog;
    let finished = false;
    const timeout = setTimeout(() => settle(new SheetsError("pickerFailure")), 120000);
    function settle(error, id) {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      signal.removeEventListener("abort", cancel);
      try {
        dialog?.setVisible(false);
        dialog?.dispose?.();
      } catch {
        // The dialog may already have been closed by Google.
      }
      if (error) reject(error);
      else resolve(id);
    }
    function cancel() {
      settle(new SheetsError("stale"));
    }
    function active() {
      if (finished) return false;
      if (signal.aborted) cancel();
      else if (Date.now() >= session.expiresAt) settle(new SheetsError("expired"));
      return !finished;
    }
    signal.addEventListener("abort", cancel, { once: true });
    if (!active()) return;

    void loadPicker().then(api => {
      if (!active()) return;
      const view = new api.DocsView(api.ViewId.SPREADSHEETS)
        .setMimeTypes("application/vnd.google-apps.spreadsheet")
        .setMode(api.DocsViewMode.LIST);
      dialog = new api.PickerBuilder().addView(view)
        .setOAuthToken(session.token)
        .setAppId(config.project)
        .setDeveloperKey(config.key)
        .setOrigin(window.location.origin)
        .setCallback(data => {
          if (!active()) return;
          if (data?.action === api.Action.CANCEL) settle();
          else if (data?.action === api.Action.PICKED) {
            const id = data.docs?.length === 1 && data.docs[0]?.id;
            if (typeof id !== "string" || !/^[a-zA-Z0-9_-]+$/.test(id)) {
              settle(new SheetsError("pickerFailure"));
            } else settle(undefined, id);
          } else if (data?.action !== api.Action.LOADED) {
            settle(new SheetsError("pickerFailure"));
          }
        }).build();
      if (finished) dialog.dispose?.();
      else dialog.setVisible(true);
    }).catch(error => settle(new SheetsError(error.code === "pickerLoad" ? "pickerLoad" : "pickerFailure")));
  });
}
