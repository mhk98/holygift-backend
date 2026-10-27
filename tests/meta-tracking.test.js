const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { Op } = require('sequelize');

// The tracking modules are loaded against an in-memory fake of models/index.js,
// so these tests never touch the shared production database or call Meta.
const sha = (value) => crypto.createHash('sha256').update(value, 'utf8').digest('hex');

function fakeDb() {
  const outbox = [];
  const pixels = [];
  const users = [];
  const matches = (row, where = {}) => Object.entries(where).every(([key, value]) => {
    if (key === Op.or || key === Op.and) return true;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if (value[Op.lte] !== undefined) return row[key] <= value[Op.lte];
      if (value[Op.ne] !== undefined) return row[key] !== value[Op.ne];
      return true;
    }
    return row[key] === value;
  });
  const wrap = (row) => Object.assign(row, {
    async update(values) { Object.assign(row, values); return row; },
  });
  return {
    outbox, pixels, users,
    facebookPixel: {
      async findAll({ where } = {}) { return pixels.filter((p) => !p.deletedAt && matches(p, where)); },
      async findOne({ where }) { return pixels.find((p) => matches(p, where)) || null; },
      async update(values, { where }) { pixels.filter((p) => matches(p, where)).forEach((p) => Object.assign(p, values)); return [1]; },
    },
    metaEventOutbox: {
      async bulkCreate(rows, { ignoreDuplicates }) {
        assert.ok(ignoreDuplicates, 'outbox inserts must ignore duplicates');
        for (const row of rows) {
          if (outbox.some((r) => r.pixelRowId === row.pixelRowId && r.eventId === row.eventId)) continue;
          outbox.push(wrap({ Id: outbox.length + 1, attempts: 0, lockedUntil: null, ...row }));
        }
      },
      async findAll({ where }) { return outbox.filter((r) => matches(r, where)); },
      async update(values, { where }) {
        const row = outbox.find((r) => r.Id === where.Id && r.status === where.status);
        if (!row || (row.lockedUntil && row.lockedUntil > new Date())) return [0];
        Object.assign(row, values);
        return [1];
      },
    },
    user: { async findOne({ where }) { return users.find((u) => u.Id === where.Id) || null; } },
  };
}

function load() {
  const db = fakeDb();
  const root = path.join(__dirname, '..');
  const modelsPath = require.resolve(path.join(root, 'models'));
  for (const key of Object.keys(require.cache)) {
    if (key.includes(`${path.sep}app${path.sep}modules${path.sep}`) || key.includes(`${path.sep}helpers${path.sep}`)) delete require.cache[key];
  }
  require.cache[modelsPath] = { id: modelsPath, filename: modelsPath, loaded: true, exports: db };
  return {
    db,
    tracking: require(path.join(root, 'app/modules/tracking/tracking.service')),
    capi: require(path.join(root, 'app/modules/tracking/metaCapi.service')),
    userData: require(path.join(root, 'app/modules/tracking/metaUserData')),
    secretBox: require(path.join(root, 'helpers/secretBox')),
  };
}

function stubFetch(responses) {
  const calls = [];
  global.fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    const next = typeof responses === 'function' ? responses(calls.length) : responses.shift();
    if (next instanceof Error) throw next;
    return { ok: next.status < 400, status: next.status, json: async () => next.body };
  };
  return calls;
}

const req = (headers = {}) => ({ headers: { 'user-agent': 'Mozilla/5.0 test', ...headers }, ip: '203.0.113.9' });

test('Bangladesh phones normalise to 8801XXXXXXXXX before hashing', () => {
  const { userData } = load();
  for (const raw of ['01712345678', '+8801712345678', '8801712345678', '1712345678', '008801712345678', '017-1234-5678']) {
    assert.equal(userData.normalizePhone(raw), '8801712345678', raw);
  }
  assert.equal(userData.normalizePhone('12345'), undefined);
  assert.equal(userData.normalizePhone(''), undefined);
});

test('user_data hashes personal fields, keeps fbp/fbc/IP/UA raw and omits missing ones', () => {
  const { userData } = load();
  const data = userData.buildUserData({
    email: ' Rahim@Example.COM ',
    phone: '01712345678',
    name: 'MD. Mohsin Kabir',
    city: 'Cumilla',
    country: 'BD',
    externalId: 'customer_7',
    fbp: 'fb.1.1700000000000.123456789',
    fbc: 'fb.1.1700000000000.IwAR0abc-_x',
    ipAddress: '203.0.113.9',
    userAgent: 'Mozilla/5.0',
  });
  assert.deepEqual(data.em, [sha('rahim@example.com')]);
  assert.deepEqual(data.ph, [sha('8801712345678')]);
  assert.deepEqual(data.fn, [sha('md')]);
  assert.deepEqual(data.ln, [sha('kabir')]);
  assert.deepEqual(data.ct, [sha('cumilla')]);
  assert.deepEqual(data.country, [sha('bd')]);
  assert.deepEqual(data.external_id, [sha('customer_7')]);
  assert.equal(data.fbp, 'fb.1.1700000000000.123456789');
  assert.equal(data.fbc, 'fb.1.1700000000000.IwAR0abc-_x');
  assert.equal(data.client_ip_address, '203.0.113.9');
  assert.equal(data.client_user_agent, 'Mozilla/5.0');

  const anonymous = userData.buildUserData({ city: 'outside', fbp: 'not-a-cookie', ipAddress: '203.0.113.9' });
  assert.deepEqual(Object.keys(anonymous), ['client_ip_address'], 'missing or invalid identifiers are left out');
});

test('Bangla names are kept as Unicode and an existing hash is not hashed again', () => {
  const { userData } = load();
  assert.deepEqual(userData.splitName('মোহসিন কবির'), { fn: 'মোহসিন', ln: 'কবির' });
  const hashed = sha('8801712345678');
  assert.equal(userData.sha256(hashed), hashed);
});

test('access tokens are encrypted at rest and only a masked tail is shown', () => {
  process.env.TRACKING_SECRET_KEY = crypto.randomBytes(32).toString('hex');
  const { secretBox } = load();
  const token = 'EAAG' + 'x'.repeat(40) + 'WXYZ';
  const stored = secretBox.encrypt(token);
  assert.ok(stored.startsWith('enc:v1:'));
  assert.ok(!stored.includes(token));
  assert.equal(secretBox.decrypt(stored), token);
  assert.equal(secretBox.encrypt(stored), stored, 'already encrypted values are left alone');
  assert.equal(secretBox.mask(stored), '••••WXYZ');
  delete process.env.TRACKING_SECRET_KEY;
});

test('the public endpoint refuses Purchase and malformed events', async () => {
  const { tracking } = load();
  await assert.rejects(tracking.trackEvent({ eventName: 'Purchase', eventId: 'purchase_order_1' }, req()), /Unsupported/);
  await assert.rejects(tracking.trackEvent({ eventName: 'Lead', eventId: 'lead_12345678' }, req()), /Unsupported/);
  await assert.rejects(tracking.trackEvent({ eventName: 'ViewContent', eventId: 'x' }, req()), /eventId/);
});

test('browser events reach every active pixel with the same event_id and sanitised data', async () => {
  const { db, tracking } = load();
  db.pixels.push(
    { Id: 1, pixelsId: '111111111111111', metaAccessToken: 'TOKEN_ONE_' + 'a'.repeat(20), status: 'Active' },
    { Id: 2, pixelsId: '222222222222222', metaAccessToken: 'TOKEN_TWO_' + 'b'.repeat(20), status: 'Inactive' },
  );
  const calls = stubFetch(() => ({ status: 200, body: { events_received: 1 } }));
  const result = await tracking.trackEvent({
    eventName: 'AddToCart',
    eventId: 'atc_0b7f3c2e-1',
    eventSourceUrl: 'https://holygift.xyz/product/kashmiri-shawl',
    attribution: { fbp: 'fb.1.1700000000000.42', fbc: 'garbage' },
    customData: {
      contents: [{ id: 10, quantity: 2, item_price: 950 }, { id: '<script>', quantity: 1 }],
      content_name: 'Shawl', value: 1900, currency: 'USD',
      phone: '01712345678',
    },
  }, req());
  assert.deepEqual(result, { accepted: true });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(calls.length, 1, 'the inactive pixel gets nothing');
  assert.match(calls[0].url, /\/111111111111111\/events$/);
  assert.ok(!calls[0].url.includes('access_token'), 'token is not in the URL');
  const [event] = calls[0].body.data;
  assert.equal(calls[0].body.test_event_code, undefined, 'live traffic is never sent in test mode');
  assert.equal(event.event_name, 'AddToCart');
  assert.equal(event.event_id, 'atc_0b7f3c2e-1');
  assert.equal(event.action_source, 'website');
  assert.deepEqual(event.custom_data.contents, [{ id: '10', quantity: 2, item_price: 950 }]);
  assert.equal(event.custom_data.currency, 'BDT');
  assert.equal(event.custom_data.phone, undefined, 'unknown custom fields are dropped');
  assert.equal(event.user_data.fbp, 'fb.1.1700000000000.42');
  assert.equal(event.user_data.fbc, undefined);
  assert.equal(event.user_data.client_ip_address, '203.0.113.9');
});

test('Purchase value is product total minus discount, without delivery', () => {
  const { tracking } = load();
  const order = {
    Id: 41, orderId: 'HD-1041',
    note: JSON.stringify({
      items: [{ id: 10, name: 'Shawl', price: 950, qty: 2 }, { id: 11, name: 'Mug', price: 300, qty: 1 }],
      discount: 200, deliveryCharge: 120, total: 2120,
    }),
  };
  const data = tracking.buildPurchaseData(order);
  assert.equal(data.eventId, 'purchase_order_41');
  assert.equal(data.value, 2000);
  assert.equal(data.num_items, 3);
  assert.deepEqual(data.content_ids, ['10', '11']);
  assert.equal(data.order_id, 'HD-1041');
});

test('one order queues exactly one Purchase per pixel, however often it is enqueued', async () => {
  const { db, tracking, capi } = load();
  db.pixels.push({ Id: 1, pixelsId: '111111111111111', metaAccessToken: 'TOKEN_ONE_' + 'a'.repeat(20), status: 'Active' });
  const calls = stubFetch(() => ({ status: 200, body: { events_received: 1 } }));
  const order = {
    Id: 7, orderId: 'HD-7', customerName: 'Rahim Uddin', customerPhone: '01712345678', customerDistrict: 'Dhaka', ipAddress: '203.0.113.9',
    note: JSON.stringify({ items: [{ id: 10, name: 'Shawl', price: 950, qty: 1 }], tracking: { fbp: 'fb.1.1.2', userAgent: 'UA' } }),
  };
  await tracking.enqueuePurchase(order);
  await tracking.enqueuePurchase(order);
  assert.equal(db.outbox.length, 1);
  await capi.processOutbox();
  await capi.processOutbox();
  assert.equal(calls.length, 1, 'sent once');
  assert.equal(db.outbox[0].status, 'sent');
  const event = calls[0].body.data[0];
  assert.equal(event.event_id, 'purchase_order_7');
  assert.deepEqual(event.user_data.ph, [sha('8801712345678')]);
  assert.deepEqual(event.user_data.fn, [sha('rahim')]);
  assert.deepEqual(event.user_data.ct, [sha('dhaka')]);
  assert.equal(event.user_data.client_user_agent, 'UA');
  assert.equal(event.custom_data.value, 950);
});

test('a Meta timeout is retried later; a rejected event is not retried', async () => {
  const { db, capi } = load();
  db.pixels.push({ Id: 1, pixelsId: '111111111111111', metaAccessToken: 'TOKEN_ONE_' + 'a'.repeat(20), status: 'Active' });
  const timeout = Object.assign(new Error('aborted'), { name: 'TimeoutError' });
  stubFetch([timeout, { status: 400, body: { error: { code: 100, message: 'Invalid parameter' } } }]);
  const event = (id) => ({ event_name: 'Purchase', event_id: id, event_time: Math.floor(Date.now() / 1000), action_source: 'website', user_data: {} });

  await capi.enqueue(event('purchase_order_1'));
  await capi.processOutbox();
  assert.equal(db.outbox[0].status, 'pending');
  assert.equal(db.outbox[0].attempts, 1);
  assert.ok(db.outbox[0].nextAttemptAt > new Date(), 'retry is scheduled with backoff');
  assert.match(db.pixels[0].lastError, /timed out/);

  await capi.enqueue(event('purchase_order_2'));
  await capi.processOutbox();
  assert.equal(db.outbox[1].status, 'failed');
});

test('events queued for a pixel that is later disabled are skipped', async () => {
  const { db, capi } = load();
  db.pixels.push({ Id: 1, pixelsId: '111111111111111', metaAccessToken: 'TOKEN_ONE_' + 'a'.repeat(20), status: 'Active' });
  const calls = stubFetch(() => ({ status: 200, body: {} }));
  await capi.enqueue({ event_name: 'Purchase', event_id: 'purchase_order_3', event_time: Math.floor(Date.now() / 1000), user_data: {} });
  db.pixels[0].status = 'Inactive';
  await capi.processOutbox();
  assert.equal(calls.length, 0);
  assert.equal(db.outbox[0].status, 'skipped');
});
