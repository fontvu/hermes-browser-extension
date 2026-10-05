import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeMessageTimestamp,
  formatMessageTime,
  formatMessageTimeFull,
  dayKey,
  dayDividerLabel,
  decideRailPlacement,
} from '../extension/lib/message-meta.mjs';

// Fixed local reference: Wed Sep 30 2026 14:42:08 local time.
const NOW = new Date(2026, 8, 30, 14, 42, 8).getTime();
const at = (y, m, d, h = 12, min = 0) => new Date(y, m - 1, d, h, min).getTime();

test('normalize: milliseconds pass through', () => {
  assert.equal(normalizeMessageTimestamp(NOW), NOW);
});
test('normalize: unix seconds become milliseconds', () => {
  assert.equal(normalizeMessageTimestamp(Math.floor(NOW / 1000)), Math.floor(NOW / 1000) * 1000);
});
test('normalize: numeric strings accepted', () => {
  assert.equal(normalizeMessageTimestamp(String(NOW)), NOW);
});
test('normalize: invalid values return null, never now', () => {
  for (const bad of [0, -5, NaN, Infinity, '', null, undefined, 'abc', {}, [], true]) {
    assert.equal(normalizeMessageTimestamp(bad), null, `bad=${String(bad)}`);
  }
});
test('normalize: before 2000 or more than 1 day in the future returns null', () => {
  assert.equal(normalizeMessageTimestamp(new Date(1999, 0, 1).getTime()), null);
  assert.equal(normalizeMessageTimestamp(NOW + 2 * 86400000, { now: NOW }), null);
});

test('format: same day shows time only', () => {
  assert.equal(formatMessageTime(at(2026, 9, 30, 9, 5), { now: NOW, locale: 'en-US' }), '9:05 AM');
});
test('format: within 6 days shows short weekday and time', () => {
  assert.equal(formatMessageTime(at(2026, 9, 28, 18, 32), { now: NOW, locale: 'en-US' }), 'Mon 6:32 PM');
});
test('format: older this year shows month and day', () => {
  assert.equal(formatMessageTime(at(2026, 9, 12, 14, 42), { now: NOW, locale: 'en-US' }), 'Sep 12, 2:42 PM');
});
test('format: other year adds the year', () => {
  assert.equal(formatMessageTime(at(2025, 9, 12, 14, 42), { now: NOW, locale: 'en-US' }), 'Sep 12, 2025, 2:42 PM');
});
test('format: 24 hour locale', () => {
  assert.equal(formatMessageTime(at(2026, 9, 30, 14, 42), { now: NOW, locale: 'de-DE' }), '14:42');
});
test('format: invalid returns empty string', () => {
  assert.equal(formatMessageTime(null, { now: NOW, locale: 'en-US' }), '');
});
test('full format includes seconds and weekday', () => {
  const full = formatMessageTimeFull(at(2026, 9, 30, 14, 42) + 8000, { locale: 'en-US' });
  assert.match(full, /Wednesday|Tuesday|Monday|Thursday|Friday|Saturday|Sunday/);
  assert.match(full, /2:42:08/);
});

test('dayKey is the local calendar day', () => {
  assert.equal(dayKey(at(2026, 9, 30, 0, 1)), dayKey(at(2026, 9, 30, 23, 59)));
  assert.notEqual(dayKey(at(2026, 9, 29, 23, 59)), dayKey(at(2026, 9, 30, 0, 0)));
});

test('divider: first known message gets a label', () => {
  assert.equal(dayDividerLabel(at(2026, 9, 30), null, { now: NOW, locale: 'en-US' }), 'Today');
});
test('divider: same day as previous returns empty', () => {
  assert.equal(dayDividerLabel(at(2026, 9, 30, 15), at(2026, 9, 30, 9), { now: NOW, locale: 'en-US' }), '');
});
test('divider: midnight boundary', () => {
  assert.equal(dayDividerLabel(at(2026, 9, 30, 0, 0), at(2026, 9, 29, 23, 59), { now: NOW, locale: 'en-US' }), 'Today');
});
test('divider: yesterday, weekday, older, other year', () => {
  const o = { now: NOW, locale: 'en-US' };
  assert.equal(dayDividerLabel(at(2026, 9, 29), at(2026, 9, 20), o), 'Yesterday');
  assert.equal(dayDividerLabel(at(2026, 9, 25), at(2026, 9, 20), o), 'Friday');
  assert.equal(dayDividerLabel(at(2026, 9, 12), at(2026, 9, 1), o), 'Sep 12');
  assert.equal(dayDividerLabel(at(2025, 12, 31), at(2025, 12, 1), o), 'Dec 31, 2025');
});
test('divider: 6 day edge is a weekday, 7 days is a date', () => {
  const o = { now: NOW, locale: 'en-US' };
  assert.equal(dayDividerLabel(at(2026, 9, 24), null, o), 'Thursday');
  assert.equal(dayDividerLabel(at(2026, 9, 23), null, o), 'Sep 23');
});
test('divider: unknown timestamp returns empty', () => {
  assert.equal(dayDividerLabel(null, at(2026, 9, 29), { now: NOW, locale: 'en-US' }), '');
});
test('divider: labels are translatable via injected translate', () => {
  const o = { now: NOW, locale: 'es-ES', translate: (s) => ({ Today: 'Hoy', Yesterday: 'Ayer' }[s] || s) };
  assert.equal(dayDividerLabel(at(2026, 9, 30), null, o), 'Hoy');
});

test('placement: fits on the left', () => {
  assert.equal(decideRailPlacement({ rowWidth: 460, bubbleWidth: 200, railWidth: 150 }), 'left');
});
test('placement: does not fit goes below', () => {
  assert.equal(decideRailPlacement({ rowWidth: 460, bubbleWidth: 400, railWidth: 150 }), 'below');
});
test('placement: hysteresis keeps previous state near the threshold', () => {
  // free = 460 - 290 = 170; need = 150 + 8 gap + 8 safety = 166; hysteresis 8
  assert.equal(decideRailPlacement({ rowWidth: 460, bubbleWidth: 290, railWidth: 150, previous: 'below' }), 'below');
  assert.equal(decideRailPlacement({ rowWidth: 460, bubbleWidth: 290, railWidth: 150, previous: 'left' }), 'left');
  assert.equal(decideRailPlacement({ rowWidth: 460, bubbleWidth: 280, railWidth: 150, previous: 'below' }), 'left');
});
test('placement: zero or missing widths default to below', () => {
  assert.equal(decideRailPlacement({ rowWidth: 0, bubbleWidth: 0, railWidth: 0 }), 'below');
  assert.equal(decideRailPlacement({}), 'below');
});