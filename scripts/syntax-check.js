'use strict';

/**
 * Lightweight syntax validation for all JS sources without needing a display
 * or Electron runtime. Uses the V8 parser via `new vm.Script` / module compile.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const files = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith('.js')) files.push(full);
  }
})(path.join(ROOT, 'src'));
files.push(path.join(ROOT, 'scripts', 'syntax-check.js'));

let failed = 0;
for (const file of files) {
  const code = fs.readFileSync(file, 'utf8');
  try {
    // Wrap as CommonJS module to allow top-level require/module/exports tokens.
    new vm.Script(`(function(require,module,exports,__dirname,__filename){\n${code}\n})`, {
      filename: file,
    });
    console.log('ok   ', path.relative(ROOT, file));
  } catch (err) {
    failed++;
    console.error('FAIL ', path.relative(ROOT, file), '->', err.message);
  }
}

console.log(`\n${files.length - failed}/${files.length} files parsed cleanly.`);
process.exit(failed ? 1 : 0);
