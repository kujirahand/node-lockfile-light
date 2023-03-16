import assert from 'assert';
import path from 'path';
import { fileURLToPath } from 'url';
import { sleep } from '../lockutils.js';
import { lock } from '../lockfile.js';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
describe('lock_test', () => {
    const lockfile = path.join(__dirname, '__lock__1234__');
    const lockfile2 = path.join(__dirname, '__lock2__1234__');
    it('simple', async () => {
        let v = 0;
        await lock(lockfile, {}, async () => {
            await sleep(1);
            v = 1;
        });
        assert.strictEqual(v, 1);
    });
    it('lock 3times', async () => {
        let task = '';
        await lock(lockfile, {}, async () => {
            task += '1';
            await sleep(100);
        });
        await lock(lockfile, {}, async () => {
            task += '2';
            await sleep(100);
        });
        await lock(lockfile, {}, async () => {
            task += '3';
            await sleep(100);
        });
        assert.strictEqual(task, '123');
    });
    it('lock promise.all', async () => {
        const task = [];
        const task3 = async () => {
            await lock(lockfile2, { name: 'task3', waitTimeMS: 50 }, async () => {
                await sleep(300);
                task.push(3);
            });
        };
        const task2 = async () => {
            await lock(lockfile2, { name: 'task2', waitTimeMS: 50 }, async () => {
                await sleep(100);
                task.push(2);
            });
        };
        const task1 = async () => {
            await lock(lockfile2, { name: 'task1', waitTimeMS: 50 }, async () => {
                await sleep(1);
                task.push(1);
            });
        };
        await Promise.all([task3(), task2(), task1()]);
        task.push(4);
        task.sort();
        assert.strictEqual(task.join('-'), '1-2-3-4');
    });
    it('lock options', async () => {
        const options = {
            waitTimeMS: 50,
            retryCount: 30,
            deadlockTimeMS: 5000,
            name: '?',
        };
        const task = [];
        const makeLock = async (n) => {
            const val = n;
            const opt = { ...options };
            opt.name = 'task' + val;
            await lock(lockfile, opt, async () => {
                await sleep(val * 100);
                task.push(val);
            });
        };
        const task1 = makeLock(1);
        const task2 = makeLock(2);
        const task3 = makeLock(3);
        await Promise.all([task1, task2, task3]);
        assert.strictEqual(task.join('-'), '1-2-3');
    });
    it('check error', async () => {
        let v = 0;
        try {
            await lock(lockfile, {}, async () => {
                await sleep(1);
                v = 1;
                throw new Error('test');
                v = 2;
            });
        }
        catch (err) {
            //
        }
        assert.strictEqual(v, 1);
    });
});
