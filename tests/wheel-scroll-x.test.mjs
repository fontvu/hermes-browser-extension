import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { handleWheelScrollX, wheelToScrollLeftDelta, bindWheelScrollX } from '../extension/lib/wheel-scroll-x.mjs';

const strip = (over = {}) => ({ scrollLeft: 0, scrollWidth: 1000, clientWidth: 300, ...over });
const wheel = (deltaY, over = {}) => ({ deltaX: 0, deltaY, deltaMode: 0, prevented: false, preventDefault() { this.prevented = true; }, ...over });

test('wheel down scrolls the strip right and wheel up scrolls it left', () => {
  const el = strip({ scrollLeft: 100 });
  const down = wheel(40);
  assert.equal(handleWheelScrollX(down, el), true);
  assert.equal(el.scrollLeft, 140);
  assert.equal(down.prevented, true);
  const up = wheel(-90);
  assert.equal(handleWheelScrollX(up, el), true);
  assert.equal(el.scrollLeft, 50);
});

test('clamps at the ends and lets the page scroll when the strip cannot move', () => {
  const left = strip({ scrollLeft: 0 });
  const up = wheel(-30);
  assert.equal(handleWheelScrollX(up, left), false);
  assert.equal(up.prevented, false);
  const right = strip({ scrollLeft: 700 });
  const down = wheel(30);
  assert.equal(handleWheelScrollX(down, right), false);
  assert.equal(down.prevented, false);
  const nearEnd = strip({ scrollLeft: 690 });
  assert.equal(handleWheelScrollX(wheel(50), nearEnd), true);
  assert.equal(nearEnd.scrollLeft, 700);
});

test('ignores native horizontal gestures, pinch zoom, and strips that do not overflow', () => {
  assert.equal(wheelToScrollLeftDelta({ deltaX: 40, deltaY: 5 }, strip()), 0);
  const el = strip();
  assert.equal(handleWheelScrollX(wheel(30, { ctrlKey: true }), el), false);
  assert.equal(el.scrollLeft, 0);
  const fits = strip({ scrollWidth: 300 });
  assert.equal(handleWheelScrollX(wheel(30), fits), false);
});

test('line and page wheel modes are converted to pixels', () => {
  assert.equal(wheelToScrollLeftDelta({ deltaX: 0, deltaY: 3, deltaMode: 1 }, strip()), 48);
  assert.equal(wheelToScrollLeftDelta({ deltaX: 0, deltaY: 1, deltaMode: 2 }, strip()), 300);
});

test('bindWheelScrollX registers a non-passive wheel listener and can unbind', () => {
  const calls = [];
  const el = { addEventListener: (...a) => calls.push(['add', ...a]), removeEventListener: (...a) => calls.push(['remove', ...a]) };
  const off = bindWheelScrollX(el);
  assert.equal(calls[0][1], 'wheel');
  assert.deepEqual(calls[0][3], { passive: false });
  off();
  assert.equal(calls[1][0], 'remove');
});

test('the model provider strip is wired to wheel scrolling', () => {
  const panel = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
  assert.match(panel, /bindWheelScrollX\(els\.modelProviderList\)/);
});
