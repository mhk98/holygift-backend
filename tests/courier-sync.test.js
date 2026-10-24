const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { Op } = require('sequelize');
const { createCourierSyncWorker } = require('../app/modules/order/courierSync.worker');

test('worker paginates, isolates failures and prevents overlapping sweeps', async () => {
  const calls = [];
  let pages = 0;
  const worker = createCourierSyncWorker({
    Order: { async findAll({ where, limit }) {
      assert.deepEqual(where.status[Op.in], ['in_courier', 'on_hold']);
      assert.equal(limit, 100);
      pages++;
      return where.Id[Op.gt] === 0 ? [{ Id: 1, courier: 'Steadfast' }, { Id: 2, courier: 'Pathao' }]
        : where.Id[Op.gt] === 2 ? [{ Id: 3, courier: 'Steadfast' }] : [];
    } },
    service: {
      async syncSteadfastStatusInDB(id, options) { assert.equal(options.automatic, true); calls.push(id); if (id === 1) throw Error('unavailable'); },
      async syncPathaoStatusInDB(id) { calls.push(id); },
    }, logger: { warn() {}, error() {} }, delayMs: 0,
  });
  await Promise.all([worker.run(), worker.run()]);
  assert.deepEqual(calls, [1, 2, 3]);
  assert.equal(pages, 3);
  await worker.stop();
  await worker.run();
  assert.equal(pages, 3);
});

test('worker spaces lookups and stops the sweep when rate limited', async () => {
  const calls = [];
  const waits = [];
  const worker = createCourierSyncWorker({
    Order: { async findAll({ where }) {
      return where.Id[Op.gt] === 0 ? [1, 2, 3, 4].map((Id) => ({ Id, courier: 'Pathao' })) : [];
    } },
    service: { async syncPathaoStatusInDB(id) {
      calls.push(id);
      if (id === 3) throw Object.assign(Error('Too Many Requests'), { statusCode: 429 });
    } },
    logger: { warn() {}, error() {} },
    wait: async (ms) => { waits.push(ms); },
  });
  await worker.run();
  assert.deepEqual(calls, [1, 2, 3]);
  assert.deepEqual(waits, [400, 400]);
  await worker.stop();
});

function setup(provider, { fail = false, changed = false, status = 'in_courier', rateLimited = false, bodyRateLimited = false } = {}) {
  const row = { Id: 7, orderId: 'INV7', courier: provider, status,
    note: JSON.stringify({ customerAddress: 'Dhaka', courierIntegration: { pathao: { consignmentId: 'P7' } } }) };
  let writes = 0;
  const db = { order: {
    async findByPk() { return row; },
    async update(values, { where }) {
      writes++;
      assert.equal(where.status, status);
      assert.equal(where.note, row.note);
      if (changed) return [0];
      Object.assign(row, values); return [1];
    },
  } };
  const fetched = [];
  const context = { module: { exports: {} }, console, process, setTimeout, clearTimeout, AbortController, URL, Date, Map,
    async fetch(url) {
      fetched.push(url);
      if (fail) throw Error('courier offline');
      if (rateLimited || bodyRateLimited) return {
        ok: bodyRateLimited, status: bodyRateLimited ? 200 : 429,
        headers: { get: () => '600' },
        text: async () => JSON.stringify({ status: 429, message: 'Too Many Requests' }),
      };
      const data = url.includes('issue-token') ? { access_token: 'test-token' }
        : provider === 'Steadfast' ? { status: 200, delivery_status: 'delivered' }
          : { data: { order_status: 'Delivered' } };
      return { ok: true, text: async () => JSON.stringify(data) };
    },
    require(name) {
      if (name === '../../../models') return db;
      if (name.endsWith('error/ApiError')) return require('../error/ApiError');
      if (name.includes('siteSetting.service')) return { getByType: async () => ({ data: {
        steadfast: { apiKey: 'test', secretKey: 'test' },
        pathao: { clientId: 'test', clientSecret: 'test', username: 'test', password: 'test', storeId: 1 },
      } }) };
      if (name === './orderPricing') return { priceOrderItems: async (payload) => payload };
      if (name === './orderStock') return { registerOrderStockHooks() {} };
      if (name === './courierCooldown') return require('../app/modules/order/courierCooldown');
      if (name === 'crypto' || name === 'sequelize') return require(name);
      return {};
    },
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../app/modules/order/order.service'), 'utf8'), context);
  return { row, fetched, writes: () => writes, sync: () => context.module.exports[provider === 'Steadfast' ? 'syncSteadfastStatusInDB' : 'syncPathaoStatusInDB'](7, { automatic: true }) };
}
for (const provider of ['Steadfast', 'Pathao']) {
  test(`${provider} delivery automatically updates order and preserves metadata`, async () => {
    const { sync, row } = setup(provider);
    await sync();
    assert.equal(row.status, 'delivered');
    assert.equal(JSON.parse(row.note).customerAddress, 'Dhaka');
  });
  test(`${provider} failures and concurrent edits do not overwrite status`, async () => {
    const failed = setup(provider, { fail: true });
    await assert.rejects(failed.sync(), /courier offline/);
    assert.equal(failed.writes(), 0);
    const changed = setup(provider, { changed: true });
    await changed.sync();
    assert.equal(changed.row.status, 'in_courier');
    const delivered = setup(provider, { status: 'delivered' });
    await delivered.sync();
    assert.equal(delivered.writes(), 0);
  });
}

test('Pathao token is reused across status lookups', async () => {
  const { sync, fetched } = setup('Pathao', { status: 'on_hold' });
  await sync();
  await sync();
  assert.equal(fetched.filter((url) => url.includes('issue-token')).length, 1);
});

for (const provider of ['Steadfast', 'Pathao']) {
  test(`${provider} HTTP 429 preserves retry time and blocks subsequent network calls`, async () => {
    const { sync, fetched, writes } = setup(provider, { rateLimited: true });
    await assert.rejects(sync(), e => e.statusCode === 429 && e.retryAfterMs >= 600000);
    await assert.rejects(sync(), e => e.statusCode === 429 && e.retryAfterMs > 590000);
    assert.equal(fetched.length, 1);
    assert.equal(writes(), 0);
  });
}

test('Steadfast HTTP 200 with a rate-limit error body is treated as 429', async () => {
  const { sync, fetched, writes } = setup('Steadfast', { bodyRateLimited: true });
  await assert.rejects(sync(), e => e.statusCode === 429);
  await assert.rejects(sync(), e => e.statusCode === 429);
  assert.equal(fetched.length, 1);
  assert.equal(writes(), 0);
});

test('rate limited sweep resumes at the failed row and backs off repeated failures', async () => {
  let time = 0;
  let limited = true;
  const calls = [];
  const warnings = [];
  const worker = createCourierSyncWorker({
    now: () => time, intervalMs: 1000, delayMs: 0,
    Order: { async findAll({ where }) {
      return [1, 2, 3].filter(Id => Id > where.Id[Op.gt]).map(Id => ({ Id, courier: 'Pathao' }));
    } },
    service: { async syncPathaoStatusInDB(id) {
      calls.push(id);
      if (id === 2 && limited) throw Object.assign(Error('limited'), { statusCode: 429, retryAfterMs: 1500 });
    } },
    logger: { warn(message) { warnings.push(message); }, error() {} },
  });
  await worker.run();
  assert.deepEqual(calls, [1, 2]);
  time = 1000;
  await worker.run();
  assert.deepEqual(calls, [1, 2]);
  time = 1500;
  await worker.run();
  assert.deepEqual(calls, [1, 2, 2]);
  time = 3000;
  await worker.run();
  assert.equal(calls.length, 3);
  limited = false;
  time = 3500;
  await worker.run();
  assert.deepEqual(calls, [1, 2, 2, 2, 3]);
  assert.equal(warnings.length, 2);
  await worker.run();
  assert.deepEqual(calls.slice(-3), [1, 2, 3]);
  await worker.stop();
});

test('shared provider cooldown honors Retry-After, isolates providers and resets after success', () => {
  const { createCourierCooldown } = require('../app/modules/order/courierCooldown');
  let time = Date.parse('2026-10-22T00:00:00Z');
  const cooldown = createCourierCooldown({ now: () => time, baseMs: 1000, maxMs: 4000 });
  assert.equal(cooldown.limited('Pathao', '10').retryAfterMs, 10000);
  cooldown.succeeded('Pathao');
  assert.throws(() => cooldown.check('Pathao'), e => e.statusCode === 429 && e.retryAfterMs === 10000);
  cooldown.check('Steadfast');
  time += 10000;
  cooldown.check('Pathao');
  assert.equal(cooldown.limited('Pathao', 'invalid').retryAfterMs, 2000);
  time += 2000;
  assert.equal(cooldown.limited('Pathao', new Date(time + 20000).toUTCString()).retryAfterMs, 20000);
  time += 20000;
  cooldown.succeeded('Pathao');
  assert.equal(cooldown.limited('Pathao').retryAfterMs, 1000);
});
