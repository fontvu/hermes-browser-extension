import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

import {
  createBotGroupRuntime,
  persistGroupProjectionCreate,
} from '../extension/lib/bot-group-runtime.mjs';

const NOW = 1_800_000_000_000;

function memberClient() {
  const listeners = new Map();
  const calls = [];
  const emit = (type, event) => {
    for (const handler of listeners.get(type) || []) handler(event);
  };
  return {
    calls,
    on(type, handler) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(handler);
      return () => listeners.get(type)?.delete(handler);
    },
    request: async (method, params = {}) => {
      calls.push({ method, params });
      if (method === 'session.list') return { sessions: [] };
      if (method === 'session.create') {
        return { session_id: `live-${params.profile}`, stored_session_id: `stored-${params.profile}`, info: { profile_name: params.profile } };
      }
      if (method === 'prompt.submit') {
        queueMicrotask(() => emit('message.complete', { sessionId: params.session_id, payload: { text: `${params.session_id} reply` } }));
        return { accepted: true };
      }
      throw new Error(`Unexpected method: ${method}`);
    },
  };
}

test('a failed projection sync never stops group members from replying', async () => {
  const client = memberClient();
  const visible = [];
  const activity = [];
  const runtime = createBotGroupRuntime({
    client,
    timeoutMs: 1000,
    onMessage: (message) => visible.push(message),
    onActivity: (event) => activity.push(event),
    persist: async () => { throw new Error('The synced group room is no longer available.'); },
  });

  const result = await runtime.send({
    roomId: 'browser-room-new',
    groupName: 'New room',
    members: [{ name: 'alpha', title: 'Alpha' }, { name: 'beta', title: 'Beta' }],
    text: '@everyone hello',
  });

  assert.equal(result.ok, true);
  assert.equal(result.failures.length, 0);
  assert.equal(client.calls.filter(({ method }) => method === 'prompt.submit').length, 2, 'every member is prompted');
  assert.deepEqual(visible.map((message) => message.roleLabel), ['You', 'Alpha', 'Beta']);
  assert.equal(result.syncFailures.length, 3, 'the user message and both replies report their sync failure');
  assert.match(result.syncFailures[0].error, /no longer available/);
  assert.ok(activity.some((event) => event.kind === 'sync_failed'));
});

test('a successful projection sync reports no sync failures', async () => {
  const client = memberClient();
  const persisted = [];
  const result = await createBotGroupRuntime({
    client,
    timeoutMs: 1000,
    persist: async (messages) => { persisted.push(messages.length); },
  }).send({ roomId: 'room', groupName: 'Room', members: ['alpha', 'beta'], text: 'hi' });
  assert.deepEqual(result.syncFailures, []);
  assert.deepEqual(persisted, [1, 2, 3]);
});

function projectionClient({ snapshot = null, revision = 0, conflictOnce = false, rejectWrite = false } = {}) {
  const state = { snapshot, revision, conflictOnce };
  const calls = [];
  const memberGroups = new Map();
  return {
    state,
    calls,
    memberGroups,
    request: async (method, params = {}) => {
      calls.push({ method, params });
      if (method === 'profiles.list') {
        return {
          profiles: [
            {
              name: 'default',
              ui_meta: state.snapshot ? { 'hermes-bots-groups': state.snapshot } : {},
              ui_meta_revisions: state.snapshot ? { 'hermes-bots-groups': state.revision } : {},
            },
            { name: 'alpha', ui_meta: { groups: memberGroups.get('alpha') || [] } },
            { name: 'beta', ui_meta: { groups: memberGroups.get('beta') || [] } },
          ],
        };
      }
      if (method === 'profiles.configure') {
        if (params.ui_meta?.groups) {
          memberGroups.set(params.name, params.ui_meta.groups);
          return { applied: { ui_meta: true } };
        }
        if (rejectWrite) return { applied: { ui_meta: false } };
        if (state.conflictOnce) {
          state.conflictOnce = false;
          state.revision += 1;
          return { applied: { ui_meta: false, ui_meta_conflicts: { 'hermes-bots-groups': {} } } };
        }
        assert.deepEqual(params.ui_meta_expected_revisions, { 'hermes-bots-groups': state.revision });
        state.snapshot = params.ui_meta['hermes-bots-groups'];
        state.revision += 1;
        return { applied: { ui_meta: true, ui_meta_revisions: { 'hermes-bots-groups': state.revision } } };
      }
      throw new Error(`Unexpected method: ${method}`);
    },
  };
}

test('creating a group room writes it to the synced projection and verifies the read-back', async () => {
  const existing = { version: 3, updatedAt: NOW - 1, rooms: { 'name:Old': { name: 'Old', members: [{ name: 'alpha' }], log: [], revision: 3 } }, deleted: {} };
  const client = projectionClient({ snapshot: existing, revision: 7 });
  const result = await persistGroupProjectionCreate(client, {
    roomId: 'browser-room-abc',
    name: 'Launch crew',
    members: ['alpha', 'beta'],
    now: NOW,
  });

  assert.equal(result.ok, true);
  assert.equal(result.roomKey, 'id:browser-room-abc');
  assert.equal(result.revision, 8);
  const room = client.state.snapshot.rooms['id:browser-room-abc'];
  assert.equal(room.roomId, 'browser-room-abc');
  assert.equal(room.name, 'Launch crew');
  assert.deepEqual(room.members.map((member) => member.name), ['alpha', 'beta']);
  assert.deepEqual(room.log, []);
  assert.ok(client.state.snapshot.rooms['name:Old'], 'existing rooms are preserved');
  assert.deepEqual(client.memberGroups.get('alpha'), ['Launch crew']);
});

test('creating the first group room initializes an empty v3 projection', async () => {
  const client = projectionClient();
  const result = await persistGroupProjectionCreate(client, { roomId: 'browser-room-1', name: 'First', members: ['alpha', 'beta'], now: NOW });
  assert.equal(result.ok, true);
  assert.equal(client.state.snapshot.version, 3);
  assert.ok(client.state.snapshot.rooms['id:browser-room-1']);
});

test('creating a group room retries once after a CAS conflict', async () => {
  const client = projectionClient({ snapshot: { version: 3, rooms: {}, deleted: {} }, revision: 2, conflictOnce: true });
  const result = await persistGroupProjectionCreate(client, { roomId: 'browser-room-2', name: 'Retry', members: ['alpha', 'beta'], now: NOW });
  assert.equal(result.ok, true);
  assert.ok(client.state.snapshot.rooms['id:browser-room-2']);
});

test('a rejected group room write fails loudly instead of claiming sync', async () => {
  const client = projectionClient({ snapshot: { version: 3, rooms: {}, deleted: {} }, revision: 2, rejectWrite: true });
  await assert.rejects(
    persistGroupProjectionCreate(client, { roomId: 'browser-room-3', name: 'Nope', members: ['alpha', 'beta'], now: NOW }),
    /rejected/,
  );
});

test('creating a group room refuses invalid member counts', async () => {
  const client = projectionClient();
  await assert.rejects(
    persistGroupProjectionCreate(client, { roomId: 'browser-room-4', name: 'Solo', members: ['alpha'], now: NOW }),
    /2 to 6/,
  );
  assert.equal(client.calls.length, 0);
});

const sidepanelSource = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'extension', 'sidepanel.js'), 'utf8');
const syncSource = sidepanelSource.slice(
  sidepanelSource.indexOf('async function syncLocalGroupRoom('),
  sidepanelSource.indexOf('\nfunction startNewGroupThread('),
);

function syncHarness({ remote = false, create }) {
  const context = {
    isRemoteMode: () => remote,
    isRemoteWsMode: () => false,
    ensureActiveDashboardWsConnection: async () => ({ client: { request: async () => ({}) } }),
    persistGroupProjectionCreate: create,
    Date,
    String,
    Number,
    Math,
  };
  vm.createContext(context);
  vm.runInContext(`${syncSource}\nthis.sync = syncLocalGroupRoom;`, context);
  return context;
}

test('side panel room creation marks a confirmed write as synced', async () => {
  const calls = [];
  const context = syncHarness({ create: async (_client, options) => { calls.push(options); return { ok: true, roomKey: 'id:browser-room-x', revision: 5 }; } });
  const row = { id: 'browser-room-x', roomId: 'browser-room-x', displayName: 'Crew', members: ['alpha', 'beta'], syncState: 'local-only' };
  assert.equal(await context.sync(row), true);
  assert.equal(row.syncState, 'synced');
  assert.equal(row.roomKey, 'id:browser-room-x');
  assert.deepEqual(calls[0].members, ['alpha', 'beta']);
});

test('side panel room creation stays honestly local-only when the write fails', async () => {
  const context = syncHarness({ create: async () => { throw new Error('Hermes rejected the new group room.'); } });
  const row = { id: 'browser-room-y', roomId: 'browser-room-y', displayName: 'Crew', members: ['alpha', 'beta'], syncState: 'local-only' };
  assert.equal(await context.sync(row), false);
  assert.equal(row.syncState, 'local-only');
  assert.match(row.syncError, /rejected/);
});

test('the create modal syncs the room before opening it and the badge never claims an unconfirmed sync', () => {
  const create = sidepanelSource.slice(sidepanelSource.indexOf('async function createNewGroupChat('), sidepanelSource.indexOf('async function syncLocalGroupRoom('));
  assert.ok(create.indexOf('await syncLocalGroupRoom(row)') < create.indexOf('await openBotGroupChat(row)'));
  assert.match(sidepanelSource, /row\.syncState === 'local-only'\s*\n\s*\? 'Not synced'/);
  assert.match(sidepanelSource, /'Sync failed'/);
});
