// Issue #106: the "What Hermes saw" receipt must report the tab count that
// actually crosses the BCP v2 budget, not the raw selection count. When the
// user has more tabs selected than the turn budget allows, the receipt reads
// "12 of 20" instead of a number that was never sent.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BROWSER_CONTEXT_TURN_BUDGETS,
  buildBrowserContextReceipt,
} from '../extension/lib/browser-context-protocol.mjs';

const BASE_SETTINGS = {
  includeTabs: true,
  includePageText: true,
  includeSelectedText: true,
};

function receiptForTabCount(count) {
  const tabs = Array.from({ length: count }, (_, index) => ({ id: index + 1, title: `Tab ${index + 1}`, url: `https://example.com/${index + 1}` }));
  return buildBrowserContextReceipt({
    context: {
      activeTab: tabs[0],
      tabs,
      selectedTabs: tabs,
      contextScope: { mode: 'follow-active' },
      pageContext: { meta: {} },
    },
    settings: BASE_SETTINGS,
  });
}

function tabsSentValue(receipt) {
  return receipt.items.find((item) => item.label === 'Tabs sent to Hermes').value;
}

test('receipt reports delivered-of-total when tabs exceed the turn budget', () => {
  const over = BROWSER_CONTEXT_TURN_BUDGETS.maxTabs + 5;
  const receipt = receiptForTabCount(over);
  assert.equal(tabsSentValue(receipt), `${BROWSER_CONTEXT_TURN_BUDGETS.maxTabs} of ${over}`);
});

test('receipt reports a plain count when tabs are within budget', () => {
  const receipt = receiptForTabCount(3);
  assert.equal(tabsSentValue(receipt), '3');
});

test('receipt reports exactly the budget at the boundary', () => {
  const receipt = receiptForTabCount(BROWSER_CONTEXT_TURN_BUDGETS.maxTabs);
  assert.equal(tabsSentValue(receipt), String(BROWSER_CONTEXT_TURN_BUDGETS.maxTabs));
});

test('receipt still reports disabled when tabs are turned off', () => {
  const receipt = buildBrowserContextReceipt({
    context: { tabs: [], selectedTabs: [], contextScope: { mode: 'follow-active' }, pageContext: { meta: {} } },
    settings: { ...BASE_SETTINGS, includeTabs: false },
  });
  assert.equal(tabsSentValue(receipt), 'disabled');
});

test('receipt keeps the open-tab window count untruncated', () => {
  const over = BROWSER_CONTEXT_TURN_BUDGETS.maxTabs + 5;
  const receipt = receiptForTabCount(over);
  assert.equal(receipt.items.find((item) => item.label === 'Open tabs in window').value, String(over));
});
