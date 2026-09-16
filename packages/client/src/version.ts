import { createRequire } from 'node:module';

/** Version of this package as published (read from package.json, never hard-coded). */
export const CLIENT_VERSION: string = (() => {
  try {
    return (createRequire(import.meta.url)('../package.json') as { version: string }).version;
  } catch {
    return '0.0.0-dev';
  }
})();
