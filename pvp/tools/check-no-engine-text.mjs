// check-no-engine-text.mjs — does any published file contain a line of the game's own script?
//
// pvp/anim.mjs, bones.mjs, ragdoll.mjs, bot.mjs, parts of sim.mjs and public/rig.js are ports of
// named classes in the shipped web build, and their comments cite that file by class and byte
// offset. Citing it is the point: it is how a number in this repository can be checked against
// the game instead of trusted. But a citation is not a copy, and "it holds no bytes of the
// engine" is a claim that should be measured rather than asserted.
//
// So: every substantial line of every file this repository publishes is looked for in the engine
// script, as written and with all whitespace removed (the shipped script is minified, so a copied
// line would most likely appear there spaced differently). A match is a line to remove and
// rewrite. Zero matches is the result this repository expects, and the reason the ports are
// published with their provenance comments intact.
//
// The engine script is not published here -- it is the game's. Point this at your own copy:
//
//   node pvp/tools/check-no-engine-text.mjs [path-to-engine-script]
//
// Default path: re-notes/web-build/sf2.js (where the other builders expect it).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '../..');
const ENGINE = path.resolve(process.argv[2] || path.join(ROOT, 're-notes/web-build/sf2.js'));

if (!fs.existsSync(ENGINE)) {
  console.error(`${path.relative(ROOT, ENGINE)} is not here.\n`
    + 'This check reads the game\'s own script, which this repository does not ship. Point it at\n'
    + 'your own copy: node pvp/tools/check-no-engine-text.mjs <path-to-engine-script>');
  process.exit(2);
}

const engine = fs.readFileSync(ENGINE, 'utf8');
const engineTight = engine.replace(/\s+/g, '');

/** the files this repository publishes, asked of git rather than guessed from a glob */
function publishedFiles() {
  const git = (args, env) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', env: { ...process.env, ...env } });
  // tracked AND not-ignored-untracked: a file added since the last commit is published too, and
  // reading only the index once let two new files pass this check unseen
  if (fs.existsSync(path.join(ROOT, '.git'))) {
    return git(['ls-files', '--cached', '--others', '--exclude-standard']).split('\n').filter(Boolean);
  }
  // not a checkout (the workspace this was built in is not one): stage into a throwaway index,
  // which applies .gitignore exactly as a real `git add .` would
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sf2-publishset-'));
  try {
    git(['init', '-q', '--bare', path.join(tmp, 'stage.git')]);
    return git(['add', '-An', '.'], { GIT_DIR: path.join(tmp, 'stage.git'), GIT_WORK_TREE: ROOT })
      .split('\n').map((l) => l.replace(/^add '(.*)'$/, '$1')).filter(Boolean);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const files = publishedFiles();
const code = files.filter((f) => /\.(mjs|js|json|html|css)$/.test(f));

let checked = 0;
const hits = [];
for (const rel of code) {
  const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  for (const [i, raw] of text.split('\n').entries()) {
    const line = raw.trim();
    // a short line, a comment or a row of punctuation is no evidence either way
    if (line.length < 40 || line.startsWith('//') || line.startsWith('*') || line.startsWith('/*')) continue;
    const tight = line.replace(/\s+/g, '');
    if (tight.length < 30) continue;
    checked++;
    if (engine.includes(line) || engineTight.includes(tight)) hits.push(`${rel}:${i + 1}: ${line.slice(0, 120)}`);
  }
}

console.log(`engine script  ${(engine.length / 1048576).toFixed(2)} MB (${path.relative(ROOT, ENGINE)})`);
console.log(`published      ${files.length} files, ${code.length} of them code`);
console.log(`checked        ${checked} substantial lines`);
for (const h of hits.slice(0, 40)) console.log(`  ${h}`);
if (hits.length > 40) console.log(`  … and ${hits.length - 40} more`);
console.log(hits.length
  ? `FAIL: ${hits.length} published line(s) occur in the engine script`
  : 'PASS: no published line occurs in the engine script');
process.exit(hits.length ? 1 : 0);
