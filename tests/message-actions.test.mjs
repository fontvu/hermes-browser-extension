import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';

import { buildMessageRail, buildDayDivider, setRailCopyEnabled } from '../extension/lib/message-actions.mjs';

function documentFor() {
  return parseHTML('<!doctype html><html><body></body></html>').document;
}
const TS = new Date(2026, 8, 30, 14, 42, 8).getTime();

test('user rail renders children in order: time, restore, edit, copy', () => {
  const document = documentFor();
  const rail = buildMessageRail({
    document, role: 'user', ts: TS, locale: 'en-US',
    canEdit: true, canRestore: true,
    onCopy: () => true, onEdit: () => {}, onRestore: () => {},
  });
  const kinds = Array.from(rail.children).map((el) => el.className);
  assert.deepEqual(kinds, [
    'message-time',
    'message-action message-action-restore',
    'message-action message-action-edit',
    'message-action message-action-copy',
  ]);
  assert.equal(rail.dataset.role, 'user');
});

test('time node has ISO datetime and a non-empty title', () => {
  const document = documentFor();
  // Pin the clock to the same day as TS: the same-day branch must render the
  // bare time, so the assertion must not depend on the real wall clock.
  const rail = buildMessageRail({ document, role: 'user', ts: TS, now: TS, locale: 'en-US' });
  const time = rail.querySelector('time.message-time');
  assert.ok(time, 'time node present');
  assert.equal(time.getAttribute('datetime'), new Date(TS).toISOString());
  assert.equal(time.dateTime, new Date(TS).toISOString());
  assert.ok(time.getAttribute('title') && time.getAttribute('title').length > 0);
  assert.equal(time.textContent, '2:42 PM');
});

test('ts null renders no time element', () => {
  const document = documentFor();
  const rail = buildMessageRail({ document, role: 'user', ts: null, locale: 'en-US' });
  assert.equal(rail.querySelector('time'), null);
});

test('showTime false renders no time element', () => {
  const document = documentFor();
  const rail = buildMessageRail({ document, role: 'user', ts: TS, showTime: false, locale: 'en-US' });
  assert.equal(rail.querySelector('time'), null);
});

test('assistant rail renders only the copy button even when canEdit is passed true', () => {
  const document = documentFor();
  const rail = buildMessageRail({ document, role: 'assistant', ts: TS, canEdit: true, canRestore: true, locale: 'en-US' });
  assert.equal(rail.querySelectorAll('button').length, 1);
  assert.ok(rail.querySelector('.message-action-copy'));
  assert.equal(rail.querySelector('.message-action-edit'), null);
  assert.equal(rail.querySelector('.message-action-restore'), null);
});

test('every button has type=button, a translated aria-label, and a title', () => {
  const document = documentFor();
  const translate = (s) => `T:${s}`;
  const rail = buildMessageRail({
    document, role: 'user', ts: TS, locale: 'en-US', translate,
    canEdit: true, canRestore: true, onCopy: () => true,
  });
  for (const button of rail.querySelectorAll('button')) {
    assert.equal(button.getAttribute('type'), 'button');
    assert.ok(button.getAttribute('aria-label').startsWith('T:'));
    assert.ok(button.getAttribute('title').startsWith('T:'));
  }
  assert.equal(
    rail.querySelector('.message-action-restore').getAttribute('aria-label'),
    'T:Restore checkpoint: rerun from this prompt',
  );
  assert.equal(rail.querySelector('.message-action-edit').getAttribute('aria-label'), 'T:Edit message');
  assert.equal(rail.querySelector('.message-action-copy').getAttribute('aria-label'), 'T:Copy message');
});

test('copy click: success shows is-copied + Copied, then resets after 1600ms', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const document = documentFor();
  let calls = 0;
  const rail = buildMessageRail({ document, role: 'user', ts: TS, onCopy: () => { calls += 1; return true; } });
  const copy = rail.querySelector('.message-action-copy');
  copy.click();
  assert.equal(calls, 1);
  return Promise.resolve().then(() => {
    assert.ok(copy.classList.contains('is-copied'));
    assert.equal(copy.getAttribute('aria-label'), 'Copied');
    t.mock.timers.tick(1599);
    assert.ok(copy.classList.contains('is-copied'));
    t.mock.timers.tick(1);
    assert.ok(!copy.classList.contains('is-copied'));
    assert.equal(copy.getAttribute('aria-label'), 'Copy message');
    assert.ok(copy.querySelector('svg'));
  });
});

test('copy click: failure shows is-copy-failed + Copy failed', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const document = documentFor();
  const rail = buildMessageRail({ document, role: 'user', ts: TS, onCopy: () => false });
  const copy = rail.querySelector('.message-action-copy');
  copy.click();
  return Promise.resolve().then(() => {
    assert.ok(copy.classList.contains('is-copy-failed'));
    assert.equal(copy.getAttribute('aria-label'), 'Copy failed');
  });
});

test('copy reset race: a stale async result cannot overwrite a newer click state', async () => {
  const document = documentFor();
  let resolveFirst;
  const first = new Promise((resolve) => { resolveFirst = resolve; });
  let call = 0;
  const rail = buildMessageRail({
    document, role: 'user', ts: TS,
    onCopy: () => { call += 1; return call === 1 ? first : Promise.resolve(true); },
  });
  const copy = rail.querySelector('.message-action-copy');
  copy.click();
  copy.click();
  await Promise.resolve();
  assert.ok(copy.classList.contains('is-copied'), 'second click resolved first');
  resolveFirst(false);
  await first;
  await Promise.resolve();
  assert.ok(copy.classList.contains('is-copied'), 'stale failure must not override newer success');
  assert.ok(!copy.classList.contains('is-copy-failed'));
});

test('copy is disabled while streaming via setRailCopyEnabled', () => {
  const document = documentFor();
  const rail = buildMessageRail({ document, role: 'assistant', ts: TS, onCopy: () => true });
  setRailCopyEnabled(rail, false);
  assert.equal(rail.querySelector('.message-action-copy').disabled, true);
  setRailCopyEnabled(rail, true);
  assert.equal(rail.querySelector('.message-action-copy').disabled, false);
});

test('icons are inline SVG with aria-hidden true', () => {
  const document = documentFor();
  const rail = buildMessageRail({ document, role: 'user', ts: TS, canEdit: true, canRestore: true, onCopy: () => true });
  const svgs = rail.querySelectorAll('svg');
  assert.ok(svgs.length >= 3);
  for (const svg of svgs) {
    assert.equal(svg.namespaceURI, 'http://www.w3.org/2000/svg');
    assert.equal(svg.getAttribute('aria-hidden'), 'true');
    assert.ok(svg.querySelector('path'));
  }
});

test('buildDayDivider returns a separator labelled with the text and is not a .message', () => {
  const document = documentFor();
  const divider = buildDayDivider({ document, label: 'Today' });
  assert.equal(divider.className, 'message-day-divider');
  assert.equal(divider.getAttribute('role'), 'separator');
  assert.equal(divider.getAttribute('aria-label'), 'Today');
  assert.ok(!divider.classList.contains('message'));
  const spans = divider.querySelectorAll('.message-day-divider-label');
  assert.equal(spans.length, 1);
  assert.equal(spans[0].textContent, 'Today');
});