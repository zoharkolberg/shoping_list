const drive = "https://www.googleapis.com/drive/v3/files";
const sheets = "https://sheets.googleapis.com/v4/spreadsheets";
const mime = "application/vnd.google-apps.spreadsheet";
const prefix = "[Shopping List POC] ";
const properties = { app_type: "shopping_list", schema_version: "1" };
const fields = "id,name,mimeType,trashed,ownedByMe,capabilities(canEdit),appProperties";
const schemas = {
  Items: ["item_id", "name", "quantity", "unit_id", "category_id", "completed", "notes",
    "created_at", "updated_at", "deleted"],
  Categories: ["category_id", "name", "is_builtin", "active"],
  Metadata: ["key", "value"],
};
const tabs = Object.keys(schemas);
const syntheticUnit = "piece";
const otherCategory = ["other", "אחר", true, true];
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

function fileInfo(file, state) {
  const props = file?.appProperties;
  requireValid(text(file?.id) && typeof file.name === "string" && file.name.startsWith(prefix) && file.mimeType === mime &&
    file.trashed === false && file.ownedByMe === true && props?.app_type === properties.app_type &&
    uuid(props.list_id), "unrelated");
  requireValid(props.schema_version === properties.schema_version &&
    ["initializing", "ready"].includes(props.initialization_status), "schema");
  if (state) requireValid(props.initialization_status === state, "initializing");
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

export function shoppingSheets(request, pending = {}) {
  const driveFile = id => drive + "/" + encodeURIComponent(id);
  const spreadsheet = id => sheets + "/" + encodeURIComponent(id);

  async function listFiles() {
    const files = new Map();
    const pages = new Set();
    let pageToken;
    do {
      const params = {
        q: "trashed = false and mimeType = '" + mime + "' and " +
          "appProperties has { key='app_type' and value='shopping_list' }",
        fields: "nextPageToken,incompleteSearch,files(" + fields + ")",
        pageSize: "100",
      };
      if (pageToken) params.pageToken = pageToken;
      const page = await request(query(drive, params));
      requireValid(Array.isArray(page.files) && !page.incompleteSearch, "discovery");
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

  async function checkedFile(id, state) {
    const file = fileInfo(await request(query(driveFile(id), { fields })), state);
    const matches = matchingFiles(await listFiles(), file.appProperties.list_id);
    requireValid(matches.every(match => match.id === id), "duplicateList");
    // Drive indexing may lag. Require discovery to corroborate identity before modifying a file.
    requireValid(matches.length === 1, "discovery");
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
    const [items, categories, metadata] = tabs.map((tab, index) => rowsFor(tab, valueRanges[index]?.values));
    requireValid(metadata.length === 5 && metadata.every(row => row.length === 2));
    const meta = new Map(metadata);
    requireValid(meta.size === 5 &&
      meta.get("app_type") === properties.app_type && meta.get("schema_version") === properties.schema_version &&
      meta.get("list_id") === file.appProperties.list_id && meta.get("list_type") === "shopping" &&
      timestamp(meta.get("created_at")));
    const categoryRows = uniqueRows(categories, id => id === otherCategory[0] || uuid(id), "schema");
    requireValid(categoryRows.every(({ id, row }) => row.length === 4 && text(row[1]) &&
      row[2] === (id === otherCategory[0]) && typeof row[3] === "boolean"));
    const byCategory = new Map(categoryRows.map(category => [category.id, category]));
    requireValid(byCategory.get(otherCategory[0])?.row[3] === true);
    const itemRows = uniqueRows(items, uuid, "duplicateItem");
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
    return { file, items: itemRows, categories: categoryRows, metadata: meta };
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
    requireValid(fileInfo(updated, "ready").id === file.id &&
      updated.appProperties.list_id === appProperties.list_id);
    return updated;
  }

  async function discover() {
    const files = await listFiles();
    const results = [];
    for (const file of files) {
      // Include collisions even if the other file is not an owned diagnostic file.
      const listId = file.appProperties?.list_id;
      if (typeof file.name !== "string" || !file.name.startsWith(prefix) || !file.ownedByMe) continue;
      try {
        fileInfo(file);
        requireValid(matchingFiles(files, listId).length === 1, "duplicateList");
        if (file.appProperties.initialization_status === "ready") await read(file);
        results.push({ file, issue: file.appProperties.initialization_status === "ready" ? "" : "initializing" });
      } catch (error) {
        const inaccessible = error.code === "api" && [403, 404].includes(error.status);
        if (!inaccessible && !["schema", "unrelated", "duplicateList", "duplicateItem"].includes(error.code)) {
          throw error;
        }
        results.push({ file, issue: inaccessible ? "api" : error.code });
      }
    }
    return results;
  }

  async function load(id) {
    return read(await checkedFile(id, "ready"));
  }

  async function writable(id) {
    const file = await checkedFile(id, "ready");
    requireValid(file.capabilities?.canEdit === true, "readOnly");
    return read(file);
  }

  async function verify(operation) {
    if (operation.type === "create") {
      const matches = matchingFiles(await listFiles(), operation.listId);
      requireValid(matches.length < 2, "duplicateList");
      requireValid(matches.length === 1, "uncertain");
      const id = matches[0].id;
      requireValid(!operation.id || operation.id === id, "uncertain");
      const file = fileInfo(await request(query(driveFile(id), { fields })));
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
        snapshot.file = await markReady(file);
      }
      return { snapshot };
    }
    const snapshot = await load(operation.id);
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
    return mutate(operation, async () => {
      const file = await request(query(drive, { fields }), "POST", {
        name: prefix + listId, mimeType: mime, appProperties,
      });
      operation.createAccepted = true;
      fileInfo(file, "initializing");
      requireValid(file.appProperties.list_id === listId && file.capabilities?.canEdit === true);
      operation.id = file.id;
      const matches = matchingFiles(await listFiles(), listId);
      requireValid(matches.every(match => match.id === file.id), "duplicateList");
      await initialize(file, operation);
    });
  }

  async function append(id) {
    const { items } = await writable(id);
    requireValid(items.every((item, index) => item.number === index + 2));
    const itemId = crypto.randomUUID();
    requireValid(!items.some(item => item.id === itemId), "duplicateItem");
    const now = new Date().toISOString();
    const row = [itemId, "פריט דמה", 1, syntheticUnit, otherCategory[0], false, "=1+1", now, now, false];
    return mutate({ type: "append", id, itemId, expected: row.map((value, column) => [column, value]) },
      () => request(query(spreadsheet(id) + "/values/Items!A:J:append", {
        valueInputOption: "RAW", insertDataOption: "OVERWRITE",
      }), "POST", { values: [row] }));
  }

  async function update(id, itemId, field, value) {
    const columns = { quantity: 2, completed: 5, deleted: 9 };
    requireValid(Object.hasOwn(columns, field) && uuid(itemId) &&
      (field === "quantity" ? Number.isFinite(value) && value > 0 : value === true), "input");
    const { items } = await writable(id);
    const item = items.find(item => item.id === identity(itemId));
    requireValid(item && !item.row[9], "itemMissing");
    const { number } = item;
    const column = columns[field];
    const now = new Date().toISOString();
    return mutate({ type: "update", id, itemId, expected: [[column, value], [8, now]] },
      () => writeValues(id, [
        { range: "Items!" + "ABCDEFGHIJ"[column] + number, values: [[value]] },
        { range: "Items!I" + number, values: [[now]] },
      ]));
  }

  return { discover, load, create, append, update, reconcile };
}
