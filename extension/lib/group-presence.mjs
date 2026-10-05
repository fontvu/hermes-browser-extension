// Pure reducer turning Bot Mode runtime activity into per-member presence.
// The strip and the in-thread live bubble both read this single state.

const TERMINAL = new Set(['replied', 'passed', 'failed']);
const ACTIVE = new Set(['working', 'typing', 'tool']);
// Only these kinds can move a member. Anything else (a future payload, a
// transport-level diagnostic) must not invent a member or reopen a turn.
const MEMBER_KINDS = new Set(['working', 'typing', 'tool_start', 'tool_complete', 'reply', 'pass', 'failed', 'retry']);

export function createPresenceState() {
  return { members: [], order: [], phase: 'idle' };
}

function cloneMembers(state) {
  return asList(state?.members).map((entry) => ({ ...entry }));
}

function asList(value) {
  return Array.isArray(value) ? value : [];
}

function upsert(members, order, member, roleLabel, now) {
  const name = String(member ?? '');
  let index = members.findIndex((entry) => entry.member === name);
  if (index === -1) {
    members.push({
      member: name,
      roleLabel: roleLabel ?? name,
      state: 'working',
      tool: '',
      error: '',
      text: '',
      changedAt: now,
    });
    order.push(name);
    index = members.length - 1;
  } else if (roleLabel) {
    members[index].roleLabel = roleLabel;
  }
  return index;
}

function setState(entry, next, now, patch = {}) {
  entry.state = next;
  entry.changedAt = now;
  Object.assign(entry, patch);
}

export function reducePresence(state, activity = {}, { now = Date.now() } = {}) {
  const base = state && typeof state === 'object' ? state : createPresenceState();
  const members = cloneMembers(base);
  const order = asList(base.order).slice();
  let phase = base.phase || 'idle';
  const kind = activity?.kind;

  if (kind === 'turn_start') {
    const roster = asList(activity.members);
    members.length = 0;
    order.length = 0;
    for (const row of roster) {
      const name = String(row?.member ?? '');
      members.push({
        member: name,
        roleLabel: row?.roleLabel ?? name,
        state: 'queued',
        tool: '',
        error: '',
        text: '',
        changedAt: now,
      });
      order.push(name);
    }
    phase = 'running';
    return { members, order, phase };
  }

  if (kind === 'idle') {
    return { members, order, phase: 'done' };
  }

  const name = String(activity?.member ?? '');
  if (!name) return { members, order, phase };
  if (!MEMBER_KINDS.has(String(kind))) return { members, order, phase };

  const index = upsert(members, order, name, activity?.roleLabel, now);
  const entry = members[index];
  if (phase === 'idle') phase = 'running';

  switch (kind) {
    case 'working':
      if (!TERMINAL.has(entry.state)) setState(entry, 'working', now, { tool: '' });
      break;
    case 'retry':
      // A per-member retry reopens ONLY that member: reset it to queued (a
      // terminal failure would otherwise reject the following working frame)
      // and clear the stale reason, without disturbing the other members or
      // the room order. Phase returns to running so the strip stays visible.
      setState(entry, 'queued', now, { error: '', tool: '', text: '' });
      phase = 'running';
      break;
    case 'typing':
      // A late typing frame must not resurrect a member that already finished.
      if (!TERMINAL.has(entry.state)) setState(entry, 'typing', now, { text: String(activity.text ?? '') });
      break;
    case 'tool_start':
      if (!TERMINAL.has(entry.state)) setState(entry, 'tool', now, { tool: String(activity.tool ?? '') });
      break;
    case 'tool_complete':
      if (!TERMINAL.has(entry.state)) {
        const back = entry.text ? 'typing' : 'working';
        setState(entry, back, now, { tool: '' });
      }
      break;
    case 'reply':
      setState(entry, 'replied', now, { text: '', tool: '' });
      break;
    case 'pass':
      setState(entry, 'passed', now, { text: '', tool: '' });
      break;
    case 'failed':
      setState(entry, 'failed', now, { error: String(activity.error ?? ''), tool: '' });
      break;
    default:
      break;
  }
  return { members, order, phase };
}

function fill(template, values) {
  return String(template).replace(/\{(\w+)\}/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match);
}

// Collapse a raw runtime failure into one short, human reason. Usage/quota and
// rate-limit signals (HTTP 402/429, "usage limit", "rate limit", quota, too many
// requests) share a single actionable line; everything else is generic. Pure and
// exported so the mapping is unit tested and every caller reads the same copy.
const USAGE_LIMIT_RE = /(?:usage|rate|token|request|plan)[\s_-]*limit|quota|too many requests|\b429\b|\b402\b|insufficient (?:quota|credit|credits|funds)/i;

export function failureReason(error, { translate = (s) => s } = {}) {
  const t = typeof translate === 'function' ? translate : (s) => s;
  const text = String(error ?? '');
  if (text && USAGE_LIMIT_RE.test(text)) return t('Usage limit reached, try again later');
  return t('Something went wrong');
}

export function presenceSummary(state, { translate = (s) => s } = {}) {
  const members = asList(state?.members);
  if (members.length === 0) return '';
  const t = typeof translate === 'function' ? translate : (s) => s;

  const active = members.find((entry) => ACTIVE.has(entry.state));
  const waiting = members.filter((entry) => entry.state === 'queued').length;

  if (active) {
    let phrase;
    if (active.state === 'typing') phrase = fill(t('{name} is typing'), { name: active.member });
    else if (active.state === 'tool') phrase = fill(t('{name} is using {tool}'), { name: active.member, tool: active.tool });
    else phrase = fill(t('{name} is replying'), { name: active.member });
    return waiting > 0 ? `${phrase} · ${fill(t('{count} waiting'), { count: waiting })}` : phrase;
  }

  // A queued member has not replied, on any phase. The runtime still emits
  // `idle` after an abort breaks the member loop, so gating this on the running
  // phase would announce completion over a member that never ran.
  if (waiting > 0) return fill(t('{count} waiting'), { count: waiting });

  const failed = members.filter((entry) => entry.state === 'failed').length;
  const passed = members.filter((entry) => entry.state === 'passed').length;
  if (failed > 0) {
    // Never claim "Done" over a member that failed. State the real split so the
    // summary cannot contradict the failure notice above it.
    const replied = members.filter((entry) => entry.state === 'replied').length;
    return fill(t('{replied} replied, {failed} couldn\'t'), { replied, failed });
  }
  if (passed > 0) return fill(t('All done · {count} passed'), { count: passed });
  return t('All replied');
}