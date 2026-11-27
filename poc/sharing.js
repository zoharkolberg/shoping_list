import { assertAccount, SheetsError } from "./sheets.js";

const roles = new Set(["reader", "writer"]);
const emailAddress = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i;

function requirePermission(condition, code = "sharingDenied") {
  if (!condition) throw new SheetsError(code);
}

export function shoppingSharing(request, service, account, pending) {
  function endpoint(id, params, permissionId) {
    const path = "https://www.googleapis.com/drive/v3/files/" + encodeURIComponent(id) + "/permissions";
    const search = new URLSearchParams(params).toString();
    return path + (permissionId ? "/" + encodeURIComponent(permissionId) : "") + (search ? "?" + search : "");
  }

  async function permissions(id) {
    const entries = [];
    const pages = new Set();
    let pageToken;
    do {
      const params = { fields: "nextPageToken,permissions(id,type,role,emailAddress,deleted,pendingOwner)", pageSize: "100" };
      if (pageToken) params.pageToken = pageToken;
      const page = await request(endpoint(id, params));
      requirePermission(Array.isArray(page.permissions), "response");
      entries.push(...page.permissions);
      pageToken = page.nextPageToken;
      requirePermission(!pages.has(pageToken), "response");
      pages.add(pageToken);
    } while (pageToken);
    requirePermission(entries.every(entry => typeof entry?.id === "string" && entry.id &&
      typeof entry.type === "string" && typeof entry.role === "string") &&
      new Set(entries.map(entry => entry.id)).size === entries.length, "response");
    return entries;
  }

  function controllable(permission) {
    return permission.type === "user" && roles.has(permission.role) && !permission.deleted && !permission.pendingOwner;
  }

  async function ownerFile(id, listId) {
    requirePermission(listId);
    const { file } = await service.load(id, listId);
    requirePermission(file.ownedByMe === true && file.capabilities.canShare === true);
    return file;
  }

  async function inspect(id, listId) {
    const file = await ownerFile(id, listId);
    const entries = (await permissions(id)).map(permission => ({
      id: permission.id, role: permission.role, type: permission.type,
      email: permission.type === "user" ? permission.emailAddress : undefined,
      controllable: controllable(permission),
    }));
    return { entries, writersCanShare: file.writersCanShare };
  }

  async function verify(operation) {
    const { id, listId, action, permissionId, role, email } = operation;
    const file = await ownerFile(id, listId);
    if (action === "restrict") {
      requirePermission(file.writersCanShare === false, "sharingRestriction");
    } else {
      const entries = await permissions(id);
      const entry = action === "add"
        ? entries.find(entry => !entry.deleted && entry.type === "user" &&
            entry.emailAddress?.toLowerCase() === email.toLowerCase())
        : entries.find(entry => entry.id === permissionId && !entry.deleted);
      requirePermission(action === "remove" ? !entry : entry && controllable(entry) && entry.role === role,
        "sharingUncertain");
    }
    delete pending.sharing;
  }

  async function reconcile() {
    const operation = pending.sharing;
    requirePermission(operation && !operation.active && !pending.operation, "pending");
    operation.active = true;
    try {
      await assertAccount(request, account);
      await verify(operation);
    } finally {
      operation.active = false;
    }
  }

  async function change(id, listId, action, { email, role, permissionId, currentRole } = {}) {
    requirePermission(!pending.operation && !pending.sharing, "pending");
    requirePermission(["add", "role", "remove", "restrict"].includes(action) &&
      (!["add", "role"].includes(action) || roles.has(role)), "sharingInput");
    if (action === "add") {
      requirePermission(typeof email === "string" && email.length <= 254 && emailAddress.test(email) &&
        email.toLowerCase() !== account.email.toLowerCase(), "sharingInput");
    }
    await ownerFile(id, listId);
    if (action !== "restrict") {
      const entries = await permissions(id);
      if (action === "add") {
        requirePermission(!entries.some(entry => !entry.deleted && entry.type === "user" &&
          entry.emailAddress?.toLowerCase() === email.toLowerCase()), "sharingExists");
      } else {
        const permission = entries.find(entry => entry.id === permissionId);
        requirePermission(permission && controllable(permission) && permission.role === currentRole);
      }
    }
    await assertAccount(request, account);
    const current = await service.getFile(id);
    requirePermission(current.ownedByMe === true && current.trashed === false &&
      current.capabilities?.canShare === true && current.appProperties?.list_id === listId &&
      current.appProperties.initialization_status === "ready");
    if (role === "writer" && ["add", "role"].includes(action)) {
      requirePermission(current.writersCanShare === false, "sharingRestriction");
    }
    if (action === "restrict" && current.writersCanShare === false) return;

    requirePermission(!pending.operation && !pending.sharing, "pending");
    const operation = { id, listId, action, role, permissionId, email: action === "add" ? email : undefined, active: true };
    pending.sharing = operation;
    try {
      try {
        const fields = "id,type,role";
        if (action === "add") {
          await request(endpoint(id, { fields, sendNotificationEmail: "false" }), "POST",
            { type: "user", role, emailAddress: email });
        } else if (action === "role") {
          await request(endpoint(id, { fields }, permissionId), "PATCH", { role });
        } else if (action === "remove") {
          await request(endpoint(id, {}, permissionId), "DELETE");
        } else {
          const url = "https://www.googleapis.com/drive/v3/files/" + encodeURIComponent(id);
          await request(url + "?fields=id,writersCanShare", "PATCH", { writersCanShare: false });
        }
      } catch (error) {
        if (["notSent", "rejected"].includes(error.writeOutcome)) {
          delete pending.sharing;
          if (action === "restrict" && error.code === "api") {
            throw new SheetsError("sharingRestriction", error.status);
          }
          throw error;
        }
        if (["expired", "stale"].includes(error.code)) throw error;
        throw new SheetsError("sharingUncertain", error.status);
      }
      await verify(operation);
    } finally {
      operation.active = false;
    }
  }

  return { inspect, change, reconcile };
}
