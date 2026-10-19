#!/usr/bin/env node
'use strict';
// Expand-only check for the factory database migrations (docs/factory-db.md "Schema compatibility").
// Usage: node scripts/migration-lint.js [dir]   (default images/base/factory-db/migrations/)
// Prints `<file>:<line>: <what> (expand-only migrations, docs/factory-db.md)` on stderr per hit;
// exit 1 on any hit, 0 and no output when clean.

const fs = require('fs');
const path = require('path');

const DEFAULT_DIR = path.join(__dirname, '..', 'images', 'base', 'factory-db', 'migrations');
const SEMI = '\u0001'; // a ';' inside a dollar-quoted body, so statement splitting skips it

// Blank comments and single-quoted strings (newlines kept, so offsets and lines stay);
// a ';' inside a dollar-quoted body becomes SEMI. The body text itself is still scanned.
function sanitize(text) {
  let out = '';
  let i = 0;
  const blank = (s) => s.replace(/[^\n]/g, ' ');
  while (i < text.length) {
    const c = text[i];
    const two = text.slice(i, i + 2);
    if (two === '--') {
      let j = text.indexOf('\n', i);
      if (j < 0) j = text.length;
      out += blank(text.slice(i, j));
      i = j;
    } else if (two === '/*') {
      let depth = 1;
      let j = i + 2;
      while (j < text.length && depth > 0) {
        const t = text.slice(j, j + 2);
        if (t === '/*') { depth++; j += 2; } else if (t === '*/') { depth--; j += 2; } else j++;
      }
      out += blank(text.slice(i, j));
      i = j;
    } else if (c === "'") {
      const esc = /^[eE]$/.test(text[i - 1] || '') && !/[\w$]/.test(text[i - 2] || ''); // E'..' takes backslash escapes
      let j = i + 1;
      while (j < text.length) {
        if (esc && text[j] === '\\') { j += 2; continue; }
        if (text[j] === "'") {
          if (text[j + 1] === "'") { j += 2; continue; }
          break;
        }
        j++;
      }
      j = Math.min(j + 1, text.length);
      out += blank(text.slice(i, j));
      i = j;
    } else if (c === '"') {
      let j = text.indexOf('"', i + 1);
      j = j < 0 ? text.length : j + 1;
      out += text.slice(i, j);
      i = j;
    } else if (c === '$') {
      const m = /^\$([A-Za-z_]\w*)?\$/.exec(text.slice(i));
      const close = m ? text.indexOf(m[0], i + m[0].length) : -1;
      if (m && close >= 0) {
        const body = sanitize(text.slice(i + m[0].length, close)).replace(/;/g, SEMI);
        out += m[0] + body + m[0];
        i = close + m[0].length;
      } else {
        out += c;
        i++;
      }
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

const lineOf = (s, off) => s.slice(0, off).split('\n').length;
const norm = (n) => n.replace(/"/g, '').toLowerCase();
const NAME = '((?:"[^"]+"|[\\w$]+)(?:\\.(?:"[^"]+"|[\\w$]+))?)';

// Top-level (outside parentheses) comma-separated parts of s, with their offsets.
function splitActions(s) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i <= s.length; i++) {
    const c = s[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if ((c === ',' && depth === 0) || i === s.length) {
      parts.push({ text: s.slice(start, i), off: start });
      start = i + 1;
    }
  }
  return parts;
}

function check(text) {
  const clean = sanitize(text);
  const hits = [];
  const add = (off, what) => hits.push({ line: lineOf(clean, off), what });

  const statements = [];
  let pos = 0;
  for (const piece of clean.split(';')) {
    statements.push({ text: piece, off: pos });
    pos += piece.length + 1;
  }

  const created = new Set();
  const creates = []; // CREATE VIEW names with offsets
  for (const st of statements) {
    let m = new RegExp(`^\\s*CREATE\\s+(?:(?:GLOBAL\\s+|LOCAL\\s+)?(?:TEMP(?:ORARY)?\\s+|UNLOGGED\\s+))?TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${NAME}`, 'i').exec(st.text);
    if (m) created.add(norm(m[1]));
    m = new RegExp(`^\\s*CREATE\\s+(?:OR\\s+REPLACE\\s+)?VIEW\\s+${NAME}`, 'i').exec(st.text);
    if (m) creates.push({ name: norm(m[1]), off: st.off });
  }

  for (const st of statements) {
    const t = st.text;
    const at = (idx) => st.off + idx;
    let m;

    const drop = /\bDROP\b/gi;
    while ((m = drop.exec(t))) {
      const rest = t.slice(m.index + 4);
      if (/^\s+NOT\s+NULL\b/i.test(rest)) continue;
      const v = new RegExp(`^\\s+VIEW\\s+(?:IF\\s+EXISTS\\s+)?${NAME}(\\s+RESTRICT)?\\s*$`, 'i').exec(rest);
      if (v && creates.some((c) => c.name === norm(v[1]) && c.off > st.off)) continue;
      add(at(m.index), 'DROP is forbidden (a view may be dropped only when the same file creates it again)');
    }

    const ren = /\bRENAME\b/gi;
    while ((m = ren.exec(t))) add(at(m.index), 'RENAME is forbidden');

    const rev = /\bREVOKE\b/gi;
    while ((m = rev.exec(t))) add(at(m.index), 'REVOKE is forbidden');

    if (/^\s*ALTER\s+TABLE\b/i.test(t)) {
      const ty = /\bALTER\s+(?:COLUMN\s+)?(?:"[^"]+"|[\w$]+)\s+(?:SET\s+DATA\s+)?TYPE\b/gi;
      while ((m = ty.exec(t))) add(at(m.index), 'a column type change is forbidden');
      const sn = /\bSET\s+NOT\s+NULL\b/gi;
      while ((m = sn.exec(t))) add(at(m.index), 'SET NOT NULL is forbidden');
      const head = new RegExp(`^\\s*ALTER\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?(?:ONLY\\s+)?${NAME}`, 'i').exec(t);
      const from = head ? head[0].length : 0;
      for (const a of splitActions(t.slice(from)).map((x) => ({ text: x.text, off: x.off + from }))) {
        const lead = a.text.length - a.text.trimStart().length;
        const body = a.text.trimStart();
        const aoff = at(a.off + lead);
        if (/^ADD\s+(?:CONSTRAINT\s+(?:"[^"]+"|[\w$]+)\s+)?(?:CHECK|UNIQUE|PRIMARY\s+KEY|FOREIGN\s+KEY|EXCLUDE)\b/i.test(body)) {
          add(aoff, 'ADD of a constraint is forbidden (it narrows what a writer may send)');
        } else if (/^ADD\b/i.test(body) && /\bNOT\s+NULL\b/i.test(body) && !/\bDEFAULT\b/i.test(body)) {
          add(aoff, 'ADD COLUMN ... NOT NULL needs a DEFAULT');
        }
      }
    }

    if (/^\s*ALTER\s+DOMAIN\b/i.test(t)) {
      const m2 = /\bADD\s+CONSTRAINT\b/i.exec(t);
      if (m2) add(at(m2.index), 'ALTER DOMAIN ... ADD CONSTRAINT is forbidden');
    }

    m = new RegExp(`^\\s*CREATE\\s+UNIQUE\\s+INDEX\\b[^]*?\\bON\\s+(?:ONLY\\s+)?${NAME}`, 'i').exec(t);
    if (m && !created.has(norm(m[1]))) {
      add(at(t.search(/\bUNIQUE\b/i)), 'CREATE UNIQUE INDEX on a table not created in this file is forbidden');
    }
  }

  return hits.sort((a, b) => a.line - b.line);
}

function main(argv) {
  const dir = argv[2] || DEFAULT_DIR;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  let bad = 0;
  for (const f of files) {
    for (const h of check(fs.readFileSync(path.join(dir, f), 'utf8'))) {
      process.stderr.write(`${f}:${h.line}: ${h.what} (expand-only migrations, docs/factory-db.md)\n`);
      bad++;
    }
  }
  return bad ? 1 : 0;
}

if (require.main === module) process.exit(main(process.argv));
module.exports = { check, sanitize };
