const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeCrossProducts } = require('../app/modules/scratchCard/scratchCard.crossProducts');

test('cross products normalize driver JSON strings and numeric IDs', () => {
  const products = [{ Id: 12, name: 'Product' }];
  assert.deepEqual(normalizeCrossProducts(products), products);
  assert.deepEqual(normalizeCrossProducts(JSON.stringify(products)), products);
  assert.deepEqual(normalizeCrossProducts('[{"Id":"12","name":"Product"}]'), products);
});

test('empty, malformed and non-array JSON cannot crash cross product rendering', () => {
  for (const value of [null, undefined, '', 'invalid', 'null', '{}', {}, 1, false]) {
    assert.deepEqual(normalizeCrossProducts(value), []);
  }
  assert.deepEqual(normalizeCrossProducts([null, {}, { Id: 0, name: 'Bad' }, { Id: 1, name: null }]), []);
});
