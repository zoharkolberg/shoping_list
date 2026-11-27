const { chromium } = require('playwright');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const base = 'http://127.0.0.1:8765/shoping_list/';
const scope = 'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/userinfo.email openid';
const id = '0-synthetic.apps.googleusercontent.com';
let browser;
test.before(async () => {
  browser = await chromium.launch({ executablePath: process.env.POC_CHROMIUM });
});
test.after(async () => browser?.close());

function mockLibrary(route) {
  return route.fulfill({
    contentType: 'text/javascript',
    body: `window.attempts = []; window.google = {accounts:{oauth2:{initTokenClient(config) {
      return {requestAccessToken(params) { attempts.push({config, params}); }};
    }}}};`,
  });
}

async function setup(t, options = {}) {
  const page = await browser.newPage(options.viewport ? { viewport: options.viewport } : {});
  t.after(() => page.close());
  if (options.clock) await page.clock.install();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (/Content Security Policy/.test(message.text())) errors.push(message.text()); });
  t.after(() => assert.deepEqual(errors, []));
  const calls = [];
  await page.route('https://accounts.google.com/gsi/client', route => (
    options.libraryRoute ? options.libraryRoute(route, mockLibrary) : mockLibrary(route)
  ));
  const reply = (route, status, json) => route.fulfill({
    status, json, headers: { 'access-control-allow-origin': '*' },
  });
  await page.route('https://openidconnect.googleapis.com/v1/userinfo', async route => {
    const token = route.request().headers().authorization;
    calls.push({type:'identity', token});
    if (options.identity) return options.identity(route, reply, token);
    return reply(route, 200, {sub: token === 'Bearer mock-A' ? 'a' : 'b', email: token === 'Bearer mock-A' ? 'a@example.test' : 'b@example.test'});
  });
  await page.route('https://www.googleapis.com/drive/v3/files?*', async route => {
    calls.push({type:'drive', token:route.request().headers().authorization, method:route.request().method(), url:route.request().url()});
    if (options.drive) return options.drive(route, reply);
    return reply(route, 200, {files: []});
  });
  await page.goto(base);
  await page.getByRole('link').click({noWaitAfter: true});
  await page.waitForURL(base + 'poc/', { waitUntil: 'domcontentloaded' });
  if (!options.libraryRoute) await page.waitForFunction(() => Array.isArray(window.attempts));
  return {page, calls};
}

const click = (page, id) => page.locator('#' + id).click();
const text = (page, id, value) => page.waitForFunction(([id, value]) => document.getElementById(id).textContent.includes(value), [id, value]);
async function config(page, value = id) {
  await page.locator('#client').fill(value);
  await page.locator('#config button').click();
}
function replyToken(page, fields = {}, index = -1) {
  return page.evaluate(([fields, index, scope]) => attempts.at(index).config.callback({
    access_token: 'mock-A', scope, expires_in: 3600, ...fields,
  }), [fields, index, scope]);
}
const wait = () => new Promise(resolve => setTimeout(resolve, 50));

test('Configuration, relative project URL, persistence and RTL at 320/390/1280px', async t => {
  const {page} = await setup(t);
  assert.equal(await page.locator('#connect').isDisabled(), true);
  await config(page, 'invalid');
  await text(page, 'configuration', 'אינו בתבנית');
  await config(page);
  assert.equal(await page.locator('#connect').isEnabled(), true);
  await page.reload();
  await page.locator('#connect:enabled').waitFor();
  assert.equal(await page.locator('#client').inputValue(), id);
  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({width, height: 800});
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('main')).direction), 'rtl');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth === innerWidth), true);
    assert.equal(await page.evaluate(() => document.querySelector('#reconnect').getBoundingClientRect().height >= 44), true);
  }
  await config(page, '');
  assert.equal(await page.locator('#connect').isDisabled(), true);
  assert.equal(await page.evaluate(() => localStorage.length), 0);
});

test('GIS script load failure', async t => {
  const {page} = await setup(t, {libraryRoute: route => route.abort()});
  await config(page);
  await text(page, 'configuration', 'טעינת ספריית Google נכשלה');
  assert.equal(await page.locator('#connect').isDisabled(), true);
});

test('Exact scope request, partial consent, successful identity, empty Drive page and safe storage/logging', async t => {
  const {page, calls} = await setup(t);
  await config(page);
  await click(page, 'connect');
  assert.deepEqual(await page.evaluate(() => {
    const {config, params} = attempts[0];
    return [config.scope, config.include_granted_scopes, params.prompt];
  }), [scope, false, 'select_account']);
  await replyToken(page, {scope:'openid email'});
  await text(page, 'status', 'רק חלק');
  assert.deepEqual(calls, []);
  await click(page, 'reconnect');
  await replyToken(page, {scope: scope.replace('https://www.googleapis.com/auth/userinfo.email', 'email')});
  await text(page, 'email', 'a@example.test');
  await click(page, 'drive');
  await text(page, 'driveStatus', 'לא הופיעו קבצים');
  assert.deepEqual(calls.map(call => call.type), ['identity', 'drive']);
  assert.equal(calls[1].method, 'GET');
  assert.equal(calls[1].token, 'Bearer mock-A');
  assert.equal(new URL(calls[1].url).searchParams.get('fields'), 'files(id)');
  assert.doesNotMatch(await page.locator('#log').innerText(), /mock-A|Bearer|example\.test/);
  assert.deepEqual(await page.evaluate(() => Object.entries(localStorage)), [['shoping-list-poc.oauth-client-id', id]]);
  assert.equal(await page.evaluate(() => sessionStorage.length), 0);
  await click(page, 'disconnect');
  await text(page, 'email', '—');
  await text(page, 'driveStatus', 'טרם נבדק');
  assert.equal(await page.locator('#drive').isDisabled(), true);
  await page.reload();
  await text(page, 'status', 'מנותק');
});

test('Denied consent, OAuth error, popup cancellation and popup launch failure', async t => {
  const {page, calls} = await setup(t);
  await config(page);
  await click(page, 'connect');
  await replyToken(page, {error:'access_denied', error_description:'mock-source-sensitive'});
  await text(page, 'status', 'נדחתה');
  await click(page, 'reconnect');
  await replyToken(page, {error:'server_error'});
  await text(page, 'status', 'החיבור דרך Google נכשל');
  for (const [type, message] of [['popup_closed', 'נסגר'], ['popup_failed_to_open','פתיחת חלון']]) {
    await click(page, 'reconnect');
    await page.evaluate(type => attempts.at(-1).config.error_callback({type}), type);
    await text(page, 'status', message);
  }
  assert.deepEqual(calls, []);
  assert.doesNotMatch(await page.locator('#log').innerText(), /mock-source-sensitive/);
});

test('Invalid lifetime, timer expiry, 401 and user-initiated reconnect', async t => {
  const {page, calls} = await setup(t, {drive: (route, reply) => reply(route, 401, {})});
  await config(page);
  await click(page, 'connect');
  await replyToken(page, {expires_in:0});
  await text(page, 'status', 'לא תקינה');
  assert.equal(calls.length, 0);
  await click(page, 'reconnect');
  await replyToken(page, {expires_in:1});
  await text(page, 'email', 'a@example.test');
  await text(page, 'status', 'תוקף האסימון הסתיים');
  assert.equal(await page.locator('#drive').isDisabled(), true);
  assert.equal(await page.evaluate(() => attempts.length), 2);
  await click(page, 'reconnect');
  await replyToken(page);
  await click(page, 'drive');
  await text(page, 'status', 'תוקף האסימון הסתיים');
  assert.equal(await page.locator('#reconnect').isEnabled(), true);
});

test('UserInfo failure, missing sub, Drive network retry and HTTP errors', async t => {
  let identityCount = 0;
  let driveCount = 0;
  const {page} = await setup(t, {
    identity: (route, reply) => {
      identityCount++;
      if (identityCount === 1) return route.abort();
      return reply(route, 200, identityCount === 2 ? {email:'fake@example.test'} : {sub:'a',email:'a@example.test'});
    },
    drive: (route, reply) => ++driveCount === 1 ? route.abort() : reply(route, 403, {error:'raw-error'}),
  });
  await config(page);
  await click(page, 'connect');
  await replyToken(page);
  await text(page, 'status', 'בקשת הרשת נכשלה');
  await click(page, 'reconnect');
  await replyToken(page);
  await text(page, 'status', 'אימות החשבון');
  await click(page, 'reconnect');
  await replyToken(page);
  await click(page, 'drive');
  await text(page, 'driveStatus', 'בקשת הרשת נכשלה');
  await click(page, 'drive');
  await text(page, 'driveStatus', '403');
  assert.doesNotMatch(await page.locator('main').innerText(), /raw-error/);
});

test('Session isolation with stale GIS, UserInfo and Drive results', async t => {
  let releaseIdentity, releaseDrive;
  const identityGate = new Promise(resolve => { releaseIdentity = resolve; });
  const driveGate = new Promise(resolve => { releaseDrive = resolve; });
  const {page, calls} = await setup(t, {
    identity: async (route, reply, token) => {
      if (token === 'Bearer stale') await identityGate;
      await reply(route, 200, {sub: token, email: token.split(' ')[1] + '@example.test'}).catch(() => {});
    },
    drive: async (route, reply) => {
      await driveGate;
      await reply(route, 403, {}).catch(() => {});
    },
  });
  async function waitCalls(count) {
    for (let index = 0; index < 100 && calls.length < count; index++) await wait();
    assert.equal(calls.length, count);
  }
  await config(page);
  await click(page, 'connect');
  await click(page, 'disconnect');
  await click(page, 'connect');
  await replyToken(page, {access_token:'ignored'}, 0);
  await replyToken(page, {access_token:'stale'});
  await waitCalls(1);
  assert.equal(calls[0].token, 'Bearer stale');
  await click(page, 'disconnect');
  await click(page, 'connect');
  await replyToken(page, {access_token:'mock-A'});
  await text(page, 'email', 'mock-A@example.test');
  releaseIdentity();
  await click(page, 'drive');
  await waitCalls(3);
  await click(page, 'reconnect');
  await text(page, 'email', '—');
  await replyToken(page, {access_token:'mock-B'});
  await text(page, 'email', 'mock-B@example.test');
  releaseDrive();
  await wait();
  await text(page, 'driveStatus', 'טרם נבדק');
  await click(page, 'drive');
  await text(page, 'driveStatus', '403');
  assert.equal(calls.at(-1).token, 'Bearer mock-B');
  assert.doesNotMatch(await page.locator('#log').innerText(), /mock-|example\.test/);
});

test('GIS timeout blocks a late load and reload retries in a fresh document', async t => {
  let release;
  let requestCount = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const {page} = await setup(t, {
    clock: true,
    async libraryRoute(route, mock) {
      if (++requestCount === 1) {
        await gate;
        return route.abort();
      }
      await mock(route);
    },
  });
  await config(page);
  const script = await page.locator('script[src="https://accounts.google.com/gsi/client"]').elementHandle();
  await page.clock.fastForward(16000);
  await text(page, 'configuration', 'זמן ההמתנה לטעינת ספריית Google הסתיים');
  assert.equal(await page.locator('#connect').isDisabled(), true);
  await script.evaluate(element => {
    window.google = { accounts: { oauth2: { initTokenClient() {} } } };
    element.dispatchEvent(new Event('load'));
  });
  assert.equal(await page.locator('#connect').isDisabled(), true);
  release();
  await click(page, 'retryLibrary');
  await page.locator('#connect:enabled').waitFor();
  assert.equal(requestCount, 2);
  assert.equal(await page.locator('#client').inputValue(), id);
  assert.equal(await page.locator('#retryLibrary').isHidden(), true);
});

test('OAuth timeout and explicit retry ignore late callbacks from the popup', async t => {
  const {page, calls} = await setup(t, {clock: true});
  await config(page);
  await click(page, 'connect');
  await text(page, 'disconnect', 'ביטול ניסיון החיבור');
  await page.clock.fastForward(121000);
  await text(page, 'status', 'זמן ההמתנה להרשאה הסתיים');
  assert.equal(await page.evaluate(() => attempts.length), 1);
  assert.equal(await page.locator('#drive').isDisabled(), true);
  await click(page, 'reconnect');
  await replyToken(page, {access_token:'stale'}, 0);
  await page.evaluate(() => attempts[0].config.error_callback({type:'popup_closed'}));
  assert.deepEqual(calls, []);
  await text(page, 'status', 'ממתין להרשאה');
  await replyToken(page, {access_token:'mock-B'});
  await text(page, 'email', 'b@example.test');
  assert.deepEqual(calls.map(call => call.token), ['Bearer mock-B']);
});

test('CSP permits documented GIS paths and confines application resource types', async t => {
  const {page} = await setup(t);
  const policy = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
  const directives = Object.fromEntries(policy.split(';').map(part => part.trim().split(/\s+/)).map(
    ([name, ...sources]) => [name, sources],
  ));
  assert.deepEqual(directives['default-src'], ["'none'"]);
  assert.deepEqual(directives['script-src'], ["'self'", 'https://accounts.google.com/gsi/client']);
  assert.deepEqual(directives['style-src'], ["'self'", 'https://accounts.google.com/gsi/style']);
  assert.deepEqual(directives['frame-src'], ['https://accounts.google.com/gsi/']);
  assert.deepEqual(directives['connect-src'], [
    'https://accounts.google.com/gsi/', 'https://openidconnect.googleapis.com', 'https://www.googleapis.com',
    'https://sheets.googleapis.com',
  ]);
  assert.deepEqual(directives['base-uri'], ["'none'"]);
  assert.deepEqual(directives['form-action'], ["'none'"]);
});
