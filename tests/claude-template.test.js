'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

test('baseline CLAUDE.md is a byte copy of the template', () => {
  assert.strictEqual(read('.callum-dev/baseline/CLAUDE.md'), read('templates/CLAUDE.md'));
});

test('template and root CLAUDE.md carry the plain-language rule', () => {
  for (const p of ['templates/CLAUDE.md', 'CLAUDE.md']) {
    const s = read(p).replace(/\s+/g, ' ');
    assert.match(s, /lead with what needs to happen next and who has to do it/, p);
    assert.match(s, /whether the owner is the one who must act/, p);
    assert.match(s, /markdown link to it, never a bare `#N`/, p);
  }
});

test('template and root CLAUDE.md say what a loop agent leaves to the loop, in the synced part', () => {
  for (const p of ['templates/CLAUDE.md', 'CLAUDE.md']) {
    const synced = read(p).split('<!-- end synced -->')[0].replace(/\s+/g, ' ');
    assert.match(synced, /## Two ways work gets done/, p);
    assert.match(synced, /never run no-mistakes/, p);
    assert.match(synced, /\*\*The manual path\*\*/, p);
    assert.match(synced, /runs only the subsets it changes and leaves the full gate commands to that stop gate/, p);
  }
});

test('template placeholder ties the capture doc to uiCapture, and onboarding decides all three cases', () => {
  const m = /e2e visual verification tooling \(([^)]*)\)/.exec(read('templates/CLAUDE.md'));
  assert.ok(m, 'placeholder parses without a ) inside');
  const inner = m[1].replace(/\s+/g, ' ');
  assert.match(inner, /uiCapture/);
  assert.match(inner, /n\/a - no UI/);
  const doc = read('docs/onboarding.md');
  assert.match(doc, /### 3h\. UI capture/);
  assert.match(doc, /"uiCapture": "none"/);
  assert.match(doc, /npm run e2e:capture/);
  assert.match(doc, /UI capture is set up or turned off \(`uiCapture` set in `\.claude\/factory-loop\.json`\)/);
});
