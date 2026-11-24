/**
 * Verifies that the two unpacked/native-ish assets are readable from the
 * packaged layout, which is the part the source smoke test cannot cover.
 */
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const pkg = path.join(__dirname, '..', 'release', 'win-unpacked', 'resources');

app.whenReady().then(() => {
  const targets = [
    ['asar path (what VENDOR_ROOT resolves to)',
      path.join(pkg, 'app.asar', 'node_modules', 'pdfjs-dist', 'build')],
    ['unpacked fallback',
      path.join(pkg, 'app.asar.unpacked', 'node_modules', 'pdfjs-dist', 'build')],
    ['sql.js via asar',
      path.join(pkg, 'app.asar', 'node_modules', 'sql.js', 'dist')],
    ['sql.js via unpacked',
      path.join(pkg, 'app.asar.unpacked', 'node_modules', 'sql.js', 'dist')],
  ];

  const files = ['pdf.min.mjs', 'pdf.worker.min.mjs', 'sql-wasm.wasm'];
  let failures = 0;

  for (const [label, dir] of targets) {
    for (const file of files) {
      const full = path.join(dir, file);
      let ok = false;
      let size = 0;
      try {
        if (fs.existsSync(full)) {
          const buf = fs.readFileSync(full);
          size = Math.round(buf.length / 1024);
          ok = size > 0;
        }
      } catch (err) {
        size = `ERR ${err.message}`;
      }
      // Only require each asset from its primary location.
      const required = (file.startsWith('pdf') && label.startsWith('asar'))
        || (file.startsWith('sql') && label.startsWith('sql.js via asar'));
      if (!ok) {
        console.log(`  ${required ? 'FAIL' : 'skip'}  ${label}: ${file} (${size})`);
        if (required) failures += 1;
      } else {
        console.log(`  PASS  ${label}: ${file} (${size} KB)`);
      }
    }
  }

  console.log(failures === 0 ? '\n  packaged assets readable\n' : `\n  ${failures} FAILURES\n`);
  app.exit(failures === 0 ? 0 : 1);
});