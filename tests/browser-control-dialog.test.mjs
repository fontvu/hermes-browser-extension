import assert from 'node:assert/strict';
import test from 'node:test';
import { parseHTML } from 'linkedom';
import { createBrowserControlDialog } from '../extension/lib/browser-control-dialog.mjs';

function fixture() {
  const { document } = parseHTML('<html><body><button id="launch"></button><dialog><button id="close"></button><select id="scope"><option value="this-tab">This tab</option><option value="selected-tabs">Selected tabs</option><option value="task-set">Task set</option></select><fieldset id="tabs"><div id="list"></div></fieldset><button id="apply"></button><small id="hint"></small></dialog></body></html>');
  const dialog = document.querySelector('dialog');
  dialog.showModal = () => { dialog.open = true; };
  dialog.close = () => { dialog.open = false; dialog.dispatchEvent(new document.defaultView.Event('close')); };
  const calls = [];
  const byId = id => document.getElementById(id);
  // linkedom exposes a getter-only select.value; provide the browser setter contract.
  Object.defineProperty(byId('scope'), 'value', { value: 'this-tab', writable: true });
  const ui = createBrowserControlDialog({ dialog, launcher: byId('launch'), closeButton: byId('close'), focusFallback: null,
    label: () => 'Hermes Control', refresh: () => {},
    scopeInput: byId('scope'), tabsField: byId('tabs'), tabsList: byId('list'), applyButton: byId('apply'), scopeHint: byId('hint'),
    getScope: () => 'this-tab', getSelectedTabIds: () => [10], translate: key => key,
    loadTabs: async () => [{ id: 10, title: 'First', url: 'https://example.test/1' }, { id: 12, title: 'Second', url: 'https://example.test/2' }, { id: 14, title: 'Settings', url: 'chrome://settings/' }],
    applyScope: async value => { calls.push(value); },
  });
  const render = (state = 'ready', canChangeScope = true) => ui.render({ enabled: true, view: { state, tone: 'ok', title: state, detail: '' }, canChangeScope });
  return { document, dialog, ui, byId, calls, render };
}
const settle = async () => { await new Promise(resolve => setTimeout(resolve, 0)); };

test('dialog permits explicit multi-tab selection and apply without leaving the menu', async () => {
  const f = fixture(); f.render(); f.byId('launch').click(); await settle();
  f.byId('scope').value = 'selected-tabs';
  f.byId('scope').dispatchEvent(new f.document.defaultView.Event('change'));
  assert.equal(f.byId('tabs').hidden, false);
  const boxes = [...f.byId('list').querySelectorAll('input')];
  assert.equal(boxes.length, 2, 'restricted pages are not offered');
  boxes[1].checked = true;
  boxes[1].dispatchEvent(new f.document.defaultView.Event('change'));
  f.byId('apply').click(); await settle();
  assert.deepEqual(f.calls, [{ scope: 'selected-tabs', tabIds: [10, 12] }]);
  assert.equal(f.dialog.open, true);
});

test('poll rendering does not erase an uncommitted scope draft', async () => {
  const f = fixture(); f.render(); f.byId('launch').click(); await settle();
  f.byId('scope').value = 'task-set';
  f.byId('scope').dispatchEvent(new f.document.defaultView.Event('change'));
  f.render();
  assert.equal(f.byId('scope').value, 'task-set');
});

test('busy authority disables the visible scope input and apply control', async () => {
  const f = fixture(); f.render('active', false); f.byId('launch').click(); await settle();
  assert.equal(f.byId('scope').disabled, true);
  assert.equal(f.byId('apply').disabled, true);
});

test('dialog flair arms on activation but does not restart on each status poll', async () => {
  const f = fixture(); f.render();
  const event = new f.document.defaultView.Event('click'); event.detail = 1;
  f.byId('launch').dispatchEvent(event); await settle();
  assert.equal(f.dialog.classList.contains('is-energized'), true);
  f.dialog.classList.remove('is-energized');
  f.render();
  assert.equal(f.dialog.classList.contains('is-energized'), false);
});
