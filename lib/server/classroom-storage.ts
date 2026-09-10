import { promises as fs } from 'fs';
import path from 'path';
import type { NextRequest } from 'next/server';
import type { Scene, Stage } from '@/lib/types/stage';

// Classroom storage location. Override with CLASSROOMS_DATA_DIR env to land on
// a large drive; otherwise defaults to <project>/data (stock behavior).
const STORAGE_ROOT = process.env.CLASSROOMS_DATA_DIR ?? path.join(process.cwd(), 'data');
export const CLASSROOMS_DIR = path.join(STORAGE_ROOT, 'classrooms');
export const CLASSROOM_JOBS_DIR = path.join(STORAGE_ROOT, 'classroom-jobs');

// Legacy storage location (pre-env-config). Classrooms were previously written
// to <project>/data/classrooms. When the storage path moved to a non-project
// CLASSROOMS_DATA_DIR, the JSON made it to the new location but the per-classroom
// media subdirectories (written by the external narration pipeline) did not
// follow — stranding the audio. This migration copies any legacy data (including
// media dirs) into the current location so a future path change can never split
// the data again.
const LEGACY_CLASSROOMS_DIR = path.join(process.cwd(), 'data', 'classrooms');
const LEGACY_CLASSROOM_JOBS_DIR = path.join(process.cwd(), 'data', 'classroom-jobs');

/** Marker file: written once after the first successful legacy migration. */
const LEGACY_MIGRATION_MARKER = '.legacy-migration-complete';

async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true });
}

async function dirExists(dir: string): Promise<boolean> {
  try {
    return (await fs.stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Copy `src` over `dest` atomically: write a sibling temp file, then rename.
 *
 * A copy that dies mid-write (disk full, crash, kill) must never leave a
 * truncated file at `dest`: the destination's fresh mtime would beat the legacy
 * source on the next pass, the mtime guard would skip the retry, and the
 * completion marker would freeze the partial bytes in place forever. Writing
 * to a temp name and renaming means `dest` is either absent or complete.
 */
async function copyFileAtomic(src: string, dest: string) {
  const temp = `${dest}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.copyFile(src, temp);
    await fs.rename(temp, dest);
  } catch (err) {
    await fs.rm(temp, { force: true }).catch(() => {
      // Best-effort cleanup — the copy error is the one worth surfacing.
    });
    throw err;
  }
}

async function copyDirRecursive(src: string, dest: string) {
  await ensureDir(dest);
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDirRecursive(s, d);
    } else {
      // Never overwrite a newer destination: after a storage move, a classroom
      // regenerated into the new location must not be reverted by the stale
      // legacy copy on the next migration pass.
      try {
        const [srcStat, dstStat] = await Promise.all([fs.stat(s), fs.stat(d)]);
        if (dstStat.mtimeMs >= srcStat.mtimeMs) continue;
      } catch {
        // Destination missing (or stat raced) — fall through to the copy.
      }
      await copyFileAtomic(s, d);
    }
  }
}

/**
 * Migrate any legacy classroom data into the current storage location.
 * Runs at most once per storage root (guarded by a marker file), copies (never
 * deletes) legacy JSON + media subdirectories into CLASSROOMS_DIR /
 * CLASSROOM_JOBS_DIR, and never overwrites a newer destination file. In the
 * default same-path configuration it no-ops entirely (source === destination,
 * where fs.copyFile is platform-dependent).
 */
export async function migrateLegacyClassroomData(): Promise<void> {
  await ensureDir(STORAGE_ROOT);
  const marker = path.join(STORAGE_ROOT, LEGACY_MIGRATION_MARKER);
  try {
    await fs.access(marker);
    return; // Already migrated once — never rescan on every read.
  } catch {
    // No marker yet — first pass.
  }

  if (path.resolve(LEGACY_CLASSROOMS_DIR) !== path.resolve(CLASSROOMS_DIR)) {
    if (await dirExists(LEGACY_CLASSROOMS_DIR)) {
      await copyDirRecursive(LEGACY_CLASSROOMS_DIR, CLASSROOMS_DIR);
    }
  }
  if (path.resolve(LEGACY_CLASSROOM_JOBS_DIR) !== path.resolve(CLASSROOM_JOBS_DIR)) {
    if (await dirExists(LEGACY_CLASSROOM_JOBS_DIR)) {
      await copyDirRecursive(LEGACY_CLASSROOM_JOBS_DIR, CLASSROOM_JOBS_DIR);
    }
  }

  await fs.writeFile(marker, new Date().toISOString(), 'utf-8');
}

export async function ensureClassroomsDir() {
  await migrateLegacyClassroomData();
  await ensureDir(CLASSROOMS_DIR);
}

export async function ensureClassroomJobsDir() {
  await migrateLegacyClassroomData();
  await ensureDir(CLASSROOM_JOBS_DIR);
}

export async function writeJsonFileAtomic(filePath: string, data: unknown) {
  const dir = path.dirname(filePath);
  await ensureDir(dir);

  const tempFilePath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const content = JSON.stringify(data, null, 2);
  await fs.writeFile(tempFilePath, content, 'utf-8');
  await fs.rename(tempFilePath, filePath);
}

export function buildRequestOrigin(req: NextRequest): string {
  return req.headers.get('x-forwarded-host')
    ? `${req.headers.get('x-forwarded-proto') || 'http'}://${req.headers.get('x-forwarded-host')}`
    : req.nextUrl.origin;
}

export interface PersistedClassroomData {
  id: string;
  stage: Stage;
  scenes: Scene[];
  createdAt: string;
}

export function isValidClassroomId(id: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(id);
}

export async function readClassroom(id: string): Promise<PersistedClassroomData | null> {
  const filePath = path.join(CLASSROOMS_DIR, `${id}.json`);
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content) as PersistedClassroomData;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

export async function persistClassroom(
  data: {
    id: string;
    stage: Stage;
    scenes: Scene[];
  },
  baseUrl: string,
): Promise<PersistedClassroomData & { url: string }> {
  const classroomData: PersistedClassroomData = {
    id: data.id,
    stage: data.stage,
    scenes: data.scenes,
    createdAt: new Date().toISOString(),
  };

  await ensureClassroomsDir();
  const filePath = path.join(CLASSROOMS_DIR, `${data.id}.json`);
  await writeJsonFileAtomic(filePath, classroomData);

  return {
    ...classroomData,
    url: `${baseUrl}/classroom/${data.id}`,
  };
}
