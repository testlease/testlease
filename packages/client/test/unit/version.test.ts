import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CLIENT_VERSION } from '../../src/version.js';

describe('CLIENT_VERSION', () => {
  it('matches the package.json version', () => {
    const pkg = JSON.parse(
      readFileSync(
        join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json'),
        'utf8',
      ),
    ) as { version: string };
    expect(CLIENT_VERSION).toBe(pkg.version);
  });
});
