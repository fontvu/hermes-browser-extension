import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseColorToHsl,
  stableHue,
  assignRoomIdentities,
  contrastRatio,
} from '../extension/lib/bot-identity.mjs';

const circ = (a, b) => { const d = Math.abs(a - b) % 360; return Math.min(d, 360 - d); };

// --- test-local WCAG helpers ---
function srgb(v) { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }
function luminance([r, g, b]) { return 0.2126 * srgb(r) + 0.7152 * srgb(g) + 0.0722 * srgb(b); }
function ratio(a, b) {
  const x = luminance(a); const y = luminance(b);
  const hi = Math.max(x, y); const lo = Math.min(x, y);
  return (hi + 0.05) / (lo + 0.05);
}
function hslToRgb(h, s, l) {
  s /= 100; l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}
function parseHslString(value) {
  const m = String(value).match(/hsl\(\s*(-?[\d.]+)\s+([\d.]+)%\s+([\d.]+)%/);
  assert.ok(m, `not an hsl string: ${value}`);
  return { h: Number(m[1]), s: Number(m[2]), l: Number(m[3]) };
}
const REF_BG = { dark: [21, 23, 28], light: [255, 255, 255] };

test('parseColorToHsl accepts hex, short hex, rgb, and both hsl forms; rejects garbage', () => {
  assert.deepEqual(parseColorToHsl('#ff0000'), { h: 0, s: 100, l: 50 });
  assert.deepEqual(parseColorToHsl('#f00'), { h: 0, s: 100, l: 50 });
  assert.deepEqual(parseColorToHsl('rgb(255, 0, 0)'), { h: 0, s: 100, l: 50 });
  assert.deepEqual(parseColorToHsl('hsl(180 68% 58%)'), { h: 180, s: 68, l: 58 });
  assert.deepEqual(parseColorToHsl('hsl(180, 68%, 58%)'), { h: 180, s: 68, l: 58 });
  for (const bad of ['banana', '', null, undefined, 'rgb(1,2)', '#12']) {
    assert.equal(parseColorToHsl(bad), null, `bad=${String(bad)}`);
  }
});

test('stableHue is deterministic, in range, and spreads known names', () => {
  const a = stableHue('riku');
  assert.equal(a, stableHue('riku'));
  assert.ok(a >= 0 && a < 360);
  const names = ['riku', 'roxas', 'luxord', 'namine', 'saix'];
  const hues = new Set(names.map(stableHue));
  assert.equal(hues.size, names.length);
});

test('assignRoomIdentities uses the picked hue when present, stableHue when absent', () => {
  const [picked] = assignRoomIdentities([{ profileName: 'Riku', color: '#ff0000' }], { mode: 'dark' });
  assert.equal(picked.hue, 0);
  const [fallback] = assignRoomIdentities([{ profileName: 'Riku', color: 'banana' }], { mode: 'dark' });
  assert.equal(fallback.hue, stableHue('Riku'));
});

test('collision nudge: picked members stay within 40 degrees when a 25-degree gap is reachable', () => {
  const members = [
    { profileName: 'a', color: 'hsl(0 80% 60%)' },
    { profileName: 'b', color: 'hsl(5 80% 60%)' },
    { profileName: 'c', color: 'hsl(10 80% 60%)' },
  ];
  const out = assignRoomIdentities(members, { mode: 'dark' });
  for (let i = 0; i < out.length; i += 1) {
    for (let j = i + 1; j < out.length; j += 1) {
      assert.ok(circ(out[i].hue, out[j].hue) >= 25, `${out[i].hue} vs ${out[j].hue}`);
    }
  }
  const bases = { a: 0, b: 5, c: 10 };
  for (const row of out) {
    assert.ok(circ(row.hue, bases[row.profileName]) <= 40, `${row.profileName} drift ${circ(row.hue, bases[row.profileName])}`);
  }
});

test('collision nudge: 5 hues inside 10 degrees cannot fit in 80 degrees; the algorithm extends drift minimally and deterministically', () => {
  // Documented spec correction: 5 hues pairwise >= 25 degrees need a 100 degree
  // span; a +/-40 degree drift budget only covers 80. Distinct colors win, so the
  // nudge extends a picked member's drift by the smallest amount that still fits.
  const members = [
    { profileName: 'a', color: 'hsl(100 80% 60%)' },
    { profileName: 'b', color: 'hsl(102 80% 60%)' },
    { profileName: 'c', color: 'hsl(104 80% 60%)' },
    { profileName: 'd', color: 'hsl(106 80% 60%)' },
    { profileName: 'e', color: 'hsl(108 80% 60%)' },
  ];
  const out = assignRoomIdentities(members, { mode: 'dark' });
  for (let i = 0; i < out.length; i += 1) {
    for (let j = i + 1; j < out.length; j += 1) {
      assert.ok(circ(out[i].hue, out[j].hue) >= 25, `${out[i].hue} vs ${out[j].hue}`);
    }
  }
  const bases = { a: 100, b: 102, c: 104, d: 106, e: 108 };
  const drifts = out.map((row) => circ(row.hue, bases[row.profileName]));
  assert.ok(drifts.some((d) => d > 40), 'at least one member must exceed the 40 degree budget here');
  assert.ok(Math.max(...drifts) <= 80, 'extension stays bounded');
  const again = assignRoomIdentities(members, { mode: 'dark' });
  assert.deepEqual(again.map((r) => r.hue), out.map((r) => r.hue));
});

test('collision nudge is independent of input order (sorted by profile name first)', () => {
  const members = [
    { profileName: 'b', color: 'hsl(5 80% 60%)' },
    { profileName: 'a', color: 'hsl(0 80% 60%)' },
    { profileName: 'c', color: 'hsl(10 80% 60%)' },
  ];
  const forward = assignRoomIdentities(members, { mode: 'dark' });
  const reversed = assignRoomIdentities([...members].reverse(), { mode: 'dark' });
  const byName = (list) => Object.fromEntries(list.map((r) => [r.profileName, r.hue]));
  assert.deepEqual(byName(forward), byName(reversed));
});

test('contrast clamp: ink meets 4.5:1 against the mode reference for every hue step', () => {
  for (const mode of ['dark', 'light']) {
    const members = [];
    for (let h = 0; h < 360; h += 15) members.push({ profileName: `m${h}`, color: `hsl(${h} 80% 60%)` });
    const out = assignRoomIdentities(members, { mode });
    for (const row of out) {
      const ink = parseHslString(row.ink);
      assert.ok(ratio(hslToRgb(ink.h, ink.s, ink.l), REF_BG[mode]) >= 4.5,
        `${mode} hue ${row.hue} ink ${row.ink} contrast ${ratio(hslToRgb(ink.h, ink.s, ink.l), REF_BG[mode])}`);
    }
  }
});

test('contrastRatio helper matches a known pair', () => {
  assert.ok(Math.abs(contrastRatio([255, 255, 255], [0, 0, 0]) - 21) < 0.01);
});

test('returned shape: profileName, hue, ink, bar (sat>=55), tint hsl strings', () => {
  const out = assignRoomIdentities([{ profileName: 'Riku', color: '#3ba55d' }], { mode: 'dark' });
  const row = out[0];
  assert.deepEqual(Object.keys(row).sort(), ['bar', 'hue', 'ink', 'profileName', 'tint']);
  assert.equal(row.profileName, 'Riku');
  assert.match(row.ink, /^hsl\(\d+ \d+% \d+%\)$/);
  assert.ok(parseHslString(row.bar).s >= 55);
  assert.match(row.tint, /^hsl\(\d+ \d+% \d+%\)$/);
});

test('unknown mode defaults to dark', () => {
  const members = [{ profileName: 'Riku', color: '#3ba55d' }];
  assert.deepEqual(assignRoomIdentities(members, { mode: 'weird' }), assignRoomIdentities(members, { mode: 'dark' }));
});
import { resolveRoomSpeaker } from '../extension/lib/bot-identity.mjs';
test('resolveRoomSpeaker maps legacy label-only rows onto members', () => {
  const members = [{ name: 'default', title: 'Roxas' }, { name: 'riku', title: 'Riku' }, { name: 'namine', title: 'Naminé' }];
  assert.equal(resolveRoomSpeaker({ speaker: 'riku' }, members).name, 'riku');
  assert.equal(resolveRoomSpeaker({ roleLabel: 'Riku' }, members).name, 'riku');
  assert.equal(resolveRoomSpeaker({ roleLabel: 'Roxas' }, members).name, 'default');
  assert.equal(resolveRoomSpeaker({ speaker: 'Roxas' }, members).name, 'default');
  assert.equal(resolveRoomSpeaker({ roleLabel: 'Stranger' }, members), null);
  assert.equal(resolveRoomSpeaker({}, members), null);
});
