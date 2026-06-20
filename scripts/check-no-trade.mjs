#!/usr/bin/env node
/**
 * Acceptance guard: "Zero trading/exchange-auth code paths."
 *
 * Fails the build if any forbidden token appears in the app source. This is the
 * automated form of the spec's `grep for "order", "trade", "private" must return
 * nothing` requirement.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const ROOTS = ['src', 'background'];
const FILES = ['capacitor.config.ts', 'index.html'];
const EXT = new Set(['.ts', '.tsx', '.js', '.mjs', '.html', '.css', '.json']);

// Whole-word, case-insensitive. These name exchange auth / trade execution.
const FORBIDDEN = [
  'order',
  'trade',
  'private',
  'withdraw',
  'apikey',
  'api_key',
  'api-key',
  'apisecret',
  'secret',
  'signature',
  'hmac',
  'placeorder',
  'neworder'
];
const PATTERN = new RegExp(`\\b(${FORBIDDEN.join('|')})\\b`, 'i');

function walk(path, out) {
  for (const entry of readdirSync(path)) {
    const full = join(path, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (EXT.has(extname(full))) out.push(full);
  }
}

const files = [...FILES];
for (const root of ROOTS) {
  try {
    walk(root, files);
  } catch {
    /* root may not exist */
  }
}

const hits = [];
for (const file of files) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  text.split('\n').forEach((line, i) => {
    if (PATTERN.test(line)) hits.push(`${file}:${i + 1}: ${line.trim()}`);
  });
}

if (hits.length) {
  console.error('✗ no-trade check FAILED — forbidden tokens found:');
  for (const h of hits) console.error('  ' + h);
  process.exit(1);
}
console.log(`✓ no-trade check passed — scanned ${files.length} files, zero trading/exchange-auth tokens.`);
