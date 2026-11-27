const assert = require('node:assert/strict');
const { test } = require('node:test');
const { chromium, expect } = require('playwright/test');

const url = 'http://127.0.0.1:8765/shoping_list/poc/';
const drive = 'https://www.googleapis.com/drive/v3/files';
const sheets = 'https://sheets.googleapis.com/v4/spreadsheets';
const mime = 'application/vnd.google-apps.spreadsheet';
const title = '[Shopping List POC] ';
const listId = 'd152930a-b483-42d8-b6aa-5504e3461990';
const itemId = 'c06c4b63-57cb-451a-858c-b7cb426d2fe0';
const now = '2026-11-27T00:00:00.000Z';
const headers = {
  Items: ['item_id', 'name', 'quantity', 'unit_id', 'category_id', 'completed', 'notes', 'created_at', 'updated_at', 'deleted'],
  Categories: ['category_id', 'name', 'is_builtin', 'active'],
  Metadata: ['key', 'value'],
};
const scope = 'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/userinfo.email openid';
let browser;
test.before(async () => { browser = await chromium.launch({ executablePath: process.env.POC_CHROMIUM }); });
test.after(async () => browser?.close());

function fixture(id = 'file-1') {
  return {
    file: {
      id, name: title + id, mimeType: mime, ownedByMe: true, trashed: false,
      capabilities: { canEdit: true },
      appProperties: { app_type: 'shopping_list', schema_version: '1', list_id: listId, initialization_status: 'ready' },
    },
    tabs: ['Items', 'Categories', 'Metadata'],
    values: {
      Items: [headers.Items.slice()],
      Categories: [headers.Categories.slice(), ['other', 'אחר', true, true]],
      Metadata: [headers.Metadata.slice(), ['app_type', 'shopping_list'], ['schema_version', '1'],
        ['list_id', listId], ['list_type', 'shopping'], ['created_at', now]],
    },
  };
}

function item(name = 'דמה', id = itemId) {
  return [id, name, 1, 'piece', 'other', false, '', now, now, false];
}

async function setup(t, data = []) {
  const page = await browser.newPage({ viewport: { width: 390, height: 820 } });
  t.after(() => page.close());
  const files = new Map(data.map(entry => [entry.file.id, entry]));
  const calls = [];
  const hooks = {};
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));
  await page.route('https://accounts.google.com/gsi/client', route => route.fulfill({
    contentType: 'text/javascript',
    body: 'window.google = {accounts:{oauth2:{initTokenClient(config) { window.oauth = config; return {requestAccessToken() {}}; }}}};',
  }));
  await page.route('https://openidconnect.googleapis.com/v1/userinfo', route => {
    const account = route.request().headers().authorization.split(' ')[1];
    return route.fulfill({ json: { sub: account, email: account + '@example.test' } });
  });

  async function handle(route) {
    const request = route.request();
    const endpoint = new URL(request.url());
    const method = request.method();
    const body = request.postDataJSON();
    const token = request.headers().authorization;
    const call = { endpoint, method, body, token };
    calls.push(call);
    const reply = (json, status = 200) => route.fulfill({ json, status });
    if (await hooks.before?.(call, route, reply)) return;
    const send = async json => {
      if (!await hooks.after?.(call, route)) await reply(json);
    };
    if (endpoint.href.startsWith(drive)) {
      const id = endpoint.pathname.split('/')[4];
      const entry = files.get(id);
      if (method === 'POST') {
        const id = 'created-' + files.size;
        const file = { ...body, id, ownedByMe: true, trashed: false, capabilities: { canEdit: true } };
        files.set(id, { file, tabs: ['ברירת מחדל'], values: {} });
        return send(file);
      }
      if (id && !entry) return reply({}, 404);
      if (method === 'PATCH') {
        Object.assign(entry.file, body);
        return send(entry.file);
      }
      if (id) return send(entry.file);
      const all = [...files.values()].map(entry => entry.file);
      const offset = Number(endpoint.searchParams.get('pageToken') ?? 0);
      return send({ files: all.slice(offset, offset + 1),
        nextPageToken: offset + 1 < all.length ? String(offset + 1) : undefined });
    }

    const [, , , resource, operation] = endpoint.pathname.split('/');
    const [id, action] = resource.split(':');
    const entry = files.get(id);
    if (!entry) return reply({}, 404);
    if (action === 'batchUpdate') {
      entry.tabs = body.requests.map(change => (change.addSheet ?? change.updateSheetProperties).properties.title);
      return send({});
    }
    if (operation === 'values:batchGet') {
      return send({ valueRanges: endpoint.searchParams.getAll('ranges').map(name => ({ values: entry.values[name.replace(/^'|'$/g, '')] })) });
    }
    if (operation === 'values:batchUpdate') {
      for (const { range, values } of body.data) {
        const [name, position] = range.split('!');
        const match = /^([A-J])(\d+)/.exec(position);
        const index = Number(match[2]) - 1;
        const column = match[1].charCodeAt(0) - 65;
        entry.values[name] ??= [];
        values.forEach((row, offset) => {
          entry.values[name][index + offset] ??= [];
          entry.values[name][index + offset].splice(column, row.length, ...row);
        });
      }
      return send({});
    }
    if (endpoint.pathname.endsWith(':append')) {
      entry.values.Items.push(...body.values);
      return send({});
    }
    return send({ spreadsheetId: id,
      sheets: entry.tabs.map((title, index) => ({ properties: { title, sheetType: 'GRID', sheetId: index + 51 } })) });
  }
  await page.route(drive + '**', handle);
  await page.route(sheets + '**', handle);
  await page.goto(url);
  await page.locator('#client').fill('0-synthetic.apps.googleusercontent.com');
  await page.locator('#config button').click();

  async function connect(account = 'A', button = 'connect') {
    await page.locator('#' + button).click();
    await page.evaluate(([access_token, scope]) => window.oauth.callback({ access_token, scope, expires_in: 3600 }),
      [account, scope]);
    await expect(page.locator('#email')).toHaveText(account + '@example.test');
  }
  await connect();
  const click = id => page.locator('#' + id).click();
  const status = value => expect(page.locator('#sheetStatus')).toContainText(value);
  async function discover(count = files.size) {
    await click('sheetDiscover');
    await status('התגלו ' + count);
  }
  async function load(id = 'file-1') {
    await discover();
    await page.locator('#sheetSelect').selectOption(id);
    await click('sheetLoad');
    await status('נקרא ואומת');
  }
  const writes = () => calls.filter(call => call.method !== 'GET');
  return { page, files, calls, hooks, click, status, discover, load, writes, connect };
}

test('Drive creation, exact initialization, verification before ready and rediscovery after reload', async t => {
  const api = await setup(t);
  const { page, calls, click, status, writes } = api;
  await click('sheetCreate');
  await status('הכתיבה אומתה');
  const [create, layout, values, ready] = writes();
  const props = create.body.appProperties;
  assert.match(props.list_id, /^[a-f0-9-]{36}$/);
  assert.deepEqual(create.body, {
    name: title + props.list_id, mimeType: mime,
    appProperties: { app_type: 'shopping_list', schema_version: '1', list_id: props.list_id, initialization_status: 'initializing' },
  });
  assert.equal(layout.body.requests[0].updateSheetProperties.properties.sheetId, 51);
  assert.deepEqual(values.body.data.map(entry => entry.values[0]), Object.values(headers));
  assert.deepEqual(values.body.data[1].values[1], ['other', 'אחר', true, true]);
  assert.equal(values.body.valueInputOption, 'RAW');
  assert.equal(calls[calls.indexOf(ready) - 1].endpoint.searchParams.get('valueRenderOption'), 'UNFORMATTED_VALUE');
  assert.equal(ready.body.appProperties.initialization_status, 'ready');
  await expect(page.locator('#sheetOpen')).toHaveAttribute('href', 'https://docs.google.com/spreadsheets/d/created-0/edit');
  await expect(page.locator('#sheetListId')).toHaveText(props.list_id);
  await page.reload();
  await api.connect();
  await api.load('created-0');
  await expect(page.locator('#sheetInit')).toHaveText('ready');
});

test('Initialization with incompatible readback stays initializing and never sets ready', async t => {
  const { files, hooks, click, status, writes } = await setup(t);
  hooks.before = ({ endpoint }) => {
    if (!endpoint.pathname.endsWith('/values:batchGet')) return;
    files.get('created-0').values.Metadata[1][1] = 'other_app';
  };
  await click('sheetCreate');
  await status('טרם אומתה');
  assert.equal(files.get('created-0').file.appProperties.initialization_status, 'initializing');
  assert.equal(writes().filter(call => call.method === 'PATCH').length, 0);
});

test('Append and targeted quantity, completion and logical deletion persist with RAW', async t => {
  const { page, files, click, status, load, writes } = await setup(t, [fixture()]);
  await load();
  await click('sheetAppend');
  await status('הכתיבה אומתה');
  const entry = files.get('file-1');
  const id = entry.values.Items[1][0];
  assert.match(id, /^[a-f0-9-]{36}$/);
  assert.equal(writes()[0].endpoint.searchParams.get('valueInputOption'), 'RAW');
  for (const [button, column, value] of [
    ['sheetQuantitySave', 'C', 2.5], ['sheetComplete', 'F', true], ['sheetDelete', 'J', true],
  ]) {
    await page.locator('#sheetItem').selectOption(id);
    if (column === 'C') await page.locator('#sheetQuantity').fill('2.5');
    await click(button);
    await status('הכתיבה אומתה');
    const { body } = writes().at(-1);
    assert.equal(body.valueInputOption, 'RAW');
    assert.deepEqual(body.data.map(change => change.range), ['Items!' + column + '2', 'Items!I2']);
    assert.equal(body.data[0].values[0][0], value);
  }
  await click('sheetLoad');
  await status('נקרא ואומת');
  assert.deepEqual(entry.values.Items[1].slice(0, 7), [id, 'פריט דמה', 2.5, 'piece', 'other', true, '']);
  assert.equal(entry.values.Items[1][9], true);
  await expect(page.locator('#sheetRows')).toContainText('נמחק לוגית');
});

test('Pagination finds a duplicate list before any mutation, including a copy created after load', async t => {
  const { page, calls, files, click, status, load, writes, discover } = await setup(t, [fixture()]);
  await load();
  files.set('file-2', fixture('file-2'));
  await click('sheetAppend');
  await status('אותו list_id');
  await discover(2);
  for (const id of ['file-1', 'file-2']) {
    await page.locator('#sheetSelect').selectOption(id);
    await status('אותו list_id');
    await expect(page.locator('#sheetLoad')).toBeDisabled();
  }
  assert(calls.some(call => call.endpoint.searchParams.get('pageToken') === '1'));
  assert(calls.some(call => call.endpoint.searchParams.get('q')?.includes("key='app_type'")));
  assert.equal(writes().length, 0);
});

test('Duplicate item IDs, invalid schema and unrelated files cannot be written', async t => {
  const first = fixture();
  const { page, click, status, load, writes, discover } = await setup(t, [first]);
  first.values.Items.push(item());
  await load();
  first.values.Items.push(item('עותק', itemId.toUpperCase()));
  await page.locator('#sheetItem').selectOption(itemId);
  await click('sheetComplete');
  await status('אותו item_id');
  first.values.Items.pop();
  await load();
  first.values.Items[0].push('extra');
  await click('sheetAppend');
  await status('אינם תואמים');
  first.values.Items[0].pop();
  await load();
  first.file.appProperties.schema_version = '2';
  await click('sheetAppend');
  await status('אינם תואמים');
  first.file.appProperties.schema_version = '1';
  await load();
  first.file.ownedByMe = false;
  await click('sheetAppend');
  await status('לא זוהה');
  await discover(0);
  assert.equal(writes().length, 0);
});

test('Unknown create is reconciled by list UUID without sending create again', async t => {
  const { page, files, hooks, click, status, writes } = await setup(t);
  hooks.after = async ({ endpoint, method }, route) => {
    if (method !== 'POST' || !endpoint.href.startsWith(drive)) return;
    await route.abort();
    return true;
  };
  await click('sheetCreate');
  await status('טרם אומתה');
  const entry = files.get('created-0');
  const id = entry.file.appProperties.list_id;
  await expect(page.locator('#sheetPending')).toContainText(id);
  await expect(page.locator('#sheetCreate')).toBeDisabled();
  await click('sheetReconcile');
  await status('initializing');
  const initialized = fixture('created-0');
  initialized.values.Metadata[3][1] = id;
  Object.assign(entry, { tabs: initialized.tabs, values: initialized.values });
  await click('sheetReconcile');
  await status('הכתיבה אומתה');
  assert.deepEqual(writes().map(call => call.method), ['POST', 'PATCH']);
});

test('Unknown append reconciles by item UUID, with a pending read when Google has no matching row', async t => {
  const { page, hooks, files, click, status, load, writes } = await setup(t, [fixture()]);
  await load();
  hooks.after = async ({ endpoint }, route) => {
    if (!endpoint.pathname.endsWith(':append')) return;
    const row = files.get('file-1').values.Items.pop();
    hooks.delayedRow = row;
    await route.abort();
    return true;
  };
  await click('sheetAppend');
  await status('טרם אומתה');
  await expect(page.locator('#sheetPending')).toContainText(hooks.delayedRow[0]);
  await click('sheetReconcile');
  await status('טרם אומתה');
  files.get('file-1').values.Items.push(hooks.delayedRow);
  await click('sheetReconcile');
  await status('הכתיבה אומתה');
  assert.equal(writes().length, 1);
});

test('Explicit API failures, session expiry and a pending write isolated from a different account', async t => {
  const { page, hooks, click, status, load, writes, connect } = await setup(t, [fixture()]);
  await load();
  hooks.before = async ({ endpoint }, route, reply) => {
    if (!endpoint.pathname.endsWith(':append')) return;
    await reply({ error: { message: 'private-google-body' } }, 403);
    return true;
  };
  await click('sheetAppend');
  await status('HTTP 403');
  assert.equal(await page.locator('body').textContent().then(body => body.includes('private-google-body')), false);
  await click('sheetLoad');
  await status('נקרא ואומת');
  let release;
  let received;
  const started = new Promise(resolve => { received = resolve; });
  const delayed = new Promise(resolve => { release = resolve; });
  hooks.before = async ({ endpoint }, route, reply) => {
    if (!endpoint.pathname.endsWith(':append')) return;
    received();
    await delayed;
    await reply({}, 503).catch(() => {});
    return true;
  };
  await click('sheetAppend');
  await started;
  await expect(page.locator('#sheetAppend')).toBeDisabled();
  await page.locator('#sheetAppend').evaluate(node => node.click());
  await connect('B', 'reconnect');
  release();
  await expect(page.locator('#sheetPending')).toBeEmpty();
  await expect(page.locator('#sheetRows')).toBeEmpty();
  await expect(page.locator('#sheetCreate')).toBeEnabled();
  assert.deepEqual(writes().map(call => call.token), ['Bearer A', 'Bearer A']);
  await connect('A', 'reconnect');
  await expect(page.locator('#sheetReconcile')).toBeEnabled();
  hooks.before = async (call, route, reply) => { await reply({}, 401); return true; };
  await click('sheetReconcile');
  await expect(page.locator('#status')).toContainText('תוקף');
  await expect(page.locator('#sheetCreate')).toBeDisabled();
});

test('Spreadsheet text is rendered literally in the list and item selector', async t => {
  const entry = fixture();
  const payload = '<img src=x onerror="window.injected=true">';
  const row = item(payload);
  const formula = '=1+1';
  row[6] = formula;
  entry.values.Items.push(row);
  const { page, load } = await setup(t, [entry]);
  await load();
  await expect(page.locator('#sheetRows')).toContainText(payload);
  await expect(page.locator('#sheetRows')).toContainText(formula);
  await expect(page.locator('#sheetItem option').last()).toContainText(payload);
  assert.equal(await page.locator('#sheetRows img').count(), 0);
  assert.equal(await page.evaluate(() => window.injected), undefined);
});
