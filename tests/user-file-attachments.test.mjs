import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import {
  createUserFileAttachment, normalizeUserFileAttachments, appendUserFileAttachments,
  stageUserFiles, attachmentFileContext, rememberUserFileAttachments,
  restoreUserFileAttachments, openUserFileAttachment, FILE_ATTACHMENT_MAX_BYTES,
} from '../extension/lib/user-file-attachments.mjs';
import { preserveUserImageAttachments } from '../extension/lib/image-render.mjs';
import { serializeComposerAttachment } from '../extension/lib/composer-draft.mjs';

function memoryStore() {
  const files = new Map();
  const bindings = new Map();
  return {
    async putFile(id, value) { files.set(id, value); },
    async getFile(id) { return files.get(id) || null; },
    async putBinding(value) { bindings.set(value.id, value); },
    async getBindings(scopeKey) { return [...bindings.values()].filter(b => b.scopeKey === scopeKey); },
  };
}

for (const [name, mime, content] of [
  ['handoff.md', 'text/markdown', '# Handoff\nRead the entire original file.'],
  ['data.csv', 'text/csv', 'name,value\nalpha,1\n"quoted, field",2'],
  ['sheet.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', new Uint8Array([80, 75, 3, 4, 0, 255])],
  ['slides.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', new Uint8Array([80, 75, 3, 4, 3, 254])],
  ['document.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', new Uint8Array([80, 75, 3, 4, 6, 253])],
  ['clip.mp4', 'video/mp4', new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 0, 255])],
]) test(`original bytes remain retrievable and upload unchanged: ${name}`, async () => {
  // Office/video arrays are deliberately synthetic byte-preservation fixtures,
  // not proof of Office parsing or codec playback.
  const store = memoryStore();
  const file = new File([content], name, { type: mime });
  const item = await createUserFileAttachment(file, { store });
  assert.equal(item.name, name);
  assert.equal(item.label, name);
  assert.equal(item.size, file.size);
  const retained = await store.getFile(item.blobId);
  assert.deepEqual(new Uint8Array(await retained.blob.arrayBuffer()), new Uint8Array(await file.arrayBuffer()));
  const calls = [];
  const client = { async request(method, params) {
    calls.push({ method, params });
    return { attached: true, path: `C:/fixture/attachments/${name}`, ref_text: `@file:"C:/fixture/attachments/${name}"` };
  } };
  await stageUserFiles(client, 'live-1', [item], { store, sourceKey: 'route-1' });
  assert.equal(calls[0].method, 'file.attach');
  assert.equal(calls[0].params.session_id, 'live-1');
  const bytes = Buffer.from(calls[0].params.data_url.split(',')[1], 'base64');
  assert.deepEqual(bytes, Buffer.from(await file.arrayBuffer()));
  assert.match(attachmentFileContext(item), /@file:/);
  assert.equal(item.localPath, `C:/fixture/attachments/${name}`);
});

test('a large CSV keeps its complete blob while the inline preview is bounded', async () => {
  const text = 'header\n' + 'full row,1\n'.repeat(4000);
  const store = memoryStore();
  const item = await createUserFileAttachment(new File([text], 'large.csv', { type: 'text/csv' }), { store });
  assert.ok(item.text.length <= 12_000);
  assert.equal(item.textTruncated, true);
  assert.equal(await (await store.getFile(item.blobId)).blob.text(), text);
});

test('binary Office content is never decoded as pretend UTF-8 text', async () => {
  const item = await createUserFileAttachment(new File([new Uint8Array([0, 255, 1])], 'slides.pptx'), { store: memoryStore() });
  assert.equal(item.text, '');
});

test('files over the explicit upload bound are rejected before caching', async () => {
  const store = memoryStore();
  const file = { name: 'large.mp4', type: 'video/mp4', size: FILE_ATTACHMENT_MAX_BYTES + 1 };
  await assert.rejects(createUserFileAttachment(file, { store }), /attachment_too_large/);
});

test('a refused or unconfirmed upload never publishes a server path', async () => {
  for (const result of [{ attached: false }, { attached: true }, { attached: true, path: '', ref_text: '' }]) {
    const store = memoryStore();
    const item = await createUserFileAttachment(new File(['x'], 'file.md'), { store });
    await assert.rejects(stageUserFiles({ request: async () => result }, 'live', [item], { store, sourceKey: 'route' }));
    assert.equal(item.localPath || '', '');
  }
});

test('unknown file.attach is a visible attachment failure, not metadata-only success', async () => {
  const store = memoryStore();
  const item = await createUserFileAttachment(new File(['x'], 'file.md'), { store });
  await assert.rejects(stageUserFiles({ request: async () => { throw new Error('Unknown method'); } }, 'live', [item], { store, sourceKey: 'route' }), e => e.attachmentFailure === true);
});

test('upload reuse is limited to the same gateway/profile and live session', async () => {
  const store = memoryStore();
  const item = await createUserFileAttachment(new File(['x'], 'file.md'), { store });
  let calls = 0;
  const client = { request: async () => { calls++; return { attached: true, path: '/fixture/file.md', ref_text: '@file:/fixture/file.md' }; } };
  await stageUserFiles(client, 'one', [item], { store, sourceKey: 'A' });
  await stageUserFiles(client, 'one', [item], { store, sourceKey: 'A' });
  assert.equal(calls, 1);
  await stageUserFiles(client, 'two', [item], { store, sourceKey: 'A' });
  await stageUserFiles(client, 'two', [item], { store, sourceKey: 'B' });
  assert.equal(calls, 3);
});

test('composer draft retains blob identity without serializing binary bytes', async () => {
  const store = memoryStore();
  const item = await createUserFileAttachment(new File(['full file'], 'file.md'), { store });
  const saved = serializeComposerAttachment(item);
  assert.equal(saved.blobId, item.blobId);
  assert.equal(saved.name, item.name);
  assert.equal(saved.dataUrl, undefined);
});

test('generic files survive immediate history refresh and retain images in mixed turns', () => {
  const local = [{ role: 'user', content: 'Review this', attachments: [{ kind: 'file', name: 'handoff.md', blobId: 'blob-1', text: '# plan' }] }];
  const rows = preserveUserImageAttachments([{ role: 'user', content: 'Review this' }], local);
  assert.equal(rows[0].attachments[0].name, 'handoff.md');
});

test('cold history restoration is session/route scoped and maps repeated prompts newest-first', async () => {
  const store = memoryStore();
  const a = await createUserFileAttachment(new File(['first'], 'first.md'), { store });
  const b = await createUserFileAttachment(new File(['second'], 'second.csv'), { store });
  await rememberUserFileAttachments('route', 'durable', 'Review this', [a], { store });
  await rememberUserFileAttachments('route', 'durable', 'Review this', [b], { store });
  const history = [{ role: 'user', content: 'Review this' }, { role: 'assistant', content: 'done' }, { role: 'user', content: 'Review this' }];
  const restored = await restoreUserFileAttachments(history, 'route', 'durable', { store });
  assert.equal(restored[0].attachments[0].name, 'first.md');
  assert.equal(restored[2].attachments[0].name, 'second.csv');
  assert.strictEqual(await restoreUserFileAttachments(history, 'other', 'durable', { store }), history);
  assert.strictEqual(await restoreUserFileAttachments(history, 'route', 'other', { store }), history);
});

test('file cards expose Open and Download and never inject a filename as HTML', () => {
  const { document } = parseHTML('<html><body><div id="files"></div></body></html>');
  let opened = 0, downloaded = 0;
  appendUserFileAttachments(document.getElementById('files'), [{ kind: 'file', name: '<img src=x onerror=evil()>', blobId: 'blob-1', size: 16 }], {
    translate: key => key, onOpen: () => { opened++; }, onDownload: () => { downloaded++; },
  });
  assert.equal(document.querySelectorAll('.user-file-card').length, 1);
  assert.equal(document.querySelectorAll('img,script').length, 0);
  document.querySelector('[data-file-action="open"]').click();
  document.querySelector('[data-file-action="download"]').click();
  assert.equal(opened, 1); assert.equal(downloaded, 1);
});

test('Markdown/HTML preview uses textContent rather than executing attachment markup', async () => {
  const store = memoryStore();
  const item = await createUserFileAttachment(new File(['<script>evil()</script>'], 'page.html', { type: 'text/html' }), { store });
  const { document } = parseHTML('<html><body></body></html>');
  await openUserFileAttachment(item, { store, document, translate: key => key });
  assert.equal(document.querySelector('pre').textContent, '<script>evil()</script>');
  assert.equal(document.querySelectorAll('script').length, 0);
});

test('normalization ignores unrelated attachments and preserves generic file names', () => {
  const files = normalizeUserFileAttachments([{ kind: 'image', name: 'image.png' }, { kind: 'url', name: 'url' }, { kind: 'file', name: 'data.csv', blobId: 'blob-1' }]);
  assert.deepEqual(files.map(f => f.name), ['data.csv']);
});
