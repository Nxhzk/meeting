import { mkdir, mkdtemp, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const output = fileURLToPath(new URL('../../static/meeting/', import.meta.url));
await mkdir(join(output, 'assets'), { recursive: true });
// Stage on the same filesystem so Flask never reads a partly written manifest.
const stage = await mkdtemp(join(output, '.publish-'));
try {
    await build({ build: { outDir: stage } });
    for (const asset of await readdir(join(stage, 'assets'))) {
        await rename(join(stage, 'assets', asset), join(output, 'assets', asset));
    }
    await rename(join(stage, 'manifest.json'), join(output, 'manifest.json'));
} finally {
    await rm(stage, { recursive: true, force: true });
}
