import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createBotGroupRuntime,
  groupMembersForTurn,
  groupProjectionEntryFromDisplayMessage,
  persistGroupProjectionAppend,
} from '../extension/lib/bot-group-runtime.mjs';
import { groupProjectionMessagesForDisplay } from '../extension/lib/bot-mode.mjs';
import { profileDefaultModelFromOptions } from '../extension/lib/model-discovery.mjs';

const NOW = 1_800_000_000_000;

// Real model.options response shape, from the installed gateway source:
// `hermes_cli/inventory.py::build_models_payload` returns
// `{ providers, model, provider }` (the profile's config.yaml default model /
// provider). Used so the profile-default path is exercised against the real
// contract, not invented keys.
const REAL_MODEL_OPTIONS = {
  providers: [{ slug: 'nous', name: 'Nous', is_current: true, models: ['hermes-4'] }],
  model: 'profile-default',
  provider: 'nous',
};

async function waitUntil(predicate, { tries = 200, delayMs = 2 } = {}) {
  for (let i = 0; i < tries; i += 1) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return false;
}

function makeClient(options = {}) {
  const listeners = new Map();
  const calls = [];
  const prompts = [];
  const listCounts = new Map();
  const resumeCounts = new Map();
  const promptGone = new Set(options.promptGoneOnce || []);
  let gate = null;
  let release = () => {};
  if (options.holdPrompt) gate = new Promise((resolve) => { release = resolve; });
  let confirmOnce = options.confirmOnce === true;
  let statusGoneOnce = options.statusGoneOnce === true;
  let lastSwitch = null;
  const emit = (type, event) => { for (const handler of listeners.get(type) || []) handler(event); };
  const client = {
    calls,
    prompts,
    on(type, handler) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(handler);
      return () => listeners.get(type)?.delete(handler);
    },
    request: async (method, params = {}) => {
      calls.push({ method, params });
      if (method === 'session.list') {
        listCounts.set(params.profile, (listCounts.get(params.profile) || 0) + 1);
        if (options.noSession) return { sessions: [] };
        return { sessions: [{ id: `stored-${params.profile}`, title: params.title }] };
      }
      if (method === 'session.resume') {
        const count = (resumeCounts.get(params.profile) || 0) + 1;
        resumeCounts.set(params.profile, count);
        const liveId = (options.resumeStable || count === 1)
          ? `live-${params.profile}`
          : `live-${params.profile}-rebound`;
        return {
          session_id: liveId,
          stored_session_id: `stored-${params.profile}`,
          info: {
            profile_name: params.profile,
            ...(options.resumeModel ? { model: options.resumeModel } : {}),
            ...(options.resumeProvider ? { provider: options.resumeProvider } : {}),
          },
        };
      }
      if (method === 'session.create') {
        return { session_id: `live-${params.profile}`, stored_session_id: `stored-${params.profile}`, info: { profile_name: params.profile } };
      }
      if (method === 'prompt.submit') {
        prompts.push(params.text);
        if (options.holdPrompt && gate) await gate;
        if (promptGone.has(params.session_id)) {
          promptGone.delete(params.session_id);
          const error = new Error('session not found');
          error.code = 4001;
          error.rpcCode = 4001;
          throw error;
        }
        if (options.failFor && options.failFor(params)) throw new Error('member exploded');
        const reply = options.replyFor ? options.replyFor(params) : `${params.session_id} reply`;
        queueMicrotask(() => emit('message.complete', { sessionId: params.session_id, payload: { text: reply } }));
        return { accepted: true };
      }
      if (method === 'session.status') {
        if (options.statusGoneAlways || statusGoneOnce) {
          statusGoneOnce = false;
          const error = new Error('session not found');
          error.code = 4001;
          error.rpcCode = 4001;
          throw error;
        }
        if (options.statusThrows) throw new Error('status unavailable');
        let model = options.statusModel ?? 'model-a';
        let provider = options.statusProvider ?? 'nous';
        if (options.statusFollowsSwitch && lastSwitch) {
          model = lastSwitch.model;
          provider = lastSwitch.provider || provider;
        }
        if (Array.isArray(options.statusSequence) && options.statusSequence.length) {
          const next = options.statusSequence.shift();
          if (next && typeof next === 'object') {
            if (next.model !== undefined) model = next.model;
            if (next.provider !== undefined) provider = next.provider;
          }
        }
        return { model, provider };
      }
      if (method === 'model.options') return options.modelOptions ?? { ...REAL_MODEL_OPTIONS };
      if (method === 'config.set') {
        const match = String(params.value || '').match(/^(\S+)(?:\s+--provider\s+(\S+))?/);
        lastSwitch = match ? { model: match[1], provider: match[2] || '' } : null;
        if (options.confirmAlways) {
          return { confirm_required: true, confirm_message: 'Expensive model requested', warning: 'cost', scope: 'session' };
        }
        if (confirmOnce) {
          confirmOnce = false;
          return { confirm_required: true, confirm_message: 'Expensive model requested', warning: 'cost', scope: 'session' };
        }
        return { scope: options.scopeGlobal ? 'global' : 'session' };
      }
      throw new Error(`Unexpected method: ${method}`);
    },
  };
  return { client, calls, prompts, listCounts, resumeCounts, release };
}

// ---------------------------------------------------------------------------
// B1.3 speaker on records and projection
// ---------------------------------------------------------------------------

test('reply records carry an additive speaker while preserving roleLabel', async () => {
  const { client } = makeClient();
  const visible = [];
  const runtime = createBotGroupRuntime({ client, timeoutMs: 1000, onMessage: (message, meta) => visible.push({ message, meta }) });

  await runtime.send({
    roomId: 'room',
    groupName: 'Room',
    members: [{ name: 'alpha', title: 'Alpha' }, { name: 'beta', title: 'Beta' }],
    text: 'hello room',
  });

  const user = visible.find((entry) => entry.message.role === 'user');
  assert.equal(Object.hasOwn(user.message, 'speaker'), false, 'the user echo has no speaker');
  const replies = visible.filter((entry) => entry.message.role === 'assistant');
  assert.deepEqual(replies.map((entry) => [entry.message.speaker, entry.message.roleLabel]), [
    ['alpha', 'Alpha'],
    ['beta', 'Beta'],
  ]);
  assert.deepEqual(replies.map((entry) => entry.meta.kind), ['reply', 'reply']);
});

test('groupProjectionEntryFromDisplayMessage prefers speaker over the display label', () => {
  const entry = groupProjectionEntryFromDisplayMessage({
    role: 'assistant',
    roleLabel: 'Alpha',
    speaker: 'default',
    content: 'A reply',
    ts: NOW,
  });
  assert.equal(entry.from.name, 'default');
  assert.equal(entry.from.kind, 'member');

  const labelled = groupProjectionEntryFromDisplayMessage({ role: 'assistant', roleLabel: 'Alpha', content: 'x', ts: NOW });
  assert.equal(labelled.from.name, 'Alpha', 'falls back to roleLabel when no speaker is present');
});

test('groupProjectionMessagesForDisplay adds speaker on member rows only', () => {
  const messages = groupProjectionMessagesForDisplay({
    messages: [
      { from: { kind: 'user', name: 'Jon' }, text: 'Ship it', at: NOW - 2 },
      { from: { kind: 'member', name: 'riku' }, text: 'On it', at: NOW - 1 },
    ],
  });
  assert.deepEqual(messages, [
    { role: 'user', content: 'Ship it', ts: NOW - 2, thread: '', roleLabel: 'Jon' },
    { role: 'assistant', content: 'On it', ts: NOW - 1, thread: '', roleLabel: 'Riku', speaker: 'riku' },
  ]);
});

// ---------------------------------------------------------------------------
// B2.1 turn_start roster
// ---------------------------------------------------------------------------

test('send announces the routed roster once, before the first working event', async () => {
  const { client } = makeClient();
  const activity = [];
  const runtime = createBotGroupRuntime({ client, timeoutMs: 1000, onActivity: (event) => activity.push(event) });

  await runtime.send({
    roomId: 'room',
    groupName: 'Room',
    members: [{ name: 'alpha', title: 'Alpha' }, { name: 'beta', title: 'Beta' }, { name: 'gamma', title: 'Gamma' }],
    text: '@everyone go',
  });

  const turnStarts = activity.filter((event) => event.kind === 'turn_start');
  assert.equal(turnStarts.length, 1, 'exactly one turn_start');
  assert.deepEqual(turnStarts[0].members, [
    { member: 'alpha', roleLabel: 'Alpha' },
    { member: 'beta', roleLabel: 'Beta' },
    { member: 'gamma', roleLabel: 'Gamma' },
  ]);
  assert.equal(activity.findIndex((event) => event.kind === 'turn_start'), 0, 'turn_start is first');
  assert.equal(activity.findIndex((event) => event.kind === 'working') > 0, true);
});

test('turn_start carries only the routed members for an @mention', async () => {
  const { client } = makeClient();
  const activity = [];
  const runtime = createBotGroupRuntime({ client, timeoutMs: 1000, onActivity: (event) => activity.push(event) });
  await runtime.send({
    roomId: 'room',
    groupName: 'Room',
    members: [{ name: 'alpha', title: 'Alpha' }, { name: 'beta', title: 'Beta' }],
    text: '@alpha status',
  });
  const turnStart = activity.find((event) => event.kind === 'turn_start');
  assert.deepEqual(turnStart.members, [{ member: 'alpha', roleLabel: 'Alpha' }]);
});

test('a sequential turn emits ordered working/pass/failed events and one idle', async () => {
  const { client } = makeClient({
    replyFor: (params) => (params.session_id === 'live-beta' ? '(pass)' : 'a reply'),
    failFor: (params) => params.session_id === 'live-gamma',
  });
  const activity = [];
  const runtime = createBotGroupRuntime({ client, timeoutMs: 1000, onActivity: (event) => activity.push(event) });
  const result = await runtime.send({
    roomId: 'room',
    groupName: 'Room',
    members: [{ name: 'alpha', title: 'Alpha' }, { name: 'beta', title: 'Beta' }, { name: 'gamma', title: 'Gamma' }],
    text: '@everyone go',
  });

  assert.deepEqual(activity.map((event) => event.kind), [
    'turn_start',
    'working',
    'working',
    'pass',
    'working',
    'failed',
    'idle',
  ]);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].member, 'gamma');
});

// ---------------------------------------------------------------------------
// B2.2 per-member session cache
// ---------------------------------------------------------------------------

test('consecutive sends resolve each member session at most once', async () => {
  const { client, listCounts } = makeClient();
  const runtime = createBotGroupRuntime({ client, timeoutMs: 1000 });
  const args = { roomId: 'room', groupName: 'Room', members: ['alpha', 'beta'], text: 'hi' };
  await runtime.send(args);
  await runtime.send(args);

  assert.equal(listCounts.get('alpha'), 1, 'alpha session.list happens once across both sends');
  assert.equal(listCounts.get('beta'), 1, 'beta session.list happens once across both sends');
});

test('a gone session is re-resolved once and the cache is updated', async () => {
  const { client, calls } = makeClient({ promptGoneOnce: ['live-alpha'] });
  const runtime = createBotGroupRuntime({ client, timeoutMs: 1000 });
  const result = await runtime.send({ roomId: 'room', groupName: 'Room', members: ['alpha', 'beta'], text: 'hi' });

  assert.equal(result.ok, true);
  assert.deepEqual(
    calls.filter(({ method }) => method === 'prompt.submit').map(({ params }) => params.session_id),
    ['live-alpha', 'live-alpha-rebound', 'live-beta'],
  );
  assert.deepEqual(runtime.getMemberSession('alpha'), {
    liveId: 'live-alpha-rebound',
    storedId: 'stored-alpha',
    profile: 'alpha',
    title: 'Group: room',
  });
});

test('getMemberSession returns a read-only copy and null for unknown members', async () => {
  const { client } = makeClient();
  const runtime = createBotGroupRuntime({ client, timeoutMs: 1000 });
  await runtime.send({ roomId: 'room', groupName: 'Room', members: ['alpha', 'beta'], text: 'hi' });

  const copy = runtime.getMemberSession('alpha');
  assert.equal(copy.liveId, 'live-alpha');
  copy.liveId = 'tampered';
  assert.equal(runtime.getMemberSession('alpha').liveId, 'live-alpha', 'internal cache is unaffected by mutation');
  assert.equal(runtime.getMemberSession('nobody'), null);
});

// ---------------------------------------------------------------------------
// B3.2 readMemberModel / setMemberModel / resetMemberModel
// ---------------------------------------------------------------------------

test('readMemberModel returns the live model and never caches a missing session', async () => {
  const ok = makeClient();
  const okRuntime = createBotGroupRuntime({ client: ok.client, timeoutMs: 1000 });
  assert.deepEqual(await okRuntime.readMemberModel('room', 'alpha'), { state: 'ok', model: 'model-a', provider: 'nous' });

  const missing = makeClient({ noSession: true });
  const missingRuntime = createBotGroupRuntime({ client: missing.client, timeoutMs: 1000 });
  assert.deepEqual(await missingRuntime.readMemberModel('room', 'alpha'), { state: 'no-session' });
  await missingRuntime.readMemberModel('room', 'alpha');
  assert.equal(missing.listCounts.get('alpha'), 2, 'a missing session is re-checked, not cached as absent');
});

test('readMemberModel reports unknown when status cannot be read', async () => {
  const { client } = makeClient({ statusThrows: true });
  const runtime = createBotGroupRuntime({ client, timeoutMs: 1000 });
  const result = await runtime.readMemberModel('room', 'alpha');
  assert.equal(result.state, 'unknown');
  assert.match(result.error, /status unavailable/);
});

test('setMemberModel refuses a member that is mid-turn', async () => {
  const { client, release } = makeClient({ holdPrompt: true });
  const runtime = createBotGroupRuntime({ client, timeoutMs: 5000 });
  const sendPromise = runtime.send({ roomId: 'room', groupName: 'Room', members: ['alpha', 'beta'], text: 'hi' });
  assert.equal(await waitUntil(() => client.calls.some(({ method }) => method === 'prompt.submit')), true);

  await assert.rejects(
    () => runtime.setMemberModel('room', 'alpha', { model: 'm1' }),
    (error) => error.code === 'member-busy',
  );
  release();
  await sendPromise;
});

test('setMemberModel creates a missing session, switches, then re-reads status', async () => {
  const { client, calls } = makeClient({ noSession: true, statusFollowsSwitch: true });
  const runtime = createBotGroupRuntime({ client, timeoutMs: 1000 });
  const result = await runtime.setMemberModel('room', 'alpha', { model: 'glm-5', provider: 'nous' });

  assert.equal(result.state, 'ok');
  assert.equal(result.model, 'glm-5');
  assert.equal(result.provider, 'nous');
  assert.equal(result.scope, 'session');
  assert.equal(result.verified, true);
  assert.equal(result.evidence, 'session.status');
  assert.equal(calls.some(({ method }) => method === 'session.create'), true);
  const setIndex = calls.findIndex(({ method }) => method === 'config.set');
  const statusIndex = calls.findIndex(({ method }) => method === 'session.status');
  assert.equal(setIndex > -1 && statusIndex > setIndex, true, 'status is re-read after the switch');
  const switchParams = calls[setIndex].params;
  assert.equal(switchParams.key, 'model');
  assert.equal(switchParams.value, 'glm-5 --provider nous --session');
});

test('setMemberModel does not report ok when the status still shows the old model and resume cannot confirm', async () => {
  // Room status lag (live recon): the switch is accepted, but the readable
  // status is the OLD model and a live-reuse resume agrees — never fake ok.
  const { client } = makeClient({ statusModel: 'old-model', resumeStable: true, resumeModel: 'old-model' });
  const runtime = createBotGroupRuntime({ client, timeoutMs: 1000 });
  const result = await runtime.setMemberModel('room', 'alpha', { model: 'new-model', provider: 'nous' });
  assert.equal(result.state, 'unverified');
  assert.equal(result.accepted, true);
  assert.equal(result.verified, false);
  assert.notEqual(result.state, 'ok');
  assert.deepEqual(result.requested, { model: 'new-model', provider: 'nous' });
});

test('setMemberModel verifies via a safe live-reuse resume when status still lags', async () => {
  const { client, calls } = makeClient({
    statusModel: 'old-model', resumeStable: true, resumeModel: 'new-model', resumeProvider: 'nous',
  });
  const runtime = createBotGroupRuntime({ client, timeoutMs: 1000 });
  const result = await runtime.setMemberModel('room', 'alpha', { model: 'new-model', provider: 'nous' });
  assert.equal(result.state, 'ok');
  assert.equal(result.verified, true);
  assert.equal(result.evidence, 'session.resume');
  assert.equal(result.model, 'new-model');
  const resumes = calls.filter(({ method }) => method === 'session.resume');
  assert.ok(resumes.length >= 1, 'a live-reuse resume supplied the additional evidence');
});

test('setMemberModel does not report ok when the provider does not match', async () => {
  const { client } = makeClient({
    statusModel: 'glm-5', statusProvider: 'openai', resumeStable: true, resumeModel: 'glm-5', resumeProvider: 'openai',
  });
  const runtime = createBotGroupRuntime({ client, timeoutMs: 1000 });
  const result = await runtime.setMemberModel('room', 'alpha', { model: 'glm-5', provider: 'nous' });
  assert.equal(result.state, 'unverified');
  assert.notEqual(result.state, 'ok');
});

test('setMemberModel returns a confirm state and honors the second confirmed call', async () => {
  const { client, calls } = makeClient({ confirmOnce: true, statusFollowsSwitch: true });
  const runtime = createBotGroupRuntime({ client, timeoutMs: 1000 });

  const first = await runtime.setMemberModel('room', 'alpha', { model: 'expensive-model' });
  assert.equal(first.state, 'confirm');
  assert.deepEqual(first.detail, {
    member: 'alpha',
    model: 'expensive-model',
    provider: '',
    message: 'Expensive model requested',
    warning: 'cost',
    scope: 'session',
  });

  const second = await runtime.setMemberModel('room', 'alpha', { model: 'expensive-model', confirm: true });
  assert.equal(second.state, 'ok');
  const confirmed = calls.filter(({ method }) => method === 'config.set');
  assert.equal(confirmed.length, 2);
  assert.equal(confirmed[1].params.confirm_expensive_model, true);
});

test('setMemberModel never reports ok when the gateway still asks for confirmation on the second call', async () => {
  const { client, calls } = makeClient({ confirmAlways: true });
  const runtime = createBotGroupRuntime({ client, timeoutMs: 1000 });
  const first = await runtime.setMemberModel('room', 'alpha', { model: 'expensive-model' });
  assert.equal(first.state, 'confirm');
  const second = await runtime.setMemberModel('room', 'alpha', { model: 'expensive-model', confirm: true });
  assert.notEqual(second.state, 'ok');
  assert.equal(second.state, 'confirm');
  const confirmed = calls.filter(({ method }) => method === 'config.set');
  assert.equal(confirmed.length, 2);
  assert.equal(confirmed[1].params.confirm_expensive_model, true);
});

test('setMemberModel never reports ok when the gateway scope is global', async () => {
  const { client } = makeClient({ scopeGlobal: true, statusFollowsSwitch: true });
  const runtime = createBotGroupRuntime({ client, timeoutMs: 1000 });
  const result = await runtime.setMemberModel('room', 'alpha', { model: 'glm-5', provider: 'nous' });
  assert.notEqual(result.state, 'ok');
  assert.equal(result.scope, 'global');
  assert.equal(result.verified, false);
});

test('setMemberModel reports unknown when the post-switch status read fails', async () => {
  const { client } = makeClient({ statusThrows: true });
  const runtime = createBotGroupRuntime({ client, timeoutMs: 1000 });
  const result = await runtime.setMemberModel('room', 'alpha', { model: 'm1' });
  assert.equal(result.state, 'unknown');
  assert.equal(result.verified, false);
});

test('resetMemberModel switches to the profile default with a session-only scope', async () => {
  const { client, calls } = makeClient({ statusFollowsSwitch: true });
  const runtime = createBotGroupRuntime({ client, timeoutMs: 1000 });
  const result = await runtime.resetMemberModel('room', 'alpha');

  assert.equal(result.state, 'ok');
  assert.equal(result.source, 'profile-default');
  assert.equal(result.scope, 'session');
  assert.equal(result.verified, true);
  const optionsCall = calls.find(({ method }) => method === 'model.options');
  assert.equal(optionsCall.params.profile, 'alpha', 'the profile default is read for the member profile');
  const setCall = calls.find(({ method }) => method === 'config.set');
  assert.equal(setCall.params.value, 'profile-default --provider nous --session');
  assert.equal(setCall.params.value.includes('--global'), false);
});

test('resetMemberModel reports accepted-but-unverified when the profile default is not confirmed', async () => {
  const { client } = makeClient({ statusModel: 'other-model', resumeStable: true, resumeModel: 'other-model' });
  const runtime = createBotGroupRuntime({ client, timeoutMs: 1000 });
  const result = await runtime.resetMemberModel('room', 'alpha');
  assert.equal(result.state, 'unverified');
  assert.equal(result.accepted, true);
  assert.equal(result.source, 'profile-default');
  assert.notEqual(result.state, 'ok');
});

test('resetMemberModel never reports ok when the gateway still asks for confirmation', async () => {
  const { client } = makeClient({ confirmAlways: true });
  const runtime = createBotGroupRuntime({ client, timeoutMs: 1000 });
  const first = await runtime.resetMemberModel('room', 'alpha');
  assert.equal(first.state, 'confirm');
  const second = await runtime.resetMemberModel('room', 'alpha', { confirm: true });
  assert.notEqual(second.state, 'ok');
  assert.equal(second.state, 'confirm');
});

// ---------------------------------------------------------------------------
// B3.2 profile default: real model.options contract (installed source)
// ---------------------------------------------------------------------------

test('profileDefaultModelFromOptions reads the real model.options shape', () => {
  // Real shape (hermes_cli/inventory.py build_models_payload): { providers, model, provider }.
  const real = { providers: [{ slug: 'nous', name: 'Nous', is_current: true, models: ['hermes-4'] }], model: 'glm-5.3-flash', provider: 'nous' };
  assert.deepEqual(profileDefaultModelFromOptions(real), { model: 'glm-5.3-flash', provider: 'nous' });
  // Invented keys are not the contract.
  assert.equal(profileDefaultModelFromOptions({ default_model: 'x', default_provider: 'y' }), null);
  assert.equal(profileDefaultModelFromOptions({ providers: [] }), null);
});

test('resetMemberModel fails closed when the profile default model is unavailable', async () => {
  const { client, calls } = makeClient({ modelOptions: { providers: [], model: '', provider: '' } });
  const runtime = createBotGroupRuntime({ client, timeoutMs: 1000 });
  await assert.rejects(
    () => runtime.resetMemberModel('room', 'alpha'),
    (error) => error.code === 'no-profile-default',
  );
  assert.equal(calls.some(({ method }) => method === 'config.set'), false, 'no switch is attempted');
});

// ---------------------------------------------------------------------------
// B3.2 readMemberModel recovery
// ---------------------------------------------------------------------------

test('readMemberModel resumes a reaped session once and retries the read', async () => {
  const { client, calls } = makeClient({ statusGoneOnce: true });
  const runtime = createBotGroupRuntime({ client, timeoutMs: 1000 });
  const result = await runtime.readMemberModel('room', 'alpha');
  assert.deepEqual(result, { state: 'ok', model: 'model-a', provider: 'nous' });
  assert.ok(calls.some(({ method, params }) => method === 'session.resume' && params.session_id === 'stored-alpha'), 'resumed from the cached stored id');
  assert.equal(calls.filter(({ method }) => method === 'session.status').length, 2, 'the status read is retried exactly once');
});

test('readMemberModel reports unknown when the retried status read still fails', async () => {
  const { client } = makeClient({ statusGoneAlways: true });
  const runtime = createBotGroupRuntime({ client, timeoutMs: 1000 });
  const result = await runtime.readMemberModel('room', 'alpha');
  assert.equal(result.state, 'unknown');
});

// ---------------------------------------------------------------------------
// B2.2 prepare fills the positive cache
// ---------------------------------------------------------------------------

test('prepare fills the positive session cache for a later send', async () => {
  const { client, listCounts } = makeClient();
  const runtime = createBotGroupRuntime({ client, timeoutMs: 1000 });
  const prepared = await runtime.prepare({ roomId: 'room', members: ['alpha', 'beta'] });
  assert.equal(prepared.ok, true);
  assert.equal(runtime.getMemberSession('alpha').liveId, 'live-alpha');
  const listBefore = listCounts.get('alpha');
  await runtime.send({ roomId: 'room', groupName: 'Room', members: ['alpha', 'beta'], text: 'hi' });
  assert.equal(listCounts.get('alpha'), listBefore, 'send reuses the prepared session instead of re-resolving');
});

// ---------------------------------------------------------------------------
// B3.3 beforeMemberTurn hook (Outcome R)
// ---------------------------------------------------------------------------

test('beforeMemberTurn runs before the member prompt is submitted', async () => {
  const { client } = makeClient();
  const order = [];
  const runtime = createBotGroupRuntime({
    client,
    timeoutMs: 1000,
    beforeMemberTurn: async (member) => { order.push(`hook:${member.name}`); },
  });
  const original = client.request;
  client.request = async (method, params) => {
    if (method === 'prompt.submit') order.push(`submit:${params.session_id}`);
    return original(method, params);
  };

  await runtime.send({ roomId: 'room', groupName: 'Room', members: ['alpha', 'beta'], text: 'hi' });
  assert.deepEqual(order, ['hook:alpha', 'submit:live-alpha', 'hook:beta', 'submit:live-beta']);
});

test('a failing beforeMemberTurn marks the member failed and continues the queue', async () => {
  const { client, prompts } = makeClient();
  const activity = [];
  const runtime = createBotGroupRuntime({
    client,
    timeoutMs: 1000,
    onActivity: (event) => activity.push(event),
    beforeMemberTurn: async (member) => {
      if (member.name === 'beta') throw new Error('re-apply failed');
    },
  });
  const result = await runtime.send({ roomId: 'room', groupName: 'Room', members: ['alpha', 'beta', 'gamma'], text: '@everyone go' });

  assert.equal(prompts.length, 2, 'beta is skipped, alpha and gamma still run');
  const failed = activity.find((event) => event.kind === 'failed');
  assert.equal(failed.member, 'beta');
  assert.match(failed.error, /re-apply failed/);
  assert.equal(result.failures.length, 1);
  assert.equal(result.messages.some((message) => message.roleLabel === 'gamma'), true, 'gamma still replied after the failure');
});

test('beforeMemberTurn runs before every submission attempt, including a rebound', async () => {
  const { client } = makeClient({ promptGoneOnce: ['live-alpha'] });
  const order = [];
  const runtime = createBotGroupRuntime({
    client,
    timeoutMs: 1000,
    beforeMemberTurn: async (member, session) => {
      // The cache is updated BEFORE the hook, so the hook reads the exact
      // session it is about to configure.
      assert.equal(runtime.getMemberSession(member.name).liveId, session.liveId);
      order.push(`hook:${member.name}:${session.liveId}`);
    },
  });
  const original = client.request;
  client.request = async (method, params) => {
    if (method === 'prompt.submit') order.push(`submit:${params.session_id}`);
    return original(method, params);
  };

  await runtime.send({ roomId: 'room', groupName: 'Room', members: ['alpha', 'beta'], text: 'hi' });
  assert.deepEqual(order, [
    'hook:alpha:live-alpha',
    'submit:live-alpha',
    'hook:alpha:live-alpha-rebound',
    'submit:live-alpha-rebound',
    'hook:beta:live-beta',
    'submit:live-beta',
  ]);
});

test('a beforeMemberTurn rejection on the rebound attempt fails the member without a second submit', async () => {
  const { client, calls } = makeClient({ promptGoneOnce: ['live-alpha'] });
  const activity = [];
  const runtime = createBotGroupRuntime({
    client,
    timeoutMs: 1000,
    onActivity: (event) => activity.push(event),
    beforeMemberTurn: async (member, session) => {
      if (member.name === 'alpha' && session.liveId === 'live-alpha-rebound') throw new Error('re-apply failed on rebound');
    },
  });

  const result = await runtime.send({ roomId: 'room', groupName: 'Room', members: ['alpha', 'beta'], text: 'hi' });
  const alphaSubmits = calls.filter(({ method, params }) => method === 'prompt.submit' && params.session_id.startsWith('live-alpha'));
  assert.deepEqual(alphaSubmits.map(({ params }) => params.session_id), ['live-alpha'], 'no rebound prompt is submitted after the hook rejects');
  const failed = activity.find((event) => event.kind === 'failed' && event.member === 'alpha');
  assert.match(failed.error, /re-apply failed on rebound/);
  assert.equal(result.messages.some((message) => message.speaker === 'beta'), true, 'beta still ran');
});

// ---------------------------------------------------------------------------
// B3.5 room-event suppression
// ---------------------------------------------------------------------------

test('room-event rows never reach the synced projection', async () => {
  assert.equal(groupProjectionEntryFromDisplayMessage({
    role: 'system',
    kind: 'room-event',
    content: 'Riku now uses qwen in this room',
    ts: NOW,
  }), null);

  const { client, calls } = makeClient();
  const result = await persistGroupProjectionAppend(client, {
    roomId: 'room',
    roomKey: 'id:room',
    message: { role: 'system', kind: 'room-event', content: 'Riku now uses qwen in this room', ts: NOW },
    now: NOW,
  });
  assert.deepEqual(result, { ok: true, skipped: true });
  assert.equal(calls.some(({ method }) => method === 'profiles.list'), false, 'no projection write is attempted');
});

test('room-event rows are dropped from the display projection', () => {
  const messages = groupProjectionMessagesForDisplay({
    messages: [
      { role: 'system', kind: 'room-event', text: 'Riku is back on its profile default', at: NOW - 3 },
      { from: { kind: 'member', name: 'riku' }, text: 'On it', at: NOW - 1 },
    ],
  });
  assert.deepEqual(messages, [
    { role: 'assistant', content: 'On it', ts: NOW - 1, thread: '', roleLabel: 'Riku', speaker: 'riku' },
  ]);
});

test('room-event rows never leak into a member prompt', async () => {
  const { client, prompts } = makeClient();
  const runtime = createBotGroupRuntime({ client, timeoutMs: 1000 });
  await runtime.send({
    roomId: 'room',
    groupName: 'Room',
    members: ['alpha', 'beta'],
    messages: [
      { role: 'assistant', roleLabel: 'Alpha', content: 'earlier reply', ts: NOW - 5 },
      { role: 'system', kind: 'room-event', content: 'Riku now uses secret-model in this room', ts: NOW - 4 },
    ],
    text: 'continue',
  });

  const joined = prompts.join('\n');
  assert.equal(joined.includes('secret-model'), false, 'the model-change line never reaches a member prompt');
  assert.equal(joined.includes('earlier reply'), true, 'real room history still reaches the prompt');
});

test('groupMembersForTurn still routes the way the runtime relies on', () => {
  const members = [{ name: 'alpha' }, { name: 'beta' }];
  assert.equal(groupMembersForTurn('@everyone hi', members).length, 2);
  assert.deepEqual(groupMembersForTurn('@beta hi', members).map((m) => m.name), ['beta']);
});

// ---------------------------------------------------------------------------
// Per-member retry (re-run ONLY the failed member, same model re-apply path)
// ---------------------------------------------------------------------------

test('retryMember re-runs only the target member with the original prompt and re-applies its model', async () => {
  const { client, calls, prompts } = makeClient();
  const activity = [];
  const hooks = [];
  const visible = [];
  const runtime = createBotGroupRuntime({
    client,
    timeoutMs: 1000,
    onActivity: (event) => activity.push(event),
    onMessage: (message, meta) => visible.push({ message, meta }),
    beforeMemberTurn: async (member, session) => { hooks.push(`${member.name}:${session.liveId}`); },
  });
  await runtime.send({ roomId: 'room', groupName: 'Room', members: ['alpha', 'beta', 'gamma'], text: '@everyone go' });
  calls.length = 0;
  prompts.length = 0;
  activity.length = 0;
  hooks.length = 0;
  visible.length = 0;

  const result = await runtime.retryMember({
    roomId: 'room',
    groupName: 'Room',
    members: ['alpha', 'beta', 'gamma'],
    messages: [{ role: 'user', roleLabel: 'You', content: '@everyone go', ts: NOW - 1 }],
    member: 'beta',
    thread: 'main',
  });

  assert.deepEqual(
    calls.filter(({ method }) => method === 'prompt.submit').map(({ params }) => params.session_id),
    ['live-beta'],
    'only the retried member is prompted',
  );
  assert.deepEqual(hooks, ['beta:live-beta'], 'the model re-apply hook runs for the retried member only');
  assert.equal(prompts.every((text) => text.includes('@everyone go')), true, 'the original prompt reaches the member prompt');
  assert.deepEqual(activity.map((event) => event.kind), ['retry', 'working', 'idle']);
  const reply = visible.find(({ meta }) => meta.kind === 'reply');
  assert.equal(reply.message.speaker, 'beta');
  assert.equal(result.ok, true);
  assert.equal(result.failures.length, 0);
  assert.equal(result.messages.some((message) => message.speaker === 'beta'), true, 'the reply joins the returned room messages');
});

test('retryMember folds an explicit original prompt into the member prompt when the context lacks it', async () => {
  const { client, prompts } = makeClient();
  const runtime = createBotGroupRuntime({ client, timeoutMs: 1000 });
  await runtime.prepare({ roomId: 'room', members: ['alpha', 'beta'] });
  await runtime.retryMember({
    roomId: 'room',
    groupName: 'Room',
    members: ['alpha', 'beta'],
    messages: [{ role: 'assistant', roleLabel: 'Alpha', content: 'earlier reply', ts: NOW - 1 }],
    member: 'alpha',
    text: 'the original ask',
  });
  assert.equal(prompts[0].includes('the original ask'), true, 'the explicit prompt is present');
  assert.equal(prompts[0].includes('earlier reply'), true, 'the current room context is present');
});

test('retryMember refuses to run while a turn is already running', async () => {
  const { client, release } = makeClient({ holdPrompt: true });
  const runtime = createBotGroupRuntime({ client, timeoutMs: 5000 });
  const sendPromise = runtime.send({ roomId: 'room', groupName: 'Room', members: ['alpha', 'beta'], text: 'hi' });
  assert.equal(await waitUntil(() => client.calls.some(({ method }) => method === 'prompt.submit')), true);

  await assert.rejects(
    () => runtime.retryMember({
      roomId: 'room', groupName: 'Room', members: ['alpha', 'beta'],
      messages: [{ role: 'user', content: 'hi', ts: NOW }], member: 'alpha',
    }),
    (error) => error.code === 'turn-busy',
  );
  release();
  await sendPromise;
});

test('retryMember refuses a second retry while one is in flight', async () => {
  const { client, release } = makeClient({ holdPrompt: true });
  const runtime = createBotGroupRuntime({ client, timeoutMs: 5000 });
  await runtime.prepare({ roomId: 'room', members: ['alpha', 'beta'] });

  const first = runtime.retryMember({
    roomId: 'room', groupName: 'Room', members: ['alpha', 'beta'],
    messages: [{ role: 'user', content: 'hi', ts: NOW }], member: 'alpha',
  });
  assert.equal(await waitUntil(() => client.calls.some(({ method }) => method === 'prompt.submit')), true);

  await assert.rejects(
    () => runtime.retryMember({
      roomId: 'room', groupName: 'Room', members: ['alpha', 'beta'],
      messages: [{ role: 'user', content: 'hi', ts: NOW }], member: 'alpha',
    }),
    (error) => error.code === 'retry-busy',
  );
  release();
  await first;
});

test('retryMember marks the member failed again when the retry does not complete', async () => {
  const { client } = makeClient({ failFor: (params) => params.session_id === 'live-beta' });
  const activity = [];
  const runtime = createBotGroupRuntime({ client, timeoutMs: 1000, onActivity: (event) => activity.push(event) });
  await runtime.prepare({ roomId: 'room', members: ['alpha', 'beta'] });
  const result = await runtime.retryMember({
    roomId: 'room', groupName: 'Room', members: ['alpha', 'beta'],
    messages: [{ role: 'user', content: 'hi', ts: NOW }], member: 'beta',
  });
  assert.deepEqual(activity.map((event) => event.kind), ['retry', 'working', 'failed', 'idle']);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].member, 'beta');
  assert.match(result.failures[0].error, /member exploded/);
});

test('retryMember reports a pass without adding a reply', async () => {
  const { client } = makeClient({ replyFor: () => '(pass)' });
  const activity = [];
  const visible = [];
  const runtime = createBotGroupRuntime({
    client,
    timeoutMs: 1000,
    onActivity: (event) => activity.push(event),
    onMessage: (message, meta) => visible.push({ message, meta }),
  });
  await runtime.prepare({ roomId: 'room', members: ['alpha', 'beta'] });
  const result = await runtime.retryMember({
    roomId: 'room', groupName: 'Room', members: ['alpha', 'beta'],
    messages: [{ role: 'user', content: 'hi', ts: NOW }], member: 'alpha',
  });
  assert.deepEqual(activity.map((event) => event.kind), ['retry', 'working', 'pass', 'idle']);
  assert.equal(visible.length, 0, 'a pass is not a display reply');
  assert.equal(result.failures.length, 0);
});

test('retryMember declines a member that is not in the room', async () => {
  const { client } = makeClient();
  const runtime = createBotGroupRuntime({ client, timeoutMs: 1000 });
  const result = await runtime.retryMember({
    roomId: 'room', groupName: 'Room', members: ['alpha', 'beta'],
    messages: [], member: 'ghost',
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'member');
  assert.equal(client.calls.some(({ method }) => method === 'prompt.submit'), false);
});