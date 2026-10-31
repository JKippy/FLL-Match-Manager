// Where browser tests write screenshots and reports.
// Default: test-output/screenshots/ (gitignored), so a test run never changes tracked files.
// To refresh the checked-in images in screenshots/, run with --update or UPDATE_SCREENSHOTS=1, e.g.
//   node test/ref-test.js --update        UPDATE_SCREENSHOTS=1 npm run test:all
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const UPDATE = process.argv.includes('--update') || process.env.UPDATE_SCREENSHOTS === '1';
const OUT = path.join(ROOT, 'test-output', 'screenshots');                  // reports and scratch output, always ignored
const SHOTS = UPDATE ? path.join(ROOT, 'screenshots') : OUT;              // screenshot images
fs.mkdirSync(SHOTS, { recursive: true }); fs.mkdirSync(OUT, { recursive: true });
module.exports = { SHOTS, OUT, UPDATE };
