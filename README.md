# node-lockfile-light

This is a module that provides simple file locking function for Node.js.

- Simple functions with JavaScript/TypeScript.
- All functions are async function.
- The `lock` function uses mkdir and rmdir.
- Locks are exclusive across Node.js processes.

## install

```bash
npm install lockfile-light
```

## Simple example

```js:simple.js
import { lock, sleep } from 'lockfile-light';
(async () => {
    const lockDir = './.__lock_for_something__';
    await lock(lockDir, {}, async () => {
        console.log('something:start');
        await sleep(2000);
        console.log('something:end');
    });
})();
```

## Lock options and recovery

- `waitTimeMS` is the delay between acquisition attempts (default: `300`).
- `retryCount` is the maximum number of waits (default: `10`).
- `deadlockTimeMS` is the age at which a lock left by a terminated process can
  be recovered (default: `30000`). A locally running owner is never treated as
  dead, even when a callback runs longer than this value.
- `name` is returned after the callback completes (default: `?`).

The lock directory is reserved for this module while the callback is running.
If unexpected files are found there, they are preserved and an error is thrown;
the module never recursively deletes the directory contents.

## Parallel execution example

```js:parallel_example.js
// Parallel execution example
import { lock, sleep } from 'lockfile-light';

const options = {
    waitTimeMS: 100,
    retryCount: 50,
    deadlockTimeMS: 10000,
    name: '?',
};

const lockDir = './.__lock_for_something__';
(async () => {
    lock(lockDir, options, async () => {
        console.log('something1:start');
        await sleep(2000);
        console.log('something1:end');
    })
    lock(lockDir, options, async () => {
        console.log('something2:start');
        await sleep(1000);
        console.log('something2:end');
    })
    lock(lockDir, options, async () => {
        console.log('something3:start');
        await sleep(300);
        console.log('something3:end');
    })
})();
```

## Serial execution example

```js:serial_example.js
// Serial execution example
import { lock, sleep } from 'lockfile-light';

const lockDir = './.__lock_for_something__';

(async () => {
    const opt = { waitTimeMS: 100, retryCount: 50, deadlockTimeMS: 10000, name: '?' };
    const opt1 = { ...opt, name: 'task1' };
    const taskName1 = await lock(lockDir, opt1, async () => {
        console.log('something1:start');
        await sleep(1000);
    })
    console.log('done=', taskName1);

    const opt2 = { ...opt, name: 'task2' };
    const taskName2 = await lock(lockDir, opt2, async () => {
        console.log('something2:start');
        await sleep(1000);
    })
    console.log('done=', taskName2);

    const opt3 = { ...opt, name: 'task3' };
    const taskName3 = await lock(lockDir, opt3, async () => {
        console.log('something3:start');
        await sleep(1000);
    })
    console.log('done=', taskName3);
})();
```
