const drive = "https://www.googleapis.com/drive/v3/files";
const sheets = "https://sheets.googleapis.com/v4/spreadsheets";
const mime = "application/vnd.google-apps.spreadsheet";
const prefix = "[Shopping List POC] ";
const properties = { app_type: "shopping_list", schema_version: "1" };
const fields = "id,name,mimeType,trashed,ownedByMe,shared,capabilities(canEdit,canShare),appProperties";
const schemas = {
  Items: ["item_id", "name", "quantity", "unit_id", "category_id", "completed", "notes",
    "created_at", "updated_at", "deleted"],
  Categories: ["category_id", "name", "is_builtin", "active"],
  Metadata: ["key", "value"],
};
const tabs = Object.keys(schemas);
const syntheticUnit = "piece";
const otherCategory = ["other", "אחר", true, true];
const fileId = value => typeof value === "string" && /^[a-zA-Z0-9_-]+$/.test(value);
const definitiveRejections = new Set([400, 401, 403, 404]);
const uuid = value => typeof value === "string" &&
  /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
const identity = value => value.toLowerCase();
function timestamp(value) {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value)) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 19) === value.slice(0, 19);
}
const text = value => typeof value === "string" && Boolean(value.trim());

export class SheetsError extends Error {
  constructor(code, status, writeOutcome) {
    super(code);
    this.code = code;
    this.status = status;
    this.writeOutcome = writeOutcome;
  }
}

function requireValid(condition, code = "schema") {
  if (!condition) throw new SheetsError(code);
}

export function googleRequest(session, isCurrent) {
  function checkSession(writeOutcome) {
    if (!isCurrent() || session.controller.signal.aborted) {
      throw new SheetsError("stale", undefined, writeOutcome);
    }
    if (Date.now() >= session.expiresAt) throw new SheetsError("expired", undefined, writeOutcome);
  }

  return async (url, method = "GET", body) => {
    const write = method !== "GET";
    const uncertain = write ? "uncertain" : undefined;
    checkSession(write ? "notSent" : undefined);
    const controller = new AbortController();
    const cancel = () => controller.abort();
    const timer = setTimeout(cancel, 15000);
    session.controller.signal.addEventListener("abort", cancel, { once: true });
    try {
      const headers = { Authorization: "Bearer " + session.token };
      if (body) headers["Content-Type"] = "application/json";
      const response = await fetch(url, {
        method, headers, body: body && JSON.stringify(body), signal: controller.signal,
        cache: "no-store", credentials: "omit", redirect: "error",
      });
      if (definitiveRejections.has(response.status)) {
        throw new SheetsError(response.status === 401 ? "expired" : "api", response.status,
          write ? "rejected" : undefined);
      }
      checkSession(uncertain);
      if (!response.ok) {
        const transient = response.status === 408 || response.status === 429 || response.status >= 500;
        throw new SheetsError(transient ? "network" : "api", response.status, uncertain);
      }
      if (method === "DELETE" && response.status === 204) return {};
      const data = await response.json();
      checkSession(uncertain);
      if (data === null || typeof data !== "object" || Array.isArray(data) || "error" in data) {
        throw new SheetsError("response", response.status, uncertain);
      }
      return data;
    } catch (error) {
      if (error instanceof SheetsError) throw error;
      checkSession(uncertain);
      throw new SheetsError(error instanceof SyntaxError ? "response" : "network", undefined, uncertain);
    } finally {
      clearTimeout(timer);
      session.controller.signal.removeEventListener("abort", cancel);
    }
  };
}

function query(path, params) {
  const search = new URLSearchParams(params);
  return path + "?" + search;
}

function fileInfo(file, state, ownerOnly = false) {
  const props = file?.appProperties;
  const owned = file?.ownedByMe === true;
  requireValid(fileId(file?.id) && typeof file.name === "string" && file.name.startsWith(prefix) &&
    file.mimeType === mime && file.trashed === false && typeof file.capabilities?.canEdit === "boolean" &&
    (owned || (!ownerOnly && file.ownedByMe === false && file.shared === true)), "unrelated");
  if (owned || (props && Object.keys(props).length)) {
    requireValid(props?.app_type === properties.app_type && uuid(props.list_id), "unrelated");
    requireValid(props.schema_version === properties.schema_version &&
      ["initializing", "ready"].includes(props.initialization_status), "schema");
    if (state) requireValid(props.initialization_status === state, "initializing");
  }
  return file;
}

function rowsFor(tab, values) {
  requireValid(Array.isArray(values) && values.every(Array.isArray));
  const [header, ...rows] = values;
  const expected = schemas[tab];
  requireValid(header?.length === expected.length && expected.every((value, index) => header[index] === value));
  return rows;
}

function uniqueRows(rows, validId, duplicateCode) {
  const ids = new Set();
  return rows.flatMap((row, index) => {
    if (!row.some(value => value !== "")) return [];
    requireValid(typeof row[0] === "string" && validId(row[0]));
    const id = identity(row[0]);
    requireValid(!ids.has(id), duplicateCode);
    ids.add(id);
    return [{ id, row, number: index + 2 }];
  });
}

export async function assertAccount(request, account) {
  const identity = await request("https://openidconnect.googleapis.com/v1/userinfo");
  requireValid(identity.sub === account.id && identity.email === account.email, "wrongAccount");
}

export function shoppingSheets(request, pending, account) {
  const driveFile = id => drive + "/" + encodeURIComponent(id);
  const spreadsheet = id => sheets + "/" + encodeURIComponent(id);

  async function listFiles(candidateOnly = true) {
    const files = new Map();
    const pages = new Set();
    let pageToken;
    do {
      const params = {
        q: "trashed = false and mimeType = '" + mime + "'" + (candidateOnly ?
          " and (appProperties has { key='app_type' and value='shopping_list' } or name contains '" + prefix + "')" : ""),
        fields: "nextPageToken,incompleteSearch,files(" + fields + ")",
        pageSize: "100",
      };
      if (pageToken) params.pageToken = pageToken;
      const page = await request(query(drive, params));
      requireValid(Array.isArray(page.files) && page.files.every(file => fileId(file?.id)) &&
        !page.incompleteSearch, "discovery");
      for (const file of page.files) files.set(file.id, file);
      pageToken = page.nextPageToken;
      requireValid(!pages.has(pageToken), "discovery");
      pages.add(pageToken);
    } while (pageToken);
    return [...files.values()];
  }

  function matchingFiles(files, listId) {
    return files.filter(file => uuid(file.appProperties?.list_id) &&
      identity(file.appProperties.list_id) === identity(listId));
  }

  async function getFile(id) {
    requireValid(fileId(id), "fileId");
    const file = await request(query(driveFile(id), { fields }));
    requireValid(file.id === id, "unrelated");
    return file;
  }

  async function structure(id) {
    const data = await request(query(spreadsheet(id), {
      fields: "spreadsheetId,sheets(properties(sheetId,title,sheetType))",
    }));
    requireValid(data.spreadsheetId === id && Array.isArray(data.sheets));
    const layouts = data.sheets.map(sheet => sheet?.properties);
    requireValid(layouts.every(layout => Number.isInteger(layout?.sheetId) && text(layout.title)));
    return layouts;
  }

  async function read(file) {
    const id = file.id;
    const layouts = await structure(id);
    requireValid(layouts.length === tabs.length &&
      tabs.every(tab => layouts.some(layout => layout.title === tab && layout.sheetType === "GRID")));
    const params = new URLSearchParams({ valueRenderOption: "UNFORMATTED_VALUE" });
    for (const tab of tabs) params.append("ranges", "'" + tab + "'");
    const { valueRanges } = await request(spreadsheet(id) + "/values:batchGet?" + params);
    requireValid(Array.isArray(valueRanges) && valueRanges.length === tabs.length);
    const metadata = rowsFor("Metadata", valueRanges[2]?.values);
    requireValid(metadata.length === 5 && metadata.every(row => row.length === 2));
    const meta = new Map(metadata);
    requireValid(meta.size === 5 &&
      meta.get("app_type") === properties.app_type && meta.get("schema_version") === properties.schema_version &&
      uuid(meta.get("list_id")) && (!file.appProperties?.list_id || meta.get("list_id") === file.appProperties.list_id) &&
      meta.get("list_type") === "shopping" &&
      timestamp(meta.get("created_at")));
    let categoryRows;
    let itemRows;
    try {
      const items = rowsFor("Items", valueRanges[0]?.values);
      const categories = rowsFor("Categories", valueRanges[1]?.values);
      categoryRows = uniqueRows(categories, id => id === otherCategory[0] || uuid(id), "schema");
      requireValid(categoryRows.every(({ id, row }) => row.length === 4 && text(row[1]) &&
        row[2] === (id === otherCategory[0]) && typeof row[3] === "boolean"));
      const byCategory = new Map(categoryRows.map(category => [category.id, category]));
      requireValid(byCategory.get(otherCategory[0])?.row[3] === true);
      itemRows = uniqueRows(items, uuid, "duplicateItem");
      for (const item of itemRows) {
        const { row } = item;
        requireValid(row.length === 10 && text(row[1]) && Number.isFinite(row[2]) && row[2] > 0 &&
          row[3] === syntheticUnit && typeof row[4] === "string" &&
          (row[4] === otherCategory[0] || uuid(row[4])) &&
          typeof row[5] === "boolean" && typeof row[6] === "string" &&
          timestamp(row[7]) && timestamp(row[8]) && typeof row[9] === "boolean");
        const category = byCategory.get(identity(row[4]));
        requireValid(category);
        item.needsCategoryRepair = !category.row[3];
        item.displayCategory = (category.row[3] ? category : byCategory.get(otherCategory[0])).row[1];
      }
    } catch (error) {
      error.listId = meta.get("list_id");
      throw error;
    }
    const validated = {
      ...file, appProperties: file.appProperties?.list_id ? file.appProperties : {
        list_id: meta.get("list_id"),
      },
    };
    return { file: validated, items: itemRows, categories: categoryRows, metadata: meta };
  }

  function writeValues(id, data) {
    return request(spreadsheet(id) + "/values:batchUpdate", "POST", { valueInputOption: "RAW", data });
  }

  function checkInitialSnapshot(snapshot, createdAt) {
    requireValid(snapshot.items.length === 0 && snapshot.categories.length === 1 &&
      otherCategory.every((value, index) => snapshot.categories[0].row[index] === value) &&
      (!createdAt || snapshot.metadata.get("created_at") === createdAt), "initializing");
  }

  async function initialize(file, operation) {
    const id = file.id;
    const layouts = await structure(id);
    requireValid(layouts.length === 1 && layouts[0].sheetType === "GRID");
    await request(spreadsheet(id) + ":batchUpdate", "POST", { requests: [
      { updateSheetProperties: {
        properties: { sheetId: layouts[0].sheetId, title: "Items" }, fields: "title",
      } },
      ...tabs.slice(1).map(title => ({ addSheet: { properties: { title } } })),
    ] });
    operation.createdAt = new Date().toISOString();
    const metadata = [
      ...Object.entries(properties), ["list_id", file.appProperties.list_id],
      ["list_type", "shopping"], ["created_at", operation.createdAt],
    ];
    await writeValues(id, [
      { range: "Items!A1:J1", values: [schemas.Items] },
      { range: "Categories!A1:D2", values: [schemas.Categories, otherCategory] },
      { range: "Metadata!A1:B6", values: [schemas.Metadata, ...metadata] },
    ]);
    checkInitialSnapshot(await read(file), operation.createdAt);
    await markReady(file);
  }

  async function markReady(file) {
    const appProperties = { ...file.appProperties, initialization_status: "ready" };
    const updated = await request(query(driveFile(file.id), { fields }), "PATCH", { appProperties });
    requireValid(fileInfo(updated, "ready", true).id === file.id &&
      updated.appProperties.list_id === appProperties.list_id);
    return updated;
  }

  async function inspectCandidates(files) {
    const candidates = [];
    const identities = new Map(files.map(file => [file.id, file]));
    for (const file of files) {
      if (typeof file.name !== "string" || !file.name.startsWith(prefix) ||
          (!file.ownedByMe && file.shared !== true)) continue;
      try {
        fileInfo(file);
        if (file.appProperties?.initialization_status === "initializing") {
          candidates.push({ file, issue: "initializing" });
          continue;
        }
        const snapshot = await read(file);
        if (!file.appProperties?.list_id) identities.set(file.id, snapshot.file);
        candidates.push({ file: snapshot.file, issue: "" });
      } catch (error) {
        const inaccessible = error.code === "api" && [403, 404].includes(error.status);
        if (!inaccessible && !["schema", "unrelated", "duplicateItem"].includes(error.code)) throw error;
        // A duplicate item must not hide a second spreadsheet's list identity.
        if (error.listId && !file.appProperties?.list_id) {
          identities.set(file.id, { ...file, appProperties: { list_id: error.listId } });
        }
        candidates.push({ file, issue: inaccessible ? "api" : error.code });
      }
    }
    const discovered = [...identities.values()];
    for (const candidate of candidates) {
      if (!candidate.issue && matchingFiles(discovered, candidate.file.appProperties.list_id).length > 1) {
        candidate.issue = "duplicateList";
      }
    }
    return { candidates, identities: discovered };
  }

  async function discover() {
    return (await inspectCandidates(await listFiles())).candidates;
  }

  async function load(id, expectedListId, requireListed = true) {
    const snapshot = await read(fileInfo(await getFile(id), "ready"));
    requireValid(!expectedListId || snapshot.metadata.get("list_id") === expectedListId, "unrelated");
    const files = await listFiles();
    const listed = files.find(file => file.id === id);
    const listId = snapshot.metadata.get("list_id");
    // Drive indexing may lag after Picker. Writes still require discovery to corroborate identity.
    requireValid(!requireListed || listed, "discovery");
    requireValid(!listed?.appProperties?.list_id || listed.appProperties.list_id === listId, "unrelated");
    const others = files.filter(file => file.id !== id);
    requireValid(matchingFiles(others, listId).length === 0, "duplicateList");
    const { identities } = await inspectCandidates(others.filter(file => !file.appProperties?.list_id));
    requireValid(matchingFiles(identities, listId).length === 0, "duplicateList");
    return snapshot;
  }

  async function writable(id, expectedListId) {
    const snapshot = await load(id, expectedListId);
    await assertAccount(request, account);
    const current = fileInfo(await getFile(id), "ready");
    requireValid(current.capabilities.canEdit, "readOnly");
    requireValid(current.appProperties?.list_id === undefined ||
      current.appProperties.list_id === snapshot.metadata.get("list_id"), "unrelated");
    return snapshot;
  }

  async function diagnose(id) {
    async function report(read) {
      try {
        return await read() ? "נמצא" : "לא נמצא";
      } catch (error) {
        if (["expired", "stale"].includes(error.code)) throw error;
        return Number.isInteger(error.status) ? "HTTP " + error.status : "נכשלה";
      }
    }
    requireValid(fileId(id), "fileId");
    const listed = await report(async () => (await listFiles(false)).some(file => file.id === id));
    const fetched = await report(async () => Boolean(await getFile(id)));
    return "Drive files.list · " + listed + " | Drive files.get · " + fetched;
  }

  async function selected(id) {
    const diagnostics = await diagnose(id);
    let sheetsStatus;
    try {
      await structure(id);
      sheetsStatus = "Sheets · נקרא";
    } catch (error) {
      if (["expired", "stale"].includes(error.code)) throw error;
      sheetsStatus = "Sheets · " + (Number.isInteger(error.status) ? "HTTP " + error.status : "נכשל");
      return { diagnostics: diagnostics + " | " + sheetsStatus, error };
    }
    const report = diagnostics + " | " + sheetsStatus;
    try {
      const snapshot = await load(id, undefined, false);
      return { diagnostics: report, snapshot };
    } catch (error) {
      if (["expired", "stale"].includes(error.code)) throw error;
      return { diagnostics: report, error };
    }
  }

  async function verify(operation) {
    if (operation.type === "create") {
      const matches = matchingFiles(await listFiles(), operation.listId);
      requireValid(matches.length < 2, "duplicateList");
      requireValid(matches.length === 1, "uncertain");
      const id = matches[0].id;
      requireValid(!operation.id || operation.id === id, "uncertain");
      const file = fileInfo(await getFile(id), undefined, true);
      requireValid(file.id === id && file.appProperties.list_id === operation.listId, "uncertain");
      operation.id = id;
      const initializing = file.appProperties.initialization_status === "initializing";
      const snapshot = await read(file).catch(error => {
        if (initializing && ["schema", "duplicateItem"].includes(error.code)) {
          throw new SheetsError("initializing");
        }
        throw error;
      });
      checkInitialSnapshot(snapshot, operation.createdAt);
      if (initializing) {
        requireValid(file.capabilities?.canEdit === true, "readOnly");
        await assertAccount(request, account);
        snapshot.file = await markReady(file);
      }
      return { snapshot };
    }
    const snapshot = await load(operation.id, operation.listId);
    const item = snapshot.items.find(item => item.id === identity(operation.itemId));
    requireValid(item && operation.expected.every(([column, value]) => item.row[column] === value), "uncertain");
    return { snapshot };
  }

  async function verifyAndClear(operation) {
    const result = await verify(operation);
    delete pending.operation;
    return result;
  }

  async function reconcile() {
    const operation = pending.operation;
    requireValid(operation && !operation.active, "pending");
    operation.active = true;
    try {
      return await verifyAndClear(operation);
    } finally {
      operation.active = false;
    }
  }

  async function mutate(operation, write) {
    requireValid(!pending.operation, "pending");
    pending.operation = operation;
    operation.active = true;
    try {
      try {
        await write();
      } catch (error) {
        // A later failure cannot undo a confirmed Drive create.
        if (!operation.createAccepted && ["notSent", "rejected"].includes(error.writeOutcome)) {
          delete pending.operation;
          throw error;
        }
        if (["expired", "stale"].includes(error.code)) throw error;
        throw new SheetsError("uncertain", error.status);
      }
      return await verifyAndClear(operation);
    } finally {
      operation.active = false;
    }
  }

  async function create() {
    const listId = crypto.randomUUID();
    const operation = { type: "create", listId };
    const appProperties = { ...properties, list_id: listId, initialization_status: "initializing" };
    await assertAccount(request, account);
    return mutate(operation, async () => {
      const file = await request(query(drive, { fields }), "POST", {
        name: prefix + listId, mimeType: mime, appProperties,
      });
      operation.createAccepted = true;
      fileInfo(file, "initializing", true);
      requireValid(file.appProperties.list_id === listId && file.capabilities?.canEdit === true);
      operation.id = file.id;
      const matches = matchingFiles(await listFiles(), listId);
      requireValid(matches.every(match => match.id === file.id), "duplicateList");
      await initialize(file, operation);
    });
  }

  async function append(id, expectedListId) {
    const { items, metadata } = await writable(id, expectedListId);
    requireValid(items.every((item, index) => item.number === index + 2));
    const itemId = crypto.randomUUID();
    requireValid(!items.some(item => item.id === itemId), "duplicateItem");
    const now = new Date().toISOString();
    const row = [itemId, "פריט דמה", 1, syntheticUnit, otherCategory[0], false, "=1+1", now, now, false];
    return mutate({ type: "append", id, listId: metadata.get("list_id"), itemId, expected: row.map((value, column) => [column, value]) },
      () => request(query(spreadsheet(id) + "/values/Items!A:J:append", {
        valueInputOption: "RAW", insertDataOption: "OVERWRITE",
      }), "POST", { values: [row] }));
  }

  async function update(id, itemId, field, value, expectedListId) {
    const columns = { quantity: 2, completed: 5, deleted: 9 };
    requireValid(Object.hasOwn(columns, field) && uuid(itemId) &&
      (field === "quantity" ? Number.isFinite(value) && value > 0 : value === true), "input");
    const { items, metadata } = await writable(id, expectedListId);
    const item = items.find(item => item.id === identity(itemId));
    requireValid(item && !item.row[9], "itemMissing");
    const { number } = item;
    const column = columns[field];
    const now = new Date().toISOString();
    return mutate({ type: "update", id, listId: metadata.get("list_id"), itemId, expected: [[column, value], [8, now]] },
      () => writeValues(id, [
        { range: "Items!" + "ABCDEFGHIJ"[column] + number, values: [[value]] },
        { range: "Items!I" + number, values: [[now]] },
      ]));
  }

  return { discover, load, create, append, update, reconcile, diagnose, selected, getFile };
}
