import assert from 'node:assert';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { lock, sleep } from '../lockfile.js';

describe('lock', () => {
  const testRoot = path.join(os.tmpdir(), `lockfile-light-test-${process.pid}`);
  const lockDir = path.join(testRoot, 'shared.lock');

  beforeEach(() => {
    fs.rmSync(testRoot, { recursive: true, force: true });
    fs.mkdirSync(testRoot, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(testRoot, { recursive: true, force: true });
  });

  it('executes a callback and returns its name', async () => {
    let called = false;
    const name = await lock(lockDir, { name: 'task1' }, async () => {
      called = true;
    });
    assert.strictEqual(called, true);
    assert.strictEqual(name, 'task1');
    assert.strictEqual(fs.existsSync(lockDir), false);
  });

  it('allows only one concurrent callback in a process', async () => {
    let active = 0;
    let maxActive = 0;
    const run = async (): Promise<void> => {
      await lock(lockDir, { waitTimeMS: 2, retryCount: 500 }, async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await sleep(20);
        active--;
      });
    };

    await Promise.all(Array.from({ length: 10 }, run));
    assert.strictEqual(maxActive, 1);
  });

  it('allows only one concurrent callback across processes', async () => {
    const eventFile = path.join(testRoot, 'events.log');
    const moduleUrl = new URL('../lockfile.js', import.meta.url).href;
    const startTime = Date.now() + 500;
    const childCode = [
      `import fs from 'node:fs';`,
      `import { lock, sleep } from ${JSON.stringify(moduleUrl)};`,
      `const [start, lockDir, eventFile, id] = process.argv.slice(1);`,
      `while (Date.now() < Number(start)) {}`,
      `await lock(lockDir, { waitTimeMS: 2, retryCount: 1000 }, async () => {`,
      `  fs.appendFileSync(eventFile, 'S ' + id + '\\n');`,
      `  await sleep(20);`,
      `  fs.appendFileSync(eventFile, 'E ' + id + '\\n');`,
      `});`,
    ].join('\n');

    await Promise.all(Array.from({ length: 12 }, (_, index) => runChild([
      '--input-type=module',
      '--eval',
      childCode,
      String(startTime),
      lockDir,
      eventFile,
      String(index),
    ])));

    let active = 0;
    let maxActive = 0;
    for (const line of fs.readFileSync(eventFile, 'utf8').trim().split('\n')) {
      active += line.startsWith('S ') ? 1 : -1;
      maxActive = Math.max(maxActive, active);
      assert.ok(active >= 0);
    }
    assert.strictEqual(active, 0);
    assert.strictEqual(maxActive, 1);
  });

  it('does not steal a live lock after deadlockTimeMS', async () => {
    let active = 0;
    let maxActive = 0;
    const run = async (delay: number, duration: number): Promise<void> => {
      await sleep(delay);
      await lock(lockDir, { waitTimeMS: 2, retryCount: 200, deadlockTimeMS: 10 }, async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await sleep(duration);
        active--;
      });
    };

    await Promise.all([run(0, 80), run(30, 10), run(50, 10)]);
    assert.strictEqual(maxActive, 1);
  });

  it('recovers a stale empty lock left by an older version', async () => {
    fs.mkdirSync(lockDir);
    await sleep(15);
    let called = false;
    await lock(lockDir, { waitTimeMS: 2, retryCount: 10, deadlockTimeMS: 10 }, async () => {
      called = true;
    });
    assert.strictEqual(called, true);
    assert.strictEqual(fs.existsSync(lockDir), false);
  });

  it('recovers a stale lock left by a terminated owner', async () => {
    fs.mkdirSync(lockDir);
    fs.writeFileSync(path.join(lockDir, '.lockfile-light-owner'), JSON.stringify({
      version: 1,
      token: 'terminated-owner',
      pid: 2_147_483_647,
      hostname: os.hostname(),
    }));
    await sleep(15);

    let called = false;
    await lock(lockDir, { waitTimeMS: 2, retryCount: 10, deadlockTimeMS: 10 }, async () => {
      called = true;
    });
    assert.strictEqual(called, true);
    assert.strictEqual(fs.existsSync(lockDir), false);
  });

  it('never deletes unknown files from a stale directory', async () => {
    fs.mkdirSync(lockDir);
    const sentinel = path.join(lockDir, 'important.txt');
    fs.writeFileSync(sentinel, 'keep');
    await sleep(15);

    await assert.rejects(
      lock(lockDir, { waitTimeMS: 2, retryCount: 1, deadlockTimeMS: 10 }, async () => {}),
      /Refusing to remove non-empty lock directory/,
    );
    assert.strictEqual(fs.readFileSync(sentinel, 'utf8'), 'keep');
  });

  it('reports an unlock failure and preserves unexpected contents', async () => {
    const sentinel = path.join(lockDir, 'unexpected.txt');
    await assert.rejects(
      lock(lockDir, {}, async () => {
        fs.writeFileSync(sentinel, 'keep');
      }),
      /Could not release lock/,
    );
    assert.strictEqual(fs.readFileSync(sentinel, 'utf8'), 'keep');
  });

  it('rethrows the original callback error after unlocking', async () => {
    const expected = new TypeError('callback failed');
    await assert.rejects(
      lock(lockDir, {}, async () => {
        throw expected;
      }),
      (err: unknown) => err === expected,
    );
    assert.strictEqual(fs.existsSync(lockDir), false);
  });

  it('rejects unsafe option values', async () => {
    await assert.rejects(lock(lockDir, { deadlockTimeMS: -1 }, async () => {}), RangeError);
    await assert.rejects(lock(lockDir, { waitTimeMS: 0 }, async () => {}), RangeError);
    await assert.rejects(lock(lockDir, { retryCount: 1.5 }, async () => {}), RangeError);
  });
});

function runChild(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Child failed with code=${code} signal=${signal}: ${stderr}`));
      }
    });
  });
}
