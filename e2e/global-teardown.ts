import { existsSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

export default async function globalTeardown() {
  const pidFile = resolve(__dirname, '.worker.pid');
  if (!existsSync(pidFile)) return;
  try {
    process.kill(Number(readFileSync(pidFile, 'utf8')));
  } catch {
    // already gone
  }
  rmSync(pidFile);
}
