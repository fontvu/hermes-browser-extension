import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHermesContextRegistry, contextFromHermesRegistry, refreshHermesContextRegistry, resetHermesContextRegistry } from '../extension/lib/hermes-context-sync.mjs';
import { normalizeHermesModels, contextAccountingSnapshot } from '../extension/lib/common.mjs';
import { modelsFromModelOptionsPayload } from '../extension/lib/model-discovery.mjs';
import { readFileSync } from 'node:fs';

const source = `
DEFAULT_CONTEXT_LENGTHS = {"future-model": 777000, "gpt-future": 1050000}
_CODEX_OAUTH_CONTEXT_FALLBACK: Dict[str, int] = {"gpt-future": 272000}
_CODEX_OAUTH_VERIFIED_ABOVE_ADVERTISED_PREFIXES: Dict[str, int] = {}
_CODEX_OAUTH_VERIFIED_ABOVE_ADVERTISED_EXACT: Dict[str, int] = {"gpt-future": 900000}
_CODEX_900K_SNAPSHOT_BASES = ("gpt-future",)
_CODEX_900K_ELIGIBLE_BASES = frozenset({*_CODEX_900K_SNAPSHOT_BASES})
CODEX_CONTEXT_VARIANT_SUFFIX = "-900k"
CONTEXT_PROBE_TIERS = [256000, 128000]
`;

test('unknown future models inherit Agent data without Browser code edits', () => {
  const registry = parseHermesContextRegistry(source);
  assert.equal(contextFromHermesRegistry({ rawModelId: 'future-model' }, registry), 777000);
  assert.equal(contextFromHermesRegistry({ rawModelId: 'gpt-future', provider: 'openai-codex' }, registry), 272000);
  assert.equal(contextFromHermesRegistry({ rawModelId: 'gpt-future-900k', provider: 'openai-codex', max_context_window: 872000 }, registry), 872000);
  assert.equal(contextFromHermesRegistry({ rawModelId: 'gpt-future-900k', provider: 'openai-codex' }, registry), 900000);
  assert.equal(contextFromHermesRegistry({ rawModelId: 'gpt-future', provider: 'openai' }, registry), 1050000);
});

test('invalid source never executes code or becomes a partial registry', () => {
  assert.throws(() => parseHermesContextRegistry('DEFAULT_CONTEXT_LENGTHS = malicious()'));
  assert.throws(() => parseHermesContextRegistry(source.replace('777000', 'evil()')));
});

test('official refresh caches last-good data and tolerates network failure', async () => {
  resetHermesContextRegistry();
  let stored = {};
  const storage = { get: async () => stored, set: async (value) => { stored = value; } };
  const result = await refreshHermesContextRegistry({ storage, refresh: true, fetchFn: async () => ({ ok: true, text: async () => source }) });
  assert.equal(result.ok, true);
  assert.equal(contextFromHermesRegistry({ id: 'future-model' }), 777000);
  await refreshHermesContextRegistry({ storage, refresh: true, fetchFn: async () => { throw new Error('offline'); } });
  assert.equal(contextFromHermesRegistry({ id: 'future-model' }), 777000);
  resetHermesContextRegistry();
});

test('GPT 6.1 Codex base and opt-in variant use synchronized Agent rules', () => {
  const rows = ['gpt-6.1-sol', 'gpt-6.1-sol-900k'].map(id => ({ id, provider: 'openai-codex' }));
  const models = normalizeHermesModels(rows, rows[0].id);
  assert.equal(models[0].contextTokens, 272000);
  assert.equal(models[1].contextTokens, 900000);
});

test('gateway options numbers win over Browser stale-window heuristics across normalization', () => {
  const payload = { providers: [{ slug: 'openai-codex', models: [{ id: 'gpt-6-sol-900k', context_length: 272000 }] }] };
  const rows = modelsFromModelOptionsPayload(payload);
  assert.equal(normalizeHermesModels(rows, rows[0].id)[0].contextTokens, 272000);
  const capped = modelsFromModelOptionsPayload({ providers: [{ slug: 'openai-codex', models: [{ id: 'gpt-6.1-sol-900k', context_length: 872000 }] }] });
  assert.equal(normalizeHermesModels(capped, capped[0].id)[0].contextTokens, 872000);
});

test('live session effective context is never replaced by a Browser model-name heuristic', () => {
  assert.equal(contextAccountingSnapshot({ runtime: { model: 'gpt-6-sol-900k', provider: 'openai-codex', context_length: 272000 } }).contextLimitTokens, 272000);
  assert.equal(contextAccountingSnapshot({ runtime: { model: 'gpt-6.1-sol-900k', provider: 'openai-codex', context_length: 872000 } }).contextLimitTokens, 872000);
});

test('old inferred catalog cache is recalculated rather than keeping the old 256k guess', () => {
  const rows = [{ id: 'openai-codex::gpt-6.1-sol', rawModelId: 'gpt-6.1-sol', provider: 'openai-codex', source: 'cache', contextTokens: 256000 }];
  assert.equal(normalizeHermesModels(rows, rows[0].id)[0].contextTokens, 272000);
  rows[0].hermesContextTokens = 123456;
  assert.equal(normalizeHermesModels(rows, rows[0].id)[0].contextTokens, 123456);
  const reported = normalizeHermesModels([{ id: 'custom-model', provider: 'custom', context_length: 654321 }], 'custom-model');
  const cached = normalizeHermesModels(reported.map(row => ({ ...row, source: 'cache' })), 'custom-model');
  assert.equal(normalizeHermesModels(cached, 'custom-model')[0].contextTokens, 654321);
});

test('model switch reads effective window from status before falling back to catalog', () => {
  const source = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
  assert.match(source, /runtime\.context_length = runtimeContextTokens\(statusPayload\.runtime \|\| statusPayload\) \|\|/);
});
