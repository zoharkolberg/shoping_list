import { assertAccount, SheetsError } from "./sheets.js";

const roles = new Set(["reader", "writer"]);
const emailAddress = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i;

function requirePermission(condition, code = "sharingDenied") {
  if (!condition) throw new SheetsError(code);
}

export function shoppingSharing(request, service, account) {
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

  async function authorize(id, listId) {
    requirePermission(listId);
    const { file } = await service.load(id, listId);
    requirePermission(file.ownedByMe === true && file.capabilities.canShare === true);
    return permissions(id);
  }

  async function inspect(id, listId) {
    return (await authorize(id, listId)).map(permission => ({
      id: permission.id, role: permission.role, type: permission.type, email: permission.type === "user" ? permission.emailAddress : undefined,
      controllable: controllable(permission),
    }));
  }

  async function change(id, listId, action, { email, role, permissionId, currentRole } = {}) {
    requirePermission(action === "remove" || roles.has(role), "sharingInput");
    if (action === "add") {
      requirePermission(typeof email === "string" && email.length <= 254 && emailAddress.test(email) &&
        email.toLowerCase() !== account.email.toLowerCase(), "sharingInput");
    }
    requirePermission(["add", "role", "remove"].includes(action), "sharingInput");
    const entries = await authorize(id, listId);
    if (action === "add") {
      requirePermission(!entries.some(entry => !entry.deleted && entry.type === "user" &&
        entry.emailAddress?.toLowerCase() === email.toLowerCase()), "sharingExists");
    } else {
      const permission = entries.find(entry => entry.id === permissionId);
      requirePermission(permission && controllable(permission) && permission.role === currentRole);
    }
    await assertAccount(request, account);
    const current = await service.getFile(id);
    requirePermission(current.ownedByMe === true && current.trashed === false &&
      current.capabilities?.canShare === true && current.appProperties?.list_id === listId &&
      current.appProperties.initialization_status === "ready");
    const fields = "id,type,role";
    try {
      if (action === "add") {
        await request(endpoint(id, { fields, sendNotificationEmail: "false" }), "POST",
          { type: "user", role, emailAddress: email });
      } else if (action === "role") {
        await request(endpoint(id, { fields }, permissionId), "PATCH", { role });
      } else {
        await request(endpoint(id, {}, permissionId), "DELETE");
      }
    } catch (error) {
      if (error.writeOutcome === "uncertain" && !["expired", "stale"].includes(error.code)) {
        throw new SheetsError("sharingUncertain", error.status);
      }
      throw error;
    }
  }

  return { inspect, change };
}
