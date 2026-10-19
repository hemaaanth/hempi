import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const rootFiles = new Set(['.gitignore', '.gitattributes', '.env.example', 'README.md', 'ACP.md', 'AGENTS.md', 'NOTICE.md', 'THIRD_PARTY_NOTICES.md', 'SECURITY.md', 'LICENSE', 'OMP-LICENSE', 'OPTCHAT-LICENSE', 'UNIICHAT-LICENSE', 'PI-LICENSE', 'package.json', 'package-lock.json', 'tsconfig.json']);
const sourceDirectories = new Set(['src', 'tests', 'pi', 'prompts', 'docs', 'scripts', '.github']);
const privateDirectories = new Set(['.git', '.pi-runtime', 'node_modules', '.pi', '.optchat', '.cache', 'sessions', 'recordings', 'logs']);

function publicationCheck(directory) {
 const git = (...args) => execFileSync('git', args, { cwd: directory, maxBuffer: 2 * 1024 * 1024 });
 const indexed = git('ls-files', '--stage', '-z').toString().split('\0').filter(Boolean);
 const files = new Set(git('ls-files', '--cached', '--others', '--exclude-standard', '-z').toString().split('\0').filter(Boolean));
 function validate(relative, content) {
  const pieces = relative.split('/'), basename = pieces.at(-1);
  assert.ok(rootFiles.has(relative) || (pieces.length > 1 && sourceDirectories.has(pieces[0])), `Unexpected publication path: ${relative}`);
  assert.ok(!pieces.some(piece => privateDirectories.has(piece)), `Local data cannot be published: ${relative}`);
  assert.ok(!/^(?:auth|credentials)\.json$/i.test(basename) && !/\.(?:log|jsonl|sqlite3?|db|pem|key|p12|pfx|core|tgz|zip)$/i.test(basename), `Sensitive/generated filename: ${relative}`);
  assert.ok(!(basename === '.env' || (basename.startsWith('.env.') && basename !== '.env.example')), `Environment file cannot be published: ${relative}`);
  assert.ok(content.length < 2 * 1024 * 1024, `Unexpectedly large source file: ${relative}`);
  // Report filenames, never matching content: test output must not become another disclosure.
  assert.ok(!/\/(?:home|Users)\/[^\s/"'`]+/.test(content.toString('utf8')), `Remove machine-specific home path from ${relative}`);
  if (relative === 'package.json') assert.equal(JSON.parse(content.toString('utf8')).private, true, 'Keep accidental npm publication disabled');
 }
 for (const entry of indexed) {
  const [, mode, oid, stage, relative] = /^(\d+) ([a-f0-9]+) (\d)\t([\s\S]*)$/.exec(entry);
  assert.equal(stage, '0', `Unmerged publication path: ${relative}`);
  assert.ok(mode === '100644' || mode === '100755', `Publication requires regular indexed files: ${relative}`);
  assert.ok(Number(git('cat-file', '-s', oid).toString()) < 2 * 1024 * 1024, `Unexpectedly large source file: ${relative}`);
  validate(relative, git('cat-file', 'blob', oid));
 }
 for (const relative of files) {
  const file = path.join(directory, relative);
  let stat;
  try { stat = lstatSync(file); }
  catch (error) { if (error.code === 'ENOENT') continue; throw error; } // Indexed deletions were still checked above.
  assert.ok(stat.isFile() && !stat.isSymbolicLink(), `Publication requires regular source files: ${relative}`);
  assert.ok(stat.size < 2 * 1024 * 1024, `Unexpectedly large source file: ${relative}`);
  validate(relative, readFileSync(file));
 }
}

test('publishable source excludes local data, symlinks and machine-specific home paths', () => {
 publicationCheck(root);
});

test('publication checks both the exact index and current source without requiring staging', async (t) => {
 const unsafe = '/' + ['home', 'private-user', 'project'].join('/');
 const cases = [
  ['unsafe index masked by safe edits', ({ file, git }) => { writeFileSync(file, unsafe); git('add', '.'); writeFileSync(file, 'safe'); }, /home path/],
  ['unsafe index missing from disk', ({ file, git }) => { writeFileSync(file, unsafe); git('add', '.'); unlinkSync(file); }, /home path/],
  ['safe index missing from disk', ({ file }) => unlinkSync(file)],
  ['sensitive indexed filename missing from disk', ({ directory, git }) => { const file = path.join(directory, 'src', 'credentials.json'); writeFileSync(file, '{}'); git('add', '.'); unlinkSync(file); }, /Sensitive\/generated filename/],
  ['regular executable index mode', ({ git }) => git('update-index', '--chmod=+x', 'src/source.ts')],
  ['indexed gitlink masked by regular file', ({ git }) => { const oid = git('rev-parse', ':src/source.ts').toString().trim(); git('update-index', '--cacheinfo', `160000,${oid},src/source.ts`); }, /regular indexed/],
  ['unsafe working edit', ({ file }) => writeFileSync(file, unsafe), /home path/],
  ['unsafe untracked source', ({ directory }) => writeFileSync(path.join(directory, 'src', 'new.ts'), unsafe), /home path/],
  ['safe unstaged and untracked source', ({ file, directory }) => { writeFileSync(file, 'safe edits'); writeFileSync(path.join(directory, 'src', 'new.ts'), 'safe'); }],
  ['indexed symlink masked by regular file', ({ file, git }) => { unlinkSync(file); symlinkSync('missing', file); git('add', '.'); unlinkSync(file); writeFileSync(file, 'safe'); }, /regular indexed/],
  ['indexed missing symlink', ({ file, git }) => { unlinkSync(file); symlinkSync('missing', file); git('add', '.'); unlinkSync(file); }, /regular indexed/],
  ['working dangling symlink', ({ file }) => { unlinkSync(file); symlinkSync('missing', file); }, /regular source/],
  ['untracked symlink', ({ directory }) => symlinkSync('source.ts', path.join(directory, 'src', 'link.ts')), /regular source/],
  ['unsafe indexed package masked by edits', ({ directory, git }) => { const file = path.join(directory, 'package.json'); writeFileSync(file, '{"private":false}'); git('add', '.'); writeFileSync(file, '{"private":true}'); }, /publication disabled/],
 ];
 for (const [name, setup, failure] of cases) await t.test(name, () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'hempi-privacy-'));
  try {
   const git = (...args) => execFileSync('git', args, { cwd: directory });
   git('init', '--quiet');
   mkdirSync(path.join(directory, 'src'));
   const file = path.join(directory, 'src', 'source.ts');
   writeFileSync(file, 'safe');
   writeFileSync(path.join(directory, 'package.json'), '{"private":true}');
   git('add', '.');
   setup({ directory, file, git });
   if (failure) assert.throws(() => publicationCheck(directory), failure);
   else publicationCheck(directory);
  } finally { rmSync(directory, { recursive: true, force: true }); }
 });
});

test('ignore rules cover common credentials, sessions and generated artifacts', () => {
 const names = ['.env', '.env.local', 'auth.json', 'credentials.json', '.pi/auth.json', '.optchat/memory.json', '.pi-runtime/build.json', 'node_modules/example/index.js', 'sessions/conversation.json', 'recordings/capture.txt', 'debug.log', 'conversation.jsonl', 'private.pem', 'private.key', 'memory.sqlite', 'coverage/index.html', 'dist/output.js'];
 const ignored = execFileSync('git', ['check-ignore', '--no-index', '--stdin'], { cwd: root, input: names.join('\n') + '\n', encoding: 'utf8' }).trim().split('\n');
 assert.deepEqual(new Set(ignored), new Set(names));
});
