import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Snapshot } from '../types.ts';

export function getDefaultCacheDirectory(): string {
  const cacheHome = process.env.XDG_CACHE_HOME || join(homedir(), '.cache');

  return join(cacheHome, 'pxtree');
}

export function getSnapshotKey(keyParts: unknown[]): string {
  return createHash('sha1').update(JSON.stringify(keyParts)).digest('hex');
}

export async function readSnapshot(cacheDirectory: string, snapshotKey: string): Promise<Snapshot | null> {
  try {
    const snapshot = JSON.parse(await readFile(join(cacheDirectory, `${snapshotKey}.json`), 'utf8')) as Snapshot;

    return snapshot.version === 3 ? snapshot : null;
  } catch {
    return null;
  }
}

export async function writeSnapshot(cacheDirectory: string, snapshotKey: string, snapshot: Snapshot): Promise<void> {
  await mkdir(cacheDirectory, { recursive: true });
  await writeFile(join(cacheDirectory, `${snapshotKey}.json`), JSON.stringify(snapshot));
}
