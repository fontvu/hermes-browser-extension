import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createPresenceState,
  reducePresence,
  presenceSummary,
  failureReason,
} from '../extension/lib/group-presence.mjs';

const entry = (state, name) => state.members.find((m) => m.member === name);

test('createPresenceState: empty idle state', () => {
  assert.deepEqual(createPresenceState(), { members: [], order: [], phase: 'idle' });
});

test('turn_start creates every member queued in order and flips phase to running', () => {
  const s = reducePresence(createPresenceState(), {
    kind: 'turn_start',
    members: [{ member: 'Roxas', roleLabel: 'Roxas' }, { member: 'Luxord', roleLabel: 'Luxord' }],
  }, { now: 1 });
  assert.equal(s.phase, 'running');
  assert.deepEqual(s.order, ['Roxas', 'Luxord']);
  assert.deepEqual(s.members.map((m) => m.state), ['queued', 'queued']);
  assert.equal(entry(s, 'Luxord').roleLabel, 'Luxord');
});

test('working, typing, tool_start, tool_complete transition the member', () => {
  let s = reducePresence(createPresenceState(), {
    kind: 'turn_start', members: [{ member: 'Roxas' }],
  }, { now: 1 });
  s = reducePresence(s, { kind: 'working', member: 'Roxas' }, { now: 2 });
  assert.equal(entry(s, 'Roxas').state, 'working');
  s = reducePresence(s, { kind: 'typing', member: 'Roxas', text: 'hel' }, { now: 3 });
  assert.equal(entry(s, 'Roxas').state, 'typing');
  assert.equal(entry(s, 'Roxas').text, 'hel');
  s = reducePresence(s, { kind: 'tool_start', member: 'Roxas', tool: 'web_search' }, { now: 4 });
  assert.equal(entry(s, 'Roxas').state, 'tool');
  assert.equal(entry(s, 'Roxas').tool, 'web_search');
  s = reducePresence(s, { kind: 'tool_complete', member: 'Roxas', tool: 'web_search' }, { now: 5 });
  assert.equal(entry(s, 'Roxas').state, 'typing');
});

test('tool_complete returns to working when the member never produced text', () => {
  let s = reducePresence(createPresenceState(), { kind: 'turn_start', members: [{ member: 'X' }] }, { now: 1 });
  s = reducePresence(s, { kind: 'working', member: 'X' }, { now: 2 });
  s = reducePresence(s, { kind: 'tool_start', member: 'X', tool: 't' }, { now: 3 });
  s = reducePresence(s, { kind: 'tool_complete', member: 'X' }, { now: 4 });
  assert.equal(entry(s, 'X').state, 'working');
});

test('reply clears text; pass and failed record terminal state', () => {
  let s = reducePresence(createPresenceState(), {
    kind: 'turn_start', members: [{ member: 'A' }, { member: 'B' }, { member: 'C' }],
  }, { now: 1 });
  s = reducePresence(s, { kind: 'typing', member: 'A', text: 'hi' }, { now: 2 });
  s = reducePresence(s, { kind: 'reply', member: 'A' }, { now: 3 });
  assert.equal(entry(s, 'A').state, 'replied');
  assert.equal(entry(s, 'A').text, '');
  s = reducePresence(s, { kind: 'pass', member: 'B' }, { now: 4 });
  assert.equal(entry(s, 'B').state, 'passed');
  s = reducePresence(s, { kind: 'failed', member: 'C', error: 'boom' }, { now: 5 });
  assert.equal(entry(s, 'C').state, 'failed');
  assert.equal(entry(s, 'C').error, 'boom');
});

test('idle marks the phase done and keeps final member states', () => {
  let s = reducePresence(createPresenceState(), { kind: 'turn_start', members: [{ member: 'A' }] }, { now: 1 });
  s = reducePresence(s, { kind: 'reply', member: 'A' }, { now: 2 });
  s = reducePresence(s, { kind: 'idle' }, { now: 3 });
  assert.equal(s.phase, 'done');
  assert.equal(entry(s, 'A').state, 'replied');
});

test('an event for an unknown member adds it on the fly as working', () => {
  const s = reducePresence(createPresenceState(), { kind: 'working', member: 'Ghost', roleLabel: 'Ghost' }, { now: 1 });
  assert.equal(entry(s, 'Ghost').state, 'working');
  assert.equal(s.phase, 'running');
  assert.deepEqual(s.order, ['Ghost']);
});

test('a late typing event does not resurrect a replied member', () => {
  let s = reducePresence(createPresenceState(), { kind: 'turn_start', members: [{ member: 'A' }] }, { now: 1 });
  s = reducePresence(s, { kind: 'reply', member: 'A' }, { now: 2 });
  s = reducePresence(s, { kind: 'typing', member: 'A', text: 'late' }, { now: 3 });
  assert.equal(entry(s, 'A').state, 'replied');
  assert.equal(entry(s, 'A').text, '');
});

test('presenceSummary reports the active member and the waiting count', () => {
  let s = reducePresence(createPresenceState(), {
    kind: 'turn_start', members: [{ member: 'Luxord' }, { member: 'A' }, { member: 'B' }, { member: 'C' }],
  }, { now: 1 });
  s = reducePresence(s, { kind: 'typing', member: 'Luxord', text: 'hey' }, { now: 2 });
  assert.equal(presenceSummary(s, {}), 'Luxord is typing · 3 waiting');

  let t = reducePresence(createPresenceState(), {
    kind: 'turn_start', members: [{ member: 'Luxord' }, { member: 'A' }, { member: 'B' }],
  }, { now: 1 });
  t = reducePresence(t, { kind: 'tool_start', member: 'Luxord', tool: 'web_search' }, { now: 2 });
  assert.equal(presenceSummary(t, {}), 'Luxord is using web_search · 2 waiting');
});

test('presenceSummary reports the terminal outcome', () => {
  const base = () => reducePresence(createPresenceState(), {
    kind: 'turn_start', members: [{ member: 'A' }, { member: 'B' }],
  }, { now: 1 });
  let allReplied = reducePresence(base(), { kind: 'reply', member: 'A' }, { now: 2 });
  allReplied = reducePresence(allReplied, { kind: 'reply', member: 'B' }, { now: 3 });
  allReplied = reducePresence(allReplied, { kind: 'idle' }, { now: 4 });
  assert.equal(presenceSummary(allReplied, {}), 'All replied');

  let withPass = reducePresence(base(), { kind: 'reply', member: 'A' }, { now: 2 });
  withPass = reducePresence(withPass, { kind: 'pass', member: 'B' }, { now: 3 });
  assert.equal(presenceSummary(withPass, {}), 'All done · 1 passed');

  let withFail = reducePresence(base(), { kind: 'reply', member: 'A' }, { now: 2 });
  withFail = reducePresence(withFail, { kind: 'failed', member: 'B', error: 'x' }, { now: 3 });
  assert.equal(presenceSummary(withFail, {}), "1 replied, 1 couldn't");
});

test('failureReason maps usage and rate limit signals to one actionable line', () => {
  for (const raw of [
    'HTTP 429 Too Many Requests',
    'rate limit exceeded',
    'usage_limit_reached',
    'quota exhausted',
    'status 402',
    'insufficient credits',
  ]) {
    assert.equal(failureReason(raw), 'Usage limit reached, try again later', raw);
  }
});

test('failureReason falls back to a generic line and stays translatable', () => {
  assert.equal(failureReason(''), 'Something went wrong');
  assert.equal(failureReason('socket closed unexpectedly'), 'Something went wrong');
  const translate = (tpl) => `[${tpl}]`;
  assert.equal(failureReason('429', { translate }), '[Usage limit reached, try again later]');
  assert.equal(failureReason('boom', { translate }), '[Something went wrong]');
});

test('presenceSummary is translatable via injected translate', () => {
  let s = reducePresence(createPresenceState(), { kind: 'turn_start', members: [{ member: 'Luxord' }] }, { now: 1 });
  s = reducePresence(s, { kind: 'typing', member: 'Luxord' }, { now: 2 });
  const translate = (tpl) => `[${tpl}]`;
  assert.equal(presenceSummary(s, { translate }), '[Luxord is typing]');
});

test('reducePresence never mutates the input state', () => {
  const before = reducePresence(createPresenceState(), {
    kind: 'turn_start', members: [{ member: 'A' }],
  }, { now: 1 });
  const snapshot = JSON.parse(JSON.stringify(before));
  reducePresence(before, { kind: 'typing', member: 'A', text: 'x' }, { now: 2 });
  assert.deepEqual(before, snapshot);
});

test('retry reopens only the failed member and clears its reason', () => {
  let s = reducePresence(createPresenceState(), {
    kind: 'turn_start', members: [{ member: 'A' }, { member: 'B' }, { member: 'C' }],
  }, { now: 1 });
  s = reducePresence(s, { kind: 'reply', member: 'A' }, { now: 2 });
  s = reducePresence(s, { kind: 'failed', member: 'B', error: 'boom' }, { now: 3 });
  s = reducePresence(s, { kind: 'failed', member: 'C', error: 'crash' }, { now: 4 });
  s = reducePresence(s, { kind: 'idle' }, { now: 5 });
  assert.equal(s.phase, 'done');

  s = reducePresence(s, { kind: 'retry', member: 'B' }, { now: 6 });
  assert.equal(s.phase, 'running', 'a retry reopens the running phase');
  assert.equal(entry(s, 'B').state, 'queued');
  assert.equal(entry(s, 'B').error, '', 'the stale reason is cleared');
  assert.equal(entry(s, 'A').state, 'replied', 'other terminal members are untouched');
  assert.equal(entry(s, 'C').state, 'failed', 'another failed member is untouched');
  assert.deepEqual(s.order, ['A', 'B', 'C'], 'room order is preserved');
});

test('retry lets a queued member accept the following working frame', () => {
  let s = reducePresence(createPresenceState(), {
    kind: 'turn_start', members: [{ member: 'A' }, { member: 'B' }],
  }, { now: 1 });
  s = reducePresence(s, { kind: 'failed', member: 'A', error: 'boom' }, { now: 2 });
  s = reducePresence(s, { kind: 'retry', member: 'A' }, { now: 3 });
  s = reducePresence(s, { kind: 'working', member: 'A' }, { now: 4 });
  assert.equal(entry(s, 'A').state, 'working', 'the retried member moves off failed');
});