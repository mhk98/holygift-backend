const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const Sequelize = require('sequelize');
const { Op } = Sequelize;

function setup() {
  let listWhere, countWhere, listOrder;
  const db = { sequelize: Sequelize, scratchCard: {
    async findAll(options) {
      if (options.limit) { listWhere = options.where; listOrder = options.order; return []; }
      if (options.attributes.includes('courierStatus')) return [
        { courier: 'Pathao', status: 'In Transit', courierStatus: 'In Transit' },
        { courier: 'Pathao', status: 'On Way To Sorting Hub', courierStatus: 'On Way To Sorting Hub' },
        { courier: 'Pathao', status: 'In Courier', courierStatus: 'Pending' },
        { courier: 'Pathao', status: 'Received At Last Mile Hub', courierStatus: null },
        { courier: 'Steadfast', status: 'In Review', courierStatus: 'in_review' },
        { courier: 'Steadfast', status: 'In Courier', courierStatus: 'pending' },
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
  return { get: context.module.exports.getAllFromDB, where: () => listWhere, order: () => listOrder, count: () => countWhere };
}

test('courier options include every stored display and raw status without duplicates', async () => {
  const { get } = setup();
  const result = await get({}, {}, { role: 'Admin' });
  assert.deepEqual(Array.from(result.meta.courierStatuses), ['In Courier', 'In Review', 'In Transit', 'On Way To Sorting Hub', 'Pending', 'Received At Last Mile Hub', 'in_review', 'pending']);
});

test('courier options are also listed per courier by the status the card shows', async () => {
  const { get } = setup();
  const { courierStatusesByCourier } = (await get({}, {}, { role: 'Admin' })).meta;
  assert.deepEqual(Array.from(courierStatusesByCourier.Pathao), ['In Courier', 'In Transit', 'On Way To Sorting Hub', 'Received At Last Mile Hub']);
  assert.deepEqual(Array.from(courierStatusesByCourier.Steadfast), ['In Courier', 'In Review']);
});

test('a courier-scoped status only matches that courier', async () => {
  const api = setup();
  await api.get({ courierStatus: JSON.stringify(['courierStatus:Steadfast:In Courier', 'courierStatus:Pathao:In Transit']) }, {}, { role: 'Admin' });
  const [steadfast, pathao] = api.where()[Op.and][0][Op.or];
  assert.equal(steadfast.courier, 'Steadfast');
  assert.equal(steadfast[Op.or][0].status, 'In Courier');
  assert.equal(pathao.courier, 'Pathao');
  assert.equal(pathao[Op.or][1].courierStatus, 'In Transit');
  for (const bad of ['courierStatus:eCourier:Delivered', 'courierStatus:Pathao:', 'courierStatus:Pathao', 'courierStage:eCourier:delivered', 'courierStage:Pathao:']) {
    await assert.rejects(api.get({ courierStatus: bad }, {}, { role: 'Admin' }));
  }
});

test('multi-status filters use OR and keep the count query in step', async () => {
  const api = setup();
  await api.get({ courierStatus: JSON.stringify(['status:In Transit', 'status:On Way To Sorting Hub']) }, { page: 2 }, { Id: 9, role: 'Agent' });
  const conditions = api.where()[Op.and];
  assert.equal(conditions.length, 1);
  const selected = conditions[0][Op.or];
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

test('a courier-scoped stage only looks at that courier', async () => {
  let pairsWhere;
  const db = { sequelize: Sequelize, scratchCard: {
    async findAll(options) {
      if (options.limit) return [];
      if (options.group?.length === 2 && options.group[0] === 'courier') {
        pairsWhere = options.where;
        return [{ courier: 'Steadfast', courierStatus: 'delivered' }];
      }
      return [];
    },
    async count() { return 0; },
  } };
  const file = require.resolve('../app/modules/scratchCard/scratchCard.service');
  const localRequire = createRequire(file);
  const context = { module: { exports: {} }, require(name) {
    if (name === '../../../models') return db;
    if (name === './scratchCard.courier') return { courierStage: (c, s) => (s === 'delivered' ? 'delivered' : 'in_courier') };
    return localRequire(name);
  } };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), context);
  await context.module.exports.getAllFromDB({ courierStatus: 'courierStage:Steadfast:delivered' }, {}, { role: 'Admin' });
  assert.equal(pairsWhere.courier, 'Steadfast');
});

test('an agent sees every card with their own assigned ones first', async () => {
  const api = setup();
  await api.get({}, {}, { Id: 9, role: 'Agent' });
  assert.equal(Reflect.ownKeys(api.where()).length, 0);
  const [mineFirst, newest] = api.order();
  assert.equal(mineFirst[0].val, 'CASE WHEN assignedAgentId = 9 THEN 0 ELSE 1 END');
  assert.deepEqual(Array.from(newest), ['createdAt', 'DESC']);
  await api.get({}, {}, { Id: 1, role: 'Admin' });
  assert.deepEqual(Array.from(api.order()[0]), ['createdAt', 'DESC']);
});
