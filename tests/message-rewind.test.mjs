import test from 'node:test';
import assert from 'node:assert/strict';

import {
  truncateSubmitParams,
  resolveRowIdByDisplayText,
  planEdit,
  planRestore,
  applyRewindLocally,
  rebindSurvivorRowIds,
  bindRowIdsFromHistory,
} from '../extension/lib/message-rewind.mjs';

const stripCtx = (role, content) => String(content).replace(/ ctx$/, '');

test('truncateSubmitParams: a valid integer row id builds the confirm-truncate params', () => {
  assert.deepEqual(truncateSubmitParams({ rowId: 42 }), {
    confirm_truncate: true,
    truncate_before_row_id: 42,
    confirm_empty_truncate: true,
  });
});

test('truncateSubmitParams: no address means no truncation', () => {
  assert.deepEqual(truncateSubmitParams({}), {});
});

test('truncateSubmitParams: non-integer, string, or negative row ids are refused', () => {
  assert.deepEqual(truncateSubmitParams({ rowId: 4.2 }), {});
  assert.deepEqual(truncateSubmitParams({ rowId: '42' }), {});
  assert.deepEqual(truncateSubmitParams({ rowId: -1 }), {});
  assert.deepEqual(truncateSubmitParams({ rowId: 0 }), {});
  assert.deepEqual(truncateSubmitParams({ rowId: NaN }), {});
});

test('resolveRowIdByDisplayText: unique user match resolves; other roles and display rows ignored', () => {
  const history = [
    { role: 'user', content: 'hello ctx', row_id: 5 },
    { role: 'assistant', content: 'hello ctx', row_id: 6 },
    { role: 'user', content: 'steered ctx', row_id: 7, display_kind: 'steer' },
    { role: 'user', content: 'bad id ctx', row_id: '9' },
  ];
  assert.equal(resolveRowIdByDisplayText(history, 'hello', { displayText: stripCtx }), 5);
  assert.equal(resolveRowIdByDisplayText(history, 'steered', { displayText: stripCtx }), undefined);
  assert.equal(resolveRowIdByDisplayText(history, 'bad id', { displayText: stripCtx }), undefined);
});

test('resolveRowIdByDisplayText: duplicate matches fail closed unless isNewest targets the tail', () => {
  const history = [
    { role: 'user', content: 'dup ctx', row_id: 10 },
    { role: 'user', content: 'dup ctx', row_id: 11 },
    { role: 'user', content: 'tail ctx', row_id: 12 },
  ];
  assert.equal(resolveRowIdByDisplayText(history, 'dup', { displayText: stripCtx }), undefined);
  assert.equal(resolveRowIdByDisplayText(history, 'tail', { displayText: stripCtx }), 12);

  const tailDup = [
    { role: 'user', content: 'a ctx', row_id: 1 },
    { role: 'user', content: 'b ctx', row_id: 2 },
    { role: 'user', content: 'b ctx', row_id: 3 },
  ];
  assert.equal(resolveRowIdByDisplayText(tailDup, 'b', { displayText: stripCtx }), undefined);
  assert.equal(resolveRowIdByDisplayText(tailDup, 'b', { displayText: stripCtx, isNewest: true }), 3);
});

test('resolveRowIdByDisplayText: empty or whitespace text never resolves', () => {
  const history = [{ role: 'user', content: 'x ctx', row_id: 1 }];
  assert.equal(resolveRowIdByDisplayText(history, '', { displayText: stripCtx }), undefined);
  assert.equal(resolveRowIdByDisplayText(history, '   ', { displayText: stripCtx }), undefined);
});

test('planEdit: only a changed user record produces a plan', () => {
  const records = [
    { role: 'user', content: 'first', rowId: 1 },
    { role: 'assistant', content: 'reply', rowId: 2 },
    { role: 'user', content: 'second', rowId: 3 },
  ];
  assert.equal(planEdit(records, 1, 'x'), null);
  assert.equal(planEdit(records, 2, '   '), null);
  assert.equal(planEdit(records, 2, ' second '), null);
  assert.equal(planEdit(records, 99, 'x'), null);
  assert.deepEqual(planEdit(records, 2, '  edited  '), {
    sourceIndex: 2, sourceText: 'second', text: 'edited', rowId: 3,
  });
  assert.deepEqual(planEdit([{ role: 'user', content: 'hi' }], 0, 'new'), {
    sourceIndex: 0, sourceText: 'hi', text: 'new', rowId: undefined,
  });
});

test('planRestore: user records only, throws on empty or non-user', () => {
  const records = [
    { role: 'user', content: 'first', rowId: 1 },
    { role: 'assistant', content: 'reply', rowId: 2 },
    { role: 'user', content: 'second', rowId: 3 },
  ];
  assert.deepEqual(planRestore(records, 2), {
    sourceIndex: 2, sourceText: 'second', text: 'second', rowId: 3,
  });
  assert.throws(() => planRestore(records, 1));
  assert.throws(() => planRestore(records, 99));
  assert.throws(() => planRestore([], 0));
});

test('applyRewindLocally: keeps prefix + edited source, drops the tail, input untouched', () => {
  const records = [
    { role: 'user', content: 'a', rowId: 1, ts: 111 },
    { role: 'assistant', content: 'b', rowId: 2, ts: 222 },
    { role: 'user', content: 'c', rowId: 3, ts: 333 },
  ];
  const out = applyRewindLocally(records, 1, 'edited', { now: 999 });
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], { role: 'user', content: 'a', rowId: 1, ts: 111 });
  assert.deepEqual(out[1], { role: 'assistant', content: 'edited', ts: 999, rowId: undefined });
  assert.equal(records.length, 3);
  assert.equal(records[1].content, 'b');
  assert.equal(records[1].ts, 222);

  const out2 = applyRewindLocally(records, 1, undefined, { now: 1000 });
  assert.equal(out2[1].content, 'b');
  assert.equal(out2[1].ts, 1000);
  assert.equal(out2[1].rowId, undefined);
});

test('rebindSurvivorRowIds: map rebinds, clears, and leaves unknown records alone', () => {
  const records = [
    { role: 'user', content: 'a', rowId: 10 },
    { role: 'assistant', content: 'b', rowId: 11 },
    { role: 'user', content: 'c', rowId: 12 },
  ];
  const out = rebindSurvivorRowIds(records, { survivor_row_id_map: { 10: 55, 11: null } });
  assert.equal(out[0].rowId, 55);
  assert.equal('rowId' in out[1], false);
  assert.equal(out[2].rowId, 12);
  assert.equal(records[0].rowId, 10);

  const out2 = rebindSurvivorRowIds(records, { survivor_user_row_ids: [7, 8] });
  assert.equal(out2[0].rowId, 7);
  assert.equal(out2[2].rowId, 8);
  assert.equal(out2[1].rowId, 11);
});

test('bindRowIdsFromHistory: binds only unambiguous unbound user records, in order', () => {
  const records = [
    { role: 'user', content: 'one ctx' },
    { role: 'assistant', content: 'ok' },
    { role: 'user', content: 'two ctx', rowId: 9 },
    { role: 'user', content: 'dup ctx' },
  ];
  const history = [
    { role: 'user', content: 'one ctx', row_id: 1 },
    { role: 'user', content: 'two ctx', row_id: 2 },
    { role: 'user', content: 'dup ctx', row_id: 3 },
    { role: 'user', content: 'dup ctx', row_id: 4 },
  ];
  const bound = bindRowIdsFromHistory(records, history, { displayText: stripCtx });
  assert.equal(bound[0].rowId, 1);
  assert.equal(bound[2].rowId, 9);
  assert.equal('rowId' in bound[3], false);
  assert.equal('rowId' in records[0], false);
});