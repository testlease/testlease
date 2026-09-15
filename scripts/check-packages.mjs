// Package validation: every publishable package must build, expose its declared entry points,
// and be importable from its dist. Run after `pnpm build`.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const packages = ['protocol', 'core', 'client', 'server', 'mcp', 'playwright', 'cli'];
let failed = false;
for (const name of packages) {
  const dir = resolve('packages', name);
  const pkg = JSON.parse(readFileSync(resolve(dir, 'package.json'), 'utf8'));
  const problems = [];
  if (pkg.private) problems.push('is private');
  if (!pkg.license) problems.push('missing license');
  if (!pkg.repository?.url) problems.push('missing repository');
  if (pkg.publishConfig?.access !== 'public' && pkg.name.startsWith('@'))
    problems.push('scoped package without publishConfig.access=public');
  for (const field of ['main', 'types']) {
    if (!pkg[field] || !existsSync(resolve(dir, pkg[field])))
      problems.push(`${field} -> ${pkg[field]} missing`);
  }
  const entry = pkg.exports?.['.']?.default;
  if (!entry || !existsSync(resolve(dir, entry)))
    problems.push(`exports["."].default -> ${entry} missing`);
  if (pkg.bin)
    for (const [cmd, rel] of Object.entries(pkg.bin))
      if (!existsSync(resolve(dir, rel))) problems.push(`bin ${cmd} -> ${rel} missing`);
  for (const dep of Object.keys(pkg.dependencies ?? {})) {
    if (
      pkg.dependencies[dep].startsWith('workspace:') &&
      !packages.includes(dep.replace('@testlease/', ''))
    )
      problems.push(`workspace dep ${dep} is not publishable`);
  }
  try {
    const mod = await import(pathToFileURL(resolve(dir, entry)).href);
    if (Object.keys(mod).length === 0) problems.push('entry exports nothing');
  } catch (err) {
    problems.push(`entry failed to import: ${err.message}`);
  }
  if (problems.length) {
    failed = true;
    console.error(`✗ ${pkg.name}: ${problems.join('; ')}`);
  } else {
    console.log(
      `✓ ${pkg.name}@${pkg.version} (${Object.keys(pkg.dependencies ?? {}).length} deps)`,
    );
  }
}
process.exit(failed ? 1 : 0);
