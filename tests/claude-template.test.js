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
  }
});
