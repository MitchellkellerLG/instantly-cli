import { readFile } from 'node:fs/promises';
import { allCommands } from '../src/commands/index.js';
import { coverage, SPEC_URL } from './openapi.js';

const file = process.argv[2];
const spec = file === '--live'
  ? await fetch(SPEC_URL, { signal: AbortSignal.timeout(30_000) }).then(r => { if (!r.ok) throw new Error(`Spec HTTP ${r.status}`); return r.json(); })
  : JSON.parse(await readFile(file ?? new URL('../spec/api_v2.json', import.meta.url), 'utf8'));
const report = coverage(spec, allCommands);
console.log(JSON.stringify(report, null, 2));
if (report.missing.length) process.exitCode = 1;
