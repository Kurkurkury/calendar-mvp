import test from 'node:test';
import assert from 'node:assert/strict';
import { parseExpenseText } from './expense-import.js';

test('keeps items without price', () => {
  const out = parseExpenseText('Banane\nMilch 2L 3.20 CHF');
  assert.equal(out.parsedItems.length >= 2, true);
  assert.equal(out.parsedItems[0].price, null);
});

test('total-only creates fallback item', () => {
  const out = parseExpenseText('SUMME CHF 42.50');
  assert.equal(out.total, 42.5);
  assert.equal(out.parsedItems[0].normalizedName, 'Einkauf (Total)');
});

test('price-only creates placeholders', () => {
  const out = parseExpenseText('1.20\n3.50');
  assert.equal(out.parsedItems[0].normalizedName, 'Unbekannt 1');
  assert.equal(out.parsedItems[1].price, 3.5);
});
