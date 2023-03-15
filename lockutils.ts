import fs from 'node:fs';

export async function exists(path: string): Promise<boolean> {
    try {
        const stats = await stat(path);
        return (stats.ctimeMs > 0);
    } catch (err) {
        return false;
    }
}

// throw error if file not exists
export function stat(path: string): Promise<fs.Stats> {
    return new Promise((resoleve, reject) => {
        fs.stat(path, (err, stats: fs.Stats) => {
            if (err) {
                reject(err);
                return;
            }
            resoleve(stats);
        })
    })
}

export function sleep(msec: number) {
    return new Promise((resolve, _reject) => {
      setTimeout(() => {
        resolve(0);
      }, msec);
    })
}
