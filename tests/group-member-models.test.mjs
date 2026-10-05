import test from 'node:test';
import assert from 'node:assert/strict';

import {
  roomModelKey,
  readRoomModelBinding,
  writeRoomModelBinding,
  clearRoomModelBinding,
  buildMemberModelSwitch,
  needsReapply,
} from '../extension/lib/group-member-models.mjs';

test('roomModelKey joins room and member', () => {
  assert.equal(roomModelKey('room-1', 'Riku'), 'room-1::Riku');
});

test('read/write/clear are immutable and round-trip a binding', () => {
  const empty = {};
  const written = writeRoomModelBinding(empty, 'room-1', 'Riku', { model: 'gpt-5.6', provider: 'openai', setAt: 123 });
  assert.equal(Object.keys(empty).length, 0);
  assert.deepEqual(readRoomModelBinding(written, 'room-1', 'Riku'), { model: 'gpt-5.6', provider: 'openai', setAt: 123 });
  assert.equal(readRoomModelBinding(written, 'room-1', 'Luxord'), null);
  assert.equal(readRoomModelBinding(empty, 'room-1', 'Riku'), null);

  const cleared = clearRoomModelBinding(written, 'room-1', 'Riku');
  assert.equal(readRoomModelBinding(cleared, 'room-1', 'Riku'), null);
  assert.deepEqual(readRoomModelBinding(written, 'room-1', 'Riku'), { model: 'gpt-5.6', provider: 'openai', setAt: 123 });
  assert.equal(Object.keys(cleared).length, 0);
});

test('writeRoomModelBinding rejects whitespace or flag-like model and provider', () => {
  assert.throws(() => writeRoomModelBinding({}, 'r', 'Riku', { model: 'gpt 5' }));
  assert.throws(() => writeRoomModelBinding({}, 'r', 'Riku', { model: '-x' }));
  assert.throws(() => writeRoomModelBinding({}, 'r', 'Riku', { model: 'gpt-5', provider: 'open ai' }));
  assert.throws(() => writeRoomModelBinding({}, 'r', 'Riku', { model: 'gpt-5', provider: '--global' }));
  assert.throws(() => writeRoomModelBinding({}, 'r', 'Riku', { model: '' }));
});

test('buildMemberModelSwitch always appends --session and never --global', () => {
  const req = buildMemberModelSwitch({ liveSessionId: 'sess-1', model: 'qwen3.6-plus', provider: 'alibaba' });
  assert.ok(req.params.value.endsWith('--session'));
  assert.ok(!req.params.value.includes('--global'));
  assert.equal(req.params.session_id, 'sess-1');
  assert.equal(req.params.key, 'model');
  assert.ok(req.params.value.includes('--provider alibaba'));
});

test('buildMemberModelSwitch omits the provider flag when absent', () => {
  const req = buildMemberModelSwitch({ liveSessionId: 'sess-1', model: 'glm-5.3-flash' });
  assert.equal(req.params.value, 'glm-5.3-flash --session');
});

test('needsReapply is true only when a binding exists and the live model differs', () => {
  assert.equal(needsReapply({ binding: null, statusModel: 'gpt-5' }), false);
  assert.equal(needsReapply({ binding: { model: 'gpt-5' }, statusModel: 'gpt-5' }), false);
  assert.equal(needsReapply({ binding: { model: 'gpt-5' }, statusModel: 'GPT-5' }), true);
  assert.equal(needsReapply({ binding: { model: 'gpt-5' }, statusModel: 'glm-5' }), true);
  assert.equal(needsReapply({ binding: { model: 'gpt-5' }, statusModel: '' }), false);
  assert.equal(needsReapply({ binding: { model: 'gpt-5' }, statusModel: { model: 'glm-5' } }), true);
  assert.equal(needsReapply({ binding: { model: 'gpt-5' }, statusModel: { model: 'gpt-5', provider: 'openai' } }), false);
});