import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import fsSync from 'fs';
import os from 'os';
import path from 'path';

/**
 * Unit tests for the legacy classroom-data migration (review finding 2):
 *  - runs at most once per storage root (marker-gated)
 *  - never overwrites a newer destination file
 *  - no-ops entirely when legacy path === current path (default config)
 *
 * The legacy dir is hardcoded to <cwd>/data/classrooms, so each test chdirs
 * into a sandboxed project root and points CLASSROOMS_DATA_DIR at a separate
 * "current" root to exercise the copy path.
 */

const TMP = fsSync.realpathSync(os.tmpdir());
const ROOT = path.join(TMP, 'openmaic-classroom-storage-test');
const PROJECT = path.join(ROOT, 'project'); // legacy = <cwd>/data
const CURRENT = path.join(ROOT, 'current'); // CLASSROOMS_DATA_DIR

const originalCwd = process.cwd();

async function writeFile(p: string, content: string, mtimeMs: number) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, content);
  await fs.utimes(p, new Date(mtimeMs), new Date(mtimeMs));
}

async function readFile(p: string): Promise<string | null> {
  try {
    return await fs.readFile(p, 'utf-8');
  } catch {
    return null;
  }
}

function legacyClassrooms() {
  return path.join(PROJECT, 'data', 'classrooms');
}

describe('migrateLegacyClassroomData', () => {
  beforeEach(async () => {
    await fs.rm(ROOT, { recursive: true, force: true });
    await fs.mkdir(PROJECT, { recursive: true });
    process.env.CLASSROOMS_DATA_DIR = CURRENT;
    process.chdir(PROJECT);
    vi.resetModules();
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    delete process.env.CLASSROOMS_DATA_DIR;
    await fs.rm(ROOT, { recursive: true, force: true });
  });

  test('copies legacy data once and marks completion', async () => {
    await writeFile(
      path.join(legacyClassrooms(), 'abc.json'),
      '{"legacy":true}',
      Date.now(),
    );

    const { migrateLegacyClassroomData, CLASSROOMS_DIR } = await import(
      '@/lib/server/classroom-storage'
    );

    await migrateLegacyClassroomData();
    expect(CLASSROOMS_DIR).toBe(path.join(CURRENT, 'classrooms'));
    expect(await readFile(path.join(CLASSROOMS_DIR, 'abc.json'))).toBe('{"legacy":true}');
    expect(
      await readFile(path.join(CURRENT, '.legacy-migration-complete')),
    ).not.toBeNull();
  });

  test('second call is a no-op even if legacy data changed', async () => {
    await writeFile(path.join(legacyClassrooms(), 'abc.json'), '{"v":1}', Date.now());

    const { migrateLegacyClassroomData, CLASSROOMS_DIR } = await import(
      '@/lib/server/classroom-storage'
    );

    await migrateLegacyClassroomData();
    // Simulate a NEWER classroom regenerated into the current location.
    await writeFile(path.join(CLASSROOMS_DIR, 'abc.json'), '{"v":2}', Date.now() + 100_000);

    // Stale legacy copy now differs — a non-marker-gated migration would revert v2.
    await writeFile(
      path.join(legacyClassrooms(), 'abc.json'),
      '{"v":1,"stale":true}',
      Date.now() + 50_000,
    );

    await migrateLegacyClassroomData();
    expect(await readFile(path.join(CLASSROOMS_DIR, 'abc.json'))).toBe('{"v":2}');
  });

  test('never overwrites a newer destination in the copy pass', async () => {
    const current = path.join(CURRENT, 'classrooms');
    // Destination exists and is NEWER than the legacy source. Marker-gating is
    // bypassed by deleting the marker so the copy guard itself is exercised.
    await writeFile(path.join(current, 'abc.json'), '{"new":true}', Date.now());
    await writeFile(
      path.join(legacyClassrooms(), 'abc.json'),
      '{"legacy":true}',
      Date.now() - 100_000,
    );

    const { migrateLegacyClassroomData, CLASSROOMS_DIR } = await import(
      '@/lib/server/classroom-storage'
    );

    await migrateLegacyClassroomData();
    // First pass: marker absent, dest newer → still guarded.
    expect(await readFile(path.join(CLASSROOMS_DIR, 'abc.json'))).toBe('{"new":true}');
  });

  test('same-path default configuration does not copy onto itself', async () => {
    // Simulate the default layout (env var unset): legacy and current both
    // resolve to <cwd>/data/classrooms, where copyFile(src, src) is undefined.
    delete process.env.CLASSROOMS_DATA_DIR;
    await fs.mkdir(legacyClassrooms(), { recursive: true });

    const { migrateLegacyClassroomData, CLASSROOMS_DIR } = await import(
      '@/lib/server/classroom-storage'
    );
    expect(CLASSROOMS_DIR).toBe(legacyClassrooms());

    await migrateLegacyClassroomData(); // must not throw on same-path copy
    expect(
      await readFile(path.join(PROJECT, 'data', '.legacy-migration-complete')),
    ).not.toBeNull();
  });

  test('a copy that dies mid-write leaves no partial destination behind', async () => {
    // Review finding: copyFile wrote destinations in place, so a crash mid-copy
    // left a truncated file whose fresh mtime beat the legacy source. The next
    // pass skipped it via the mtime guard and the completion marker froze the
    // partial bytes in place permanently. Copying via temp + rename means the
    // destination is only ever absent or complete.
    await writeFile(
      path.join(legacyClassrooms(), 'abc.json'),
      '{"legacy":true}',
      Date.now(),
    );

    const { migrateLegacyClassroomData, CLASSROOMS_DIR } = await import(
      '@/lib/server/classroom-storage'
    );

    // Simulate the crash: bytes land, then the write throws (disk full).
    const spy = vi
      .spyOn(fs, 'copyFile')
      .mockImplementation(async (_src: fsSync.PathLike, dest: fsSync.PathLike) => {
        await fs.writeFile(dest, '{"legacy":'); // truncated
        throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
      });

    await expect(migrateLegacyClassroomData()).rejects.toThrow('ENOSPC');
    spy.mockRestore();

    // No truncated destination and no temp litter, and the marker was NOT
    // written — so the next boot retries instead of freezing the partial file.
    expect(await readFile(path.join(CLASSROOMS_DIR, 'abc.json'))).toBeNull();
    expect((await fs.readdir(CLASSROOMS_DIR)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    expect(await readFile(path.join(CURRENT, '.legacy-migration-complete'))).toBeNull();

    // The retry on the next pass completes the copy for real.
    await migrateLegacyClassroomData();
    expect(await readFile(path.join(CLASSROOMS_DIR, 'abc.json'))).toBe('{"legacy":true}');
    expect(await readFile(path.join(CURRENT, '.legacy-migration-complete'))).not.toBeNull();
  });
});
