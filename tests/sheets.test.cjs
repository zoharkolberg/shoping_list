const assert = require('node:assert/strict');
const { test } = require('node:test');
const { chromium, expect } = require('playwright/test');

const url = 'http://127.0.0.1:8765/shoping_list/poc/';
const drive = 'https://www.googleapis.com/drive/v3/files';
const sheets = 'https://sheets.googleapis.com/v4/spreadsheets';
const mime = 'application/vnd.google-apps.spreadsheet';
const title = '[Shopping List POC] ';
const listId = 'd152930a-b483-42d8-b6aa-5504e3461990';
const categoryId = '848265ca-d52b-4829-9f42-854cbe783f55';
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
      capabilities: { canEdit: true, canShare: true },
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

async function setup(t, data = [], { clock = false } = {}) {
  const page = await browser.newPage({ viewport: { width: 390, height: 820 } });
  t.after(() => page.close());
  if (clock) await page.clock.install();
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
    return route.fulfill({ json: hooks.identity?.(account) ?? { sub: account, email: account + '@example.test' } });
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
      const mode = endpoint.searchParams.get('valueInputOption');
      entry.values.Items.push(...body.values.map(row => row.map(value =>
        mode === 'USER_ENTERED' && value === '=1+1' ? 2 : value)));
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
  assert.deepEqual(entry.values.Items[1].slice(0, 7), [id, 'פריט דמה', 2.5, 'piece', 'other', true, '=1+1']);
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

for (const outcome of [408, 429, 503, 'malformed JSON', 'invalid JSON shape']) {
  test('Ambiguous append preserves its UUID across reconciliation after ' + outcome, async t => {
    const { page, files, hooks, click, status, load, writes } = await setup(t, [fixture()]);
    let delayedRow;
    hooks.after = async ({ endpoint }, route) => {
      if (!endpoint.pathname.endsWith(':append')) return;
      delayedRow = files.get('file-1').values.Items.pop();
      if (typeof outcome === 'number') await route.fulfill({ status: outcome, json: {} });
      else if (outcome === 'invalid JSON shape') await route.fulfill({ json: [] });
      else await route.fulfill({ contentType: 'application/json', body: '{' });
      return true;
    };
    await load();
    await click('sheetAppend');
    await status('טרם אומתה');
    await expect(page.locator('#sheetPending')).toContainText(delayedRow[0]);
    await expect(page.locator('#sheetCreate')).toBeDisabled();
    await click('sheetReconcile');
    await status('טרם אומתה');
    files.get('file-1').values.Items.push(delayedRow);
    await click('sheetReconcile');
    await status('הכתיבה אומתה');
    await expect(page.locator('#sheetPending')).toBeEmpty();
    assert.equal(writes().length, 1);
  });
}

test('Definitive create rejection clears pending and sends no reconciliation writes', async t => {
  const { page, files, hooks, click, status, writes } = await setup(t);
  hooks.before = async ({ endpoint, method }, route, reply) => {
    if (!endpoint.href.startsWith(drive) || method !== 'POST') return;
    await reply({ error: { message: 'invalid request' } }, 400);
    return true;
  };
  await click('sheetCreate');
  await status('HTTP 400');
  await expect(page.locator('#sheetPending')).toBeEmpty();
  await expect(page.locator('#sheetReconcile')).toBeDisabled();
  await expect(page.locator('#sheetCreate')).toBeEnabled();
  assert.equal(files.size, 0);
  assert.equal(writes().length, 1);
});

test('A 401 on the append itself expires the session and clears the rejected operation', async t => {
  const { page, hooks, click, load, writes, connect } = await setup(t, [fixture()]);
  await load();
  hooks.before = async ({ endpoint }, route, reply) => {
    if (!endpoint.pathname.endsWith(':append')) return;
    await reply({}, 401);
    return true;
  };
  await click('sheetAppend');
  await expect(page.locator('#status')).toContainText('תוקף');
  await connect('A', 'reconnect');
  await expect(page.locator('#sheetPending')).toBeEmpty();
  await expect(page.locator('#sheetReconcile')).toBeDisabled();
  assert.equal(writes().length, 1);
});

test('Local expiry during append retains the dispatched operation for the renewed session', async t => {
  const { page, hooks, click, status, load, writes, connect } = await setup(t, [fixture()], { clock: true });
  await load();
  let signalStarted;
  let release;
  const started = new Promise(resolve => { signalStarted = resolve; });
  const delayed = new Promise(resolve => { release = resolve; });
  hooks.after = async ({ endpoint }, route) => {
    if (!endpoint.pathname.endsWith(':append')) return;
    signalStarted();
    await delayed;
    await route.abort().catch(() => {});
    return true;
  };
  await click('sheetAppend');
  await started;
  await page.clock.fastForward(3600001);
  await expect(page.locator('#status')).toContainText('תוקף');
  release();
  await connect('A', 'reconnect');
  await expect(page.locator('#sheetPending')).toContainText(writes()[0].body.values[0][0]);
  await click('sheetReconcile');
  await status('הכתיבה אומתה');
  assert.equal(writes().length, 1);
});

test('Rejection after Drive create keeps the partial file and original identity blocked', async t => {
  const { page, files, hooks, click, status, writes, connect, discover } = await setup(t);
  hooks.before = async ({ endpoint }, route, reply) => {
    if (!endpoint.pathname.endsWith('/values:batchUpdate')) return;
    await reply({}, 403);
    return true;
  };
  await click('sheetCreate');
  await status('טרם אומתה');
  const entry = files.get('created-0');
  const id = entry.file.appProperties.list_id;
  await expect(page.locator('#sheetPending')).toContainText(id);
  await click('sheetReconcile');
  await status('עצרו כתיבה');
  await discover();
  await page.locator('#sheetSelect').selectOption('created-0');
  await expect(page.locator('#sheetInit')).toHaveText('initializing');
  await expect(page.locator('#sheetLoad')).toBeDisabled();
  await page.locator('#client').fill('0-other.apps.googleusercontent.com');
  await page.locator('#config button').click();
  await connect();
  await expect(page.locator('#sheetPending')).toBeEmpty();
  await page.locator('#client').fill('0-synthetic.apps.googleusercontent.com');
  await page.locator('#config button').click();
  await connect();
  await expect(page.locator('#sheetPending')).toContainText(id);
  await expect(page.locator('#sheetCreate')).toBeDisabled();
  const initialized = fixture('created-0');
  initialized.values.Metadata[3][1] = id;
  initialized.values.Metadata[5][1] = writes()[2].body.data[2].values[5][1];
  initialized.values.Categories[1][1] = 'שם שונה';
  entry.values = initialized.values;
  await click('sheetReconcile');
  await status('עצרו כתיבה');
  assert.deepEqual(writes().map(call => call.method), ['POST', 'POST', 'POST']);
});

test('Invalid units, category references and schema invariants block append after load', async t => {
  const entry = fixture();
  const { click, status, load, writes } = await setup(t, [entry]);
  const invalid = [
    () => { entry.values.Items[1][3] = 'arbitrary-unit'; },
    () => { entry.values.Items[1][4] = categoryId; },
    () => { entry.values.Categories[1][3] = false; },
    () => { entry.values.Categories[1][2] = false; },
    () => { entry.values.Categories.push(['unknown_builtin', 'דמה', true, true]); },
    () => { entry.values.Categories.push([categoryId, 'דמה', true, true]); },
    () => { entry.values.Categories.push([categoryId, 'דמה', false, true],
      [categoryId.toUpperCase(), 'כפילות', false, false]); },
    () => { entry.values.Items[1][2] = '1'; },
    () => { entry.values.Metadata[5][1] = '2026-02-30T10:00:00Z'; },
  ];
  for (const corrupt of invalid) {
    entry.values = fixture().values;
    entry.values.Items.push(item());
    await load();
    corrupt();
    await click('sheetAppend');
    await status('אינם תואמים');
  }
  assert.equal(writes().length, 0);
});

test('Inactive custom category falls back to other with a repair cue and preserves its cell', async t => {
  const entry = fixture();
  entry.values.Categories.push([categoryId, 'מחלקה לא פעילה', false, false]);
  const row = item();
  row[4] = categoryId;
  entry.values.Items.push(row);
  const { page, click, status, load } = await setup(t, [entry]);
  await load();
  await expect(page.locator('#sheetRows')).toContainText('אחר (שיוך מחלקה דורש תיקון)');
  await page.locator('#sheetItem').selectOption(itemId);
  await click('sheetComplete');
  await status('הכתיבה אומתה');
  assert.equal(row[4], categoryId);
});

test('Synthetic formula-like note is sent RAW and verified by UNFORMATTED_VALUE', async t => {
  const { page, calls, files, hooks, click, status, load, writes } = await setup(t, [fixture()]);
  await load();
  hooks.before = ({ endpoint }) => {
    if (endpoint.pathname.endsWith('/values:batchGet') && writes().length) {
      files.get('file-1').values.Items[1][6] = 2;
    }
  };
  await click('sheetAppend');
  await status('אינם תואמים');
  const [append] = writes();
  const row = append.body.values[0];
  assert.equal(append.endpoint.searchParams.get('valueInputOption'), 'RAW');
  assert.equal(row[6], '=1+1');
  assert.equal(calls.at(-1).endpoint.searchParams.get('valueRenderOption'), 'UNFORMATTED_VALUE');
  await expect(page.locator('#sheetPending')).toContainText(row[0]);
  hooks.before = undefined;
  files.get('file-1').values.Items[1][6] = '=2+2';
  await click('sheetReconcile');
  await status('טרם אומתה');
  await expect(page.locator('#sheetPending')).toContainText(row[0]);
  files.get('file-1').values.Items[1][6] = row[6];
  await click('sheetReconcile');
  await status('הכתיבה אומתה');
  await expect(page.locator('#sheetRows')).toContainText('=1+1');
  await expect(page.locator('#sheetPending')).toBeEmpty();
  assert.equal(writes().length, 1);
});

function pickerScript() {
  window.gapi = { load(name, options) {
    if (name !== 'picker') throw Error('unexpected library');
    options.callback();
  } };
  window.google.picker = {
    ViewId: { SPREADSHEETS: 'sheets' },
    DocsViewMode: { LIST: 'list' },
    Action: { CANCEL: 'cancel', PICKED: 'picked', LOADED: 'loaded' },
    DocsView: class {
      constructor(view) { window.pickerOptions = { view }; }
      setMimeTypes(value) { window.pickerOptions.mime = value; return this; }
      setMode(value) { window.pickerOptions.mode = value; return this; }
    },
    PickerBuilder: class {
      addView() { return this; }
      setOAuthToken(value) { window.pickerOptions.token = value; return this; }
      setAppId(value) { window.pickerOptions.appId = value; return this; }
      setDeveloperKey(value) { window.pickerOptions.key = value; return this; }
      setOrigin(value) { window.pickerOptions.origin = value; return this; }
      setCallback(value) { window.pickerCallback = value; return this; }
      build() { return { setVisible(value) { window.pickerVisible = value; } }; }
    },
  };
}

const publicKey = 'AIza' + 'x'.repeat(35);

async function configurePicker(page) {
  await page.locator('summary').filter({ hasText: 'Google Picker' }).click();
  await page.locator('#pickerProject').fill('12345');
  await page.locator('#pickerKey').fill(publicKey);
}

async function openPicker(api) {
  await api.click('picker');
  await api.page.waitForFunction(() => window.pickerVisible === true);
}

function pickerAction(page, action, id) {
  return page.evaluate(({ action, id }) => window.pickerCallback({ action, docs: [{ id }] }), { action, id });
}

test('Picker is lazy, uses current-account config and authorizes same-file access and paginated B rediscovery', async t => {
  const shared = fixture('shared-2');
  shared.file.ownedByMe = false;
  shared.file.shared = true;
  shared.file.capabilities.canEdit = false;
  delete shared.file.appProperties;
  const filler = fixture();
  filler.file.appProperties.list_id = categoryId;
  filler.values.Metadata[3][1] = categoryId;
  const api = await setup(t, [filler, shared]);
  const { page, hooks, calls, writes, click, connect } = api;
  let pickerLoads = 0;
  let authorized = false;
  await page.route('https://apis.google.com/js/api.js', route => {
    pickerLoads++;
    return route.fulfill({ contentType: 'text/javascript', body: '(' + pickerScript.toString() + ')()' });
  });
  hooks.before = async ({ endpoint, token }, route, reply) => {
    assert.equal(token, 'Bearer B');
    if (authorized) return;
    if (endpoint.pathname === '/drive/v3/files') await reply({ files: [filler.file] });
    else await reply({ error: { message: 'private upstream body' } }, 404);
    return true;
  };
  await connect('B', 'reconnect');
  await configurePicker(page);
  await page.locator('#probeId').fill('shared-2');
  await click('probe');
  await expect(page.locator('#probeStatus')).toHaveText('Drive files.list · לא נמצא | Drive files.get · HTTP 404');
  assert.equal(pickerLoads, 0);
  await openPicker(api);
  assert.deepEqual(await page.evaluate(() => window.pickerOptions), {
    view: 'sheets', mime, mode: 'list', token: 'B', appId: '12345', origin: new URL(url).origin, key: publicKey,
  });
  authorized = true;
  await pickerAction(page, 'picked', 'shared-2');
  await expect(page.locator('#pickerStatus')).toContainText('Drive files.list · נמצא | Drive files.get · נמצא | Sheets · נקרא | אימות גיליון · עבר');
  await expect(page.locator('#sheetId')).toHaveText('shared-2');
  await expect(page.locator('#sheetListId')).toHaveText(listId);
  await expect(page.locator('#sheetAppend')).toBeDisabled();
  await page.locator('#sheetAppend').evaluate(node => node.dispatchEvent(new Event('click')));
  await api.status('אין יכולת עריכה');
  assert.equal(writes().length, 0);
  await page.reload();
  await connect('B');
  await api.load('shared-2');
  await expect(page.locator('#sheetListId')).toHaveText(listId);
  assert(calls.some(call => call.endpoint.searchParams.get('pageToken') === '1'));
  assert.equal(pickerLoads, 1);
  assert.equal(writes().length, 0);
});

test('Picker loading failure can be retried, cancellation and late account callbacks do not access files', async t => {
  const api = await setup(t, [fixture()]);
  const { page, calls, click, connect } = api;
  let failed = false;
  await page.route('https://apis.google.com/js/api.js', route => {
    if (!failed) {
      failed = true;
      return route.abort();
    }
    return route.fulfill({ contentType: 'text/javascript', body: '(' + pickerScript.toString() + ')()' });
  });
  await configurePicker(page);
  await click('picker');
  await expect(page.locator('#pickerStatus')).toContainText('טעינת Google Picker נכשלה');
  await openPicker(api);
  await pickerAction(page, 'cancel');
  await expect(page.locator('#pickerStatus')).toHaveText('הבחירה בוטלה.');
  await openPicker(api);
  await connect('B', 'reconnect');
  await pickerAction(page, 'picked', 'file-1');
  await expect(page.locator('#pickerStatus')).toBeEmpty();
  await expect(page.locator('#sheetId')).toHaveText('—');
  assert.equal(await page.evaluate(() => window.pickerVisible), false);
  assert.equal(calls.length, 0);
});

test('Picker expiry ignores late selections and a fresh session rejects unrelated or initializing files', async t => {
  const unrelated = fixture();
  unrelated.file.mimeType = 'application/pdf';
  const initializing = fixture('file-2');
  initializing.file.appProperties.initialization_status = 'initializing';
  const api = await setup(t, [unrelated, initializing], { clock: true });
  const { page, calls, writes, connect } = api;
  await page.route('https://apis.google.com/js/api.js', route =>
    route.fulfill({ contentType: 'text/javascript', body: '(' + pickerScript.toString() + ')()' }));
  await configurePicker(page);
  await openPicker(api);
  await page.clock.fastForward(3600001);
  await pickerAction(page, 'picked', 'file-1');
  await expect(page.locator('#status')).toContainText('תוקף');
  assert.equal(calls.length, 0);
  await connect('A', 'reconnect');
  for (const [id, expected] of [['file-1', 'לא זוהה'], ['file-2', 'initializing']]) {
    await openPicker(api);
    await pickerAction(page, 'picked', id);
    await expect(page.locator('#pickerStatus')).toContainText(expected);
    await expect(page.locator('#sheetId')).toHaveText('—');
  }
  assert.equal(writes().length, 0);
});

test('Shared writer can change a synthetic item but cannot share, and a downgrade blocks a loaded write', async t => {
  const entry = fixture();
  entry.file.ownedByMe = false;
  entry.file.shared = true;
  entry.values.Items.push(item());
  const api = await setup(t, [entry]);
  const { page, load, click, status, writes, hooks } = api;
  await load();
  await expect(page.locator('#inspectPermissions')).toBeDisabled();
  await page.locator('#sheetItem').selectOption(itemId);
  await page.locator('#sheetQuantity').fill('2.5');
  await click('sheetQuantitySave');
  await status('הכתיבה אומתה');
  assert.equal(entry.values.Items[1][2], 2.5);
  entry.file.capabilities.canEdit = false;
  await click('sheetAppend');
  await status('אין יכולת עריכה');
  assert.equal(writes().length, 1);
  await expect(page.locator('#sheetRows')).toBeEmpty();
  entry.file.capabilities.canEdit = true;
  await load();
  hooks.identity = () => ({ sub: 'different', email: 'A@example.test' });
  await click('sheetAppend');
  await status('זהות החשבון אינה תואמת');
  assert.equal(writes().length, 1);
  hooks.identity = undefined;
  await load();
  hooks.before = async ({ endpoint, method }, route, reply) => {
    if (method === 'GET' && endpoint.pathname === '/drive/v3/files/file-1') {
      await reply({}, 404);
      return true;
    }
  };
  await click('sheetAppend');
  await status('HTTP 404');
  assert.equal(writes().length, 1);
});

test('Owner lists ACLs and creates, changes and deletes only explicit user permissions', async t => {
  const entry = fixture();
  const api = await setup(t, [entry]);
  const { page, load, click, hooks, writes } = api;
  const permissions = [
    { id: 'owner-1', type: 'user', role: 'owner', emailAddress: 'A@example.test' },
    { id: 'group-1', type: 'group', role: 'reader' },
  ];
  hooks.before = async ({ endpoint, method, body }, route, reply) => {
    if (!endpoint.pathname.includes('/permissions')) return;
    if (method === 'GET') {
      const offset = Number(endpoint.searchParams.get('pageToken') ?? 0);
      await reply({ permissions: permissions.slice(offset, offset + 1),
        nextPageToken: offset + 1 < permissions.length ? String(offset + 1) : undefined });
    } else if (method === 'POST') {
      permissions.push({ id: 'new-1', ...body });
      await reply(permissions.at(-1));
    } else if (method === 'PATCH') {
      permissions.at(-1).role = body.role;
      await reply(permissions.at(-1));
    } else {
      permissions.pop();
      await route.fulfill({ status: 204 });
    }
    return true;
  };
  await load();
  await page.locator('summary').filter({ hasText: 'ניהול שיתוף' }).click();
  const sharingStatus = value => expect(page.locator('#sharingStatus')).toContainText(value);
  async function inspect() {
    await click('inspectPermissions');
    await sharingStatus('נקראו');
  }
  await inspect();
  await expect(page.locator('#permissionSummary')).toContainText('קבוצה');
  await expect(page.locator('#permissionSelect option')).toHaveCount(1);
  await page.locator('#recipient').fill('B@example.test, C@example.test');
  await page.locator('#sharingForm').evaluate(form => form.dispatchEvent(new Event('submit', { cancelable: true })));
  await sharingStatus('כתובת יחידה');
  assert.equal(writes().length, 0);

  await inspect();
  await page.locator('#recipient').fill('B@example.test');
  await click('share');
  await sharingStatus('אישרה את השינוי');
  assert.deepEqual(writes()[0].body, { type: 'user', role: 'reader', emailAddress: 'B@example.test' });
  await expect(page.locator('#recipient')).toHaveValue('');
  await expect(page.locator('#log')).not.toContainText('B@example.test');
  assert.equal(await page.evaluate(() => JSON.stringify(localStorage).includes('B@example.test')), false);
  await inspect();
  await expect(page.locator('#permissionSelect option').last()).toContainText('B@example.test');
  await page.locator('#permissionSelect').selectOption('new-1');
  await page.locator('#permissionRole').selectOption('writer');
  await click('changePermission');
  await sharingStatus('אישרה את השינוי');
  assert.deepEqual(writes()[1].body, { role: 'writer' });

  await inspect();
  await page.locator('#permissionSelect').selectOption('new-1');
  entry.file.capabilities.canShare = false;
  await click('removePermission');
  await sharingStatus('אינו זמין');
  assert.equal(writes().length, 2);
  entry.file.capabilities.canShare = true;
  await inspect();
  await page.locator('#permissionSelect').selectOption('new-1');
  await click('removePermission');
  await sharingStatus('אישרה את השינוי');
  assert.equal(writes()[2].method, 'DELETE');
  assert(writes()[2].endpoint.pathname.endsWith('/permissions/new-1'));
});

test('Switching from A to B while write preflight is outstanding sends no write', async t => {
  const api = await setup(t, [fixture()]);
  const { page, hooks, click, load, writes, connect } = api;
  await load();
  let release;
  let received;
  const started = new Promise(resolve => { received = resolve; });
  const delayed = new Promise(resolve => { release = resolve; });
  hooks.before = async ({ endpoint }, route) => {
    if (!endpoint.pathname.endsWith('/values:batchGet')) return;
    received();
    await delayed;
    await route.abort().catch(() => {});
    return true;
  };
  await click('sheetAppend');
  await started;
  await connect('B', 'reconnect');
  release();
  await expect(page.locator('#sheetRows')).toBeEmpty();
  await expect(page.locator('#sheetAppend')).toBeDisabled();
  assert.equal(writes().length, 0);
});

test('Metadata-only shared duplicate list and duplicate item identities are blocked', async t => {
  const shared = fixture('shared-2');
  shared.file.ownedByMe = false;
  shared.file.shared = true;
  delete shared.file.appProperties;
  shared.values.Items.push(item(), item('עותק', itemId.toUpperCase()));
  const api = await setup(t, [fixture()]);
  const { page, click, status, load, files, writes, discover } = api;
  await load();
  files.set('shared-2', shared);
  await click('sheetAppend');
  await status('אותו list_id');
  await discover(2);
  await page.locator('#sheetSelect').selectOption('shared-2');
  await status('אותו item_id');
  await expect(page.locator('#sheetLoad')).toBeDisabled();
  assert.equal(writes().length, 0);
});
