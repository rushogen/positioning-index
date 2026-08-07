#!/usr/bin/env node
/**
 * METHODOLOGY.md lives at the repository root because that is where a reader on
 * GitHub looks for it. The public site needs to serve it too, and there is no
 * build step, so this copies it into public/ as text/plain (browsers render
 * .txt inline and download .md).
 *
 * Wired into `npm run deploy` so the two cannot drift.
 */
import { readFile, writeFile } from 'node:fs/promises';

const src = new URL('../METHODOLOGY.md', import.meta.url);
const dest = new URL('../public/methodology.txt', import.meta.url);

const body = await readFile(src, 'utf8');
await writeFile(dest, body);
console.log(`synced METHODOLOGY.md -> public/methodology.txt (${body.length} bytes)`);
