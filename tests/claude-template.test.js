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

// Consumers rewrite the repo-owned block, so `callum-dev update`'s 3-way merge conflicts on any
// line the template changes inside it. A shared rule goes in the synced part above the block.
// Change this pin only when a release deliberately reshapes the block and says so in its notes.
test('the template repo-owned block is unchanged, so consumer updates merge cleanly', () => {
  const blocks = read('templates/CLAUDE.md').match(/<!-- repo-owned[\s\S]*?<!-- end repo-owned -->/g);
  const sha = require('node:crypto').createHash('sha256').update(blocks.join('\n')).digest('hex');
  assert.strictEqual(sha, '49e919eb8552000ed1ebe5c74f4d9d388c7d8518bf498f1e375dafd53adc7fbe');
});
