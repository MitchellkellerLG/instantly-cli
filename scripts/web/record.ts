/**
 * Records one redacted fixture per private web route from the attended, signed-in test workspace.
 * With workspace API credentials and INSTANTLY_WEB_BROWSER_URL configured, run: npx tsx scripts/web/record.ts
 * Browser session headers and cookies stay in-page; API credentials establish the expected workspace.
 * Strings are masked (only short lowercase enum-like words survive); numbers, booleans and structure are kept.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { createCommandContext } from '../../src/core/command-context.js';
import { webReadCommands as webCommands } from '../../src/commands/web/index.js';
import { leaks, redactText } from '../../src/web/redact.js';
import { SAMPLE_ARGS } from '../../tests/web/samples.js';

export function mask(value: unknown): unknown {
  if (Array.isArray(value)) return value.slice(0, 2).map(mask);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mask(v)]));
  if (typeof value === 'string') return /^[a-z_]{1,24}$/.test(value) ? value : '<string>';
  return value;
}

const { client } = await createCommandContext({ origin: 'web', mutating: false });
const dir = new URL('../../tests/fixtures/web/', import.meta.url).pathname;
mkdirSync(dir, { recursive: true });
const manifest: Record<string, string> = {};
for (const command of webCommands) {
  const args = command.inputSchema.parse(SAMPLE_ARGS[command.name] ?? {});
  try {
    const body = mask(await command.handler(args, client));
    const text = JSON.stringify({ id: command.name, args, body }, null, 2) + '\n';
    if (leaks(text)) throw new Error('fixture would contain secret-shaped text');
    writeFileSync(`${dir}${command.name}.json`, text);
    manifest[command.name] = 'recorded';
  } catch (error) {
    manifest[command.name] = redactText(String((error as Error).message)).slice(0, 120);
  }
}
writeFileSync(`${dir}manifest.json`, JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify(Object.values(manifest).reduce<Record<string, number>>((a, v) => { const k = v === 'recorded' ? 'recorded' : 'failed'; a[k] = (a[k] ?? 0) + 1; return a; }, {})));
