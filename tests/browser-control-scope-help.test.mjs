import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { mountBrandedSelect } from '../extension/lib/branded-select.mjs';
import { createBrowserControlDialog } from '../extension/lib/browser-control-dialog.mjs';
import en from '../extension/lib/locales/en.mjs';

const html = await readFile(new URL('../extension/sidepanel.html', import.meta.url), 'utf8');

function fixture() {
  const dom = new JSDOM(html, { pretendToBeVisual: true });
  const { document } = dom.window;
  const originals = Object.fromEntries(['document', 'MutationObserver', 'Event', 'window'].map(key => [key, globalThis[key]]));
  Object.assign(globalThis, { document, MutationObserver: dom.window.MutationObserver, Event: dom.window.Event, window: dom.window });
  const byId = id => document.getElementById(id);
  const dialog = byId('browserControlDialog');
  dialog.showModal = () => { dialog.open = true; };
  dialog.close = () => { dialog.open = false; dialog.dispatchEvent(new dom.window.Event('close')); };
  const tooltip = byId('browserControlTooltip');
  let helpOpen = false;
  tooltip.matches = selector => selector === ':popover-open' && helpOpen;
  tooltip.showPopover = () => { helpOpen = true; };
  tooltip.hidePopover = () => { helpOpen = false; };
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  const select = byId('browserControlDialogScopeInput');
  for (const option of select.options) option.title = en[option.dataset.i18nTitle] || '';
  mountBrandedSelect(select);
  const ui = createBrowserControlDialog({ dialog, launcher: byId('browserControlMenuButton'), closeButton: byId('browserControlDismissButton'),
    label: () => 'Hermes Control', refresh: () => {}, translate: key => en[key] || key,
    scopeInput: select, tabsField: byId('browserControlDialogTabs'), tabsList: byId('browserControlDialogTabList'),
    applyButton: byId('browserControlDialogApplyScope'), scopeHint: byId('browserControlDialogScopeHint'),
    getScope: () => 'this-tab', getSelectedTabIds: () => [], loadTabs: async () => [], applyScope: async () => {},
  });
  const render = () => ui.render({ enabled: true, view: { state: 'ready', tone: 'ok', title: 'Ready', detail: '' }, canChangeScope: true });
  render();
  byId('browserControlMenuButton').click();
  // The asynchronous tab load has its own tests; keep this help fixture enabled.
  select.disabled = false; select.brandedSelect.sync();
  byId('browserControlDialogScopeInputButton').click();
  return { dom, document, select, tooltip, render, helpOpen: () => helpOpen, cleanup() {
    dom.window.close();
    for (const [key, value] of Object.entries(originals)) {
      if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
    }
  } };
}

for (const value of ['this-tab', 'selected-tabs', 'task-set']) {
  test(`scope ${value} has localized hover and focus help that survives polling`, () => {
    const f = fixture();
    try {
      const item = f.document.querySelector(`#browserControlDialogScopeInputList [data-value="${value}"]`);
      const key = `browser_control.help_scope_${value.replaceAll('-', '_')}`;
      assert.ok(en[key], 'canonical explanation exists');
      const picker = item.closest('.branded-select');
      picker.getBoundingClientRect = () => ({ left: 20, width: 300, top: 300, bottom: 344 });
      item.getBoundingClientRect = () => ({ left: 20, width: 300, top: 400, bottom: 436 });
      f.tooltip.getBoundingClientRect = () => ({ width: 280, height: 80 });
      item.dispatchEvent(new f.dom.window.MouseEvent('pointerover', { bubbles: true }));
      assert.equal(f.tooltip.textContent, en[key]);
      assert.equal(f.helpOpen(), true);
      assert.equal(f.tooltip.style.top, '210px', 'scope help stays above the entire picker, not across its options');
      assert.equal(item.getAttribute('aria-describedby'), f.tooltip.id);
      f.render();
      assert.equal(f.tooltip.textContent, en[key], 'poll must not erase generated option help');
      item.dispatchEvent(new f.dom.window.MouseEvent('pointerout', { bubbles: true }));
      assert.equal(f.helpOpen(), false);
      item.focus();
      assert.equal(f.tooltip.textContent, en[key]);
      assert.equal(f.helpOpen(), true);
      item.click();
      assert.equal(f.helpOpen(), false, 'hidden option must not leave a floating tooltip');
      assert.equal(f.select.value, value);
    } finally { f.cleanup(); }
  });
}

test('scope help describes explicit boundaries and distinguishes a shared task', () => {
  assert.match(en['browser_control.help_scope_this_tab'] || '', /only.*current tab/i);
  assert.match(en['browser_control.help_scope_selected_tabs'] || '', /only.*choose/i);
  assert.match(en['browser_control.help_scope_task_set'] || '', /shared.*task/i);
  assert.match(en['browser_control.help_scope_task_set'] || '', /only.*choose/i);
});

test('ordinary branded menus do not acquire control-specific help', () => {
  const dom = new JSDOM('<select id="ordinary"><option value="one">One</option></select>');
  const originals = Object.fromEntries(['document', 'MutationObserver'].map(key => [key, globalThis[key]]));
  Object.assign(globalThis, { document: dom.window.document, MutationObserver: dom.window.MutationObserver });
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  try {
    mountBrandedSelect(dom.window.document.querySelector('select'));
    dom.window.document.querySelector('button').click();
    assert.equal(dom.window.document.querySelector('[role="option"]').hasAttribute('data-control-help'), false);
  } finally {
    dom.window.close();
    for (const [key, value] of Object.entries(originals)) {
      if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
    }
  }
});
