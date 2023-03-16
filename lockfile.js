import fs from 'fs';
import { exists, stat, sleep } from './lockutils.js';
/**
 * lock filepath
 * @param dirPath
 * @param options
 * @param callback
 * @returns options.name
 */
export async function lock(dirPath, options, callback) {
    // check options
    if (typeof options.waitTimeMS !== 'number') {
        options.waitTimeMS = 300;
    }
    if (typeof options.retryCount !== 'number') {
        options.retryCount = 10;
    }
    if (typeof options.deadlockTimeMS !== 'number') {
        options.deadlockTimeMS = 1000 * 30; // over 30sec
    }
    if (typeof options.name === 'undefined') {
        options.name = '?';
    }
    // console.log('@options=', options);
    // task
    const executeTask = async () => {
        let errMsg = '';
        try {
            fs.mkdirSync(dirPath, { recursive: true, mode: 0o777 });
        }
        catch (err) {
            throw new Error('Could not get lock :' + err.message);
        }
        try {
            await callback();
        }
        catch (err) {
            errMsg = `Task error: ${err.message}`;
        }
        try {
            fs.rmdirSync(dirPath);
        }
        catch (err) {
            // unknown reason unlock
        }
        // throw callback error
        if (errMsg !== '') {
            throw new Error(errMsg);
        }
        return (options.name) ? options.name : '';
    };
    // check lock path
    let lockStats = null;
    try {
        lockStats = fs.statSync(dirPath);
    }
    catch (err) {
        // no lock, can start task
        return await executeTask();
    }
    // already exists lock
    // check dead lock
    const curTime = (new Date()).getTime();
    const life = curTime - lockStats.ctimeMs;
    if (life > options.deadlockTimeMS) {
        try {
            fs.rmdirSync(dirPath);
        }
        catch (err) {
            const canRemove = await rmdirRetry(dirPath, 10);
            if (!canRemove) {
                throw new Error('Could not remove dead lock : ' + err.message);
            }
        }
    }
    // wait for unlock
    for (let i = 0; i < options.retryCount; i++) {
        await sleep(options.waitTimeMS);
        // check agin
        try {
            lockStats = fs.statSync(dirPath); // still locking
            continue;
        }
        catch (err) {
            return await executeTask();
        }
    }
    // could not make lock
    throw new Error(`Could not get lock : path=${dirPath}`);
}
// rmdir
async function rmdirRetry(path, retryCount) {
    if (retryCount <= 0) {
        return false;
    }
    try {
        // already not exits?
        if (!fs.existsSync(path)) {
            return true;
        }
        // try to rmdir
        fs.rmdirSync(path, { recursive: true });
    }
    catch (err) {
        // could not remove dir
        await sleep(100);
        await rmdirRetry(path, retryCount - 1);
    }
    return true;
}
export { sleep, exists, stat };
