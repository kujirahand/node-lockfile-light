import assert from 'assert';
import path from 'path';
import { fileURLToPath } from 'url';

import { exists, stat, sleep } from '../lockutils.js';
import { lock } from '../lockfile.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('basic_test', () => {
  const basic_ts = path.join(__dirname, 'basic_test.ts');
  const unknownfile = path.join(__dirname, 'jIIKvKKZWj35PTYO');
  const lockfile = path.join(__dirname, '__lock__1234__');

  it('exists', async () => {
    assert.strictEqual(await exists(basic_ts), true);
    assert.strictEqual(await exists(unknownfile), false);
  });

  it('stat', async () => {
    const st = await stat(basic_ts);
    assert.strictEqual((st.ctimeMs > 0), true);
  });

  it('stat2', async () => {
    let b = false;
    try {
      const st = await stat(unknownfile);
    } catch (err) {
      b = true;
    }
    assert.strictEqual(b, true);
  });

});
