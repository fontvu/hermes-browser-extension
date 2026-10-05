import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../extension/sidepanel.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

test('Control Apply fills its own row instead of leaving a blank right-aligned action row', () => {
  const rule = css.match(/\.browser-control-dialog \.browser-control-apply-scope\s*\{([^}]+)\}/)?.[1];
  assert.ok(rule);
  assert.match(rule, /justify-self:\s*stretch/);
  assert.match(rule, /width:\s*100%/);
  assert.match(rule, /justify-content:\s*center/);
});

test('scope tab list shares branded scrollbar size and thumb with the dialog', () => {
  assert.match(css, /\.browser-control-tab-list::-webkit-scrollbar,/);
  assert.match(css, /\.browser-control-tab-list::-webkit-scrollbar-thumb,/);
  assert.match(css, /\.browser-control-tab-list::-webkit-scrollbar-button\s*\{[^}]*display:\s*none/);
  // Non-auto standardized properties override custom WebKit thumbs in Chromium.
  assert.match(css, /@supports selector\(::-webkit-scrollbar\)\s*\{\s*\.browser-control-tab-list\s*\{[^}]*scrollbar-width:\s*auto;[^}]*scrollbar-color:\s*auto;/);
});
