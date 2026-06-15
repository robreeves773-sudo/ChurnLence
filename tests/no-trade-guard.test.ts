// Codifies the alert-only invariant: there must be ZERO trade-execution /
// exchange-auth code anywhere in src. We scan for trading-API patterns rather
// than the bare words "order"/"trade"/"private" because those appear in benign
// contexts (CSS `border`, the TS `private` keyword) — the requirement is about
// trading ENDPOINTS, which these patterns target precisely.

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(__dirname, '..', 'src');

const FORBIDDEN: RegExp[] = [
  /create[_-]?order/i,
  /place[_-]?order/i,
  /cancel[_-]?order/i,
  /\/(v\d+\/)?(private|order|orders|trade|account|withdraw)\b/i,
  /api[_-]?secret/i,
  /secret[_-]?key/i,
  /x-mbx-apikey/i,
  /apiKey\s*[:=]/i,
  /hmac/i,
  /signRequest|sign\(/i,
];

const ALLOWED_HOSTS = ['api.coingecko.com', 'ntfy.sh'];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx|css)$/.test(name)) out.push(p);
  }
  return out;
}

describe('alert-only invariant', () => {
  const files = walk(SRC);

  it('contains no trade-execution / exchange-auth code paths', () => {
    const hits: string[] = [];
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      for (const re of FORBIDDEN) {
        if (re.test(text)) hits.push(`${f} :: ${re}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it('only ever talks to allowlisted public hosts', () => {
    const urlRe = /https?:\/\/([a-z0-9.-]+)/gi;
    const offending: string[] = [];
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      let m: RegExpExecArray | null;
      while ((m = urlRe.exec(text))) {
        const host = m[1].toLowerCase();
        if (host.includes('w3.org')) continue; // SVG namespace
        if (!ALLOWED_HOSTS.includes(host)) offending.push(`${f} -> ${host}`);
      }
    }
    expect(offending).toEqual([]);
  });
});
