import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const cwd = fileURLToPath(new URL('../', import.meta.url));
// Keep Unix socket paths short, independent of the caller's TMPDIR.
const root = mkdtempSync('/tmp/hempi-ci-');
try {
  const home = path.join(root, 'home');
  mkdirSync(home);
  // Allowlist, rather than trying to enumerate every provider credential variable.
  const env = {
    PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: home, TMPDIR: root, CI: 'true', LANG: 'C.UTF-8',
    XDG_RUNTIME_DIR: root,
    XDG_CONFIG_HOME: path.join(root, 'config'),
    XDG_CACHE_HOME: path.join(root, 'cache'),
    PI_CODING_AGENT_DIR: path.join(root, 'agent'),
    OPTCHAT_HOME: path.join(root, 'optchat'), PI_OFFLINE: '1',
    HEMPI_PI_TEST_BINARY: path.join(cwd, 'node_modules/.bin/pi'),
  };
  for (const script of ['test', 'test:install']) {
    const result = spawnSync('npm', ['run', script], { cwd, env, stdio: 'inherit', timeout: 600_000 });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exitCode = result.status ?? 1;
    if (process.exitCode) break;
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
