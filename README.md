# node-lockfile-light

This is a module that provides simple file locking function for Node.js.

- Simple functions with JavaScript/TypeScript.
- All functions are async function.
- The `lock` function uses mkdir and rmdir.

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
