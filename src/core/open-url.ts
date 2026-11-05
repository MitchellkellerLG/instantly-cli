import { spawn } from 'node:child_process';

/** Hosts that may receive an OAuth browser launch. Anything else is printed, never opened. */
const OAUTH_HOSTS = [
  'accounts.google.com',
  'login.microsoftonline.com',
  'login.microsoft.com',
  'login.live.com',
  'instantly.ai',
];

export type Spawner = (command: string, args: string[]) => void;

const defaultSpawner: Spawner = (command, args) => {
  // No shell: the URL is a single argv element and is never interpreted.
  const child = spawn(command, args, { stdio: 'ignore', detached: true, shell: false });
  child.on('error', () => { /* the user can copy the URL manually */ });
  child.unref();
};

/** Returns the normalized URL when it is an https OAuth URL on a known provider host, else undefined. */
export function safeOAuthUrl(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  let url: URL;
  try { url = new URL(raw); } catch { return undefined; }
  if (url.protocol !== 'https:' || url.username || url.password) return undefined;
  const host = url.hostname.toLowerCase();
  const ok = OAUTH_HOSTS.some(h => host === h || host.endsWith('.' + h));
  return ok ? url.href : undefined;
}

export function openCommandFor(url: string, platform: NodeJS.Platform = process.platform): [string, string[]] {
  if (platform === 'darwin') return ['open', [url]];
  if (platform === 'win32') return ['rundll32', ['url.dll,FileProtocolHandler', url]];
  return ['xdg-open', [url]];
}

/** Opens a validated OAuth URL without a shell. Returns false when the URL was refused. */
export function openOAuthUrl(raw: unknown, spawner: Spawner = defaultSpawner, platform: NodeJS.Platform = process.platform): boolean {
  const url = safeOAuthUrl(raw);
  if (!url) return false;
  const [command, args] = openCommandFor(url, platform);
  spawner(command, args);
  return true;
}
