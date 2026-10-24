const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const Sequelize = require('sequelize');
const { Op } = Sequelize;

function setup() {
  let listWhere, countWhere;
  const db = { sequelize: Sequelize, scratchCard: {
    async findAll(options) {
      if (options.limit) { listWhere = options.where; return []; }
      if (options.attributes.includes('courierStatus')) return [
        { status: 'In Transit', courierStatus: 'In Transit' },
        { status: 'On Way To Sorting Hub', courierStatus: 'On Way To Sorting Hub' },
        { status: 'In Courier', courierStatus: 'Pending' },
        { status: 'Received At Last Mile Hub', courierStatus: null },
      ];
      return [];
    },
    async count(options) { countWhere = options.where; return 0; },
  } };
  const file = require.resolve('../app/modules/scratchCard/scratchCard.service');
  const localRequire = createRequire(file);
  const context = { module: { exports: {} }, require(name) {
    if (name === '../../../models') return db;
    if (name === './scratchCard.courier') return { courierStage: () => 'in_courier' };
    return localRequire(name);
  } };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), context);
  return { get: context.module.exports.getAllFromDB, where: () => listWhere, count: () => countWhere };
}

test('courier options include every stored display and raw status without duplicates', async () => {
  const { get } = setup();
  const result = await get({}, {}, { role: 'Admin' });
  assert.deepEqual(Array.from(result.meta.courierStatuses), ['In Courier', 'In Transit', 'On Way To Sorting Hub', 'Pending', 'Received At Last Mile Hub']);
});

test('multi-status filters use OR and preserve agent scope and count query', async () => {
  const api = setup();
  await api.get({ courierStatus: JSON.stringify(['status:In Transit', 'status:On Way To Sorting Hub']) }, { page: 2 }, { Id: 9, role: 'Agent' });
  const conditions = api.where()[Op.and];
  assert.equal(conditions[0].assignedAgentId, 9);
  const selected = conditions[1][Op.or];
  assert.equal(selected.length, 2);
  assert.equal(selected[0][Op.or][0].status, 'In Transit');
  assert.equal(selected[0][Op.or][1].courierStatus, 'In Transit');
  assert.equal(selected[1][Op.or][0].status, 'On Way To Sorting Hub');
  assert.equal(api.where(), api.count());
});

test('legacy single filters, mixed selections and clearing work; malformed filters fail', async () => {
  const api = setup();
  await api.get({ courierStatus: 'status:In Transit' }, {}, { role: 'Admin' });
  assert.equal(api.where()[Op.and][0][Op.or].length, 1);
  await api.get({ courierStatus: JSON.stringify(['none', 'courier:Pathao']) }, {}, { role: 'Admin' });
  assert.equal(api.where()[Op.and][0][Op.or][0].courier, null);
  await api.get({ courierStatus: '[]' }, {}, { role: 'Admin' });
  assert.equal(Reflect.ownKeys(api.where()).length, 0);
  for (const value of ['[bad', '[null]', '[1]', '[""]', 'bad']) {
    await assert.rejects(api.get({ courierStatus: value }, {}, { role: 'Admin' }), error => error.statusCode === 400);
  }
});
