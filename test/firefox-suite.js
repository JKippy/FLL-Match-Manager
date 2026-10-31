// Quick Firefox tier: display / satellite browser tests (projector, pair, queue, timer),
// plus simple-mode because the Chrome job's test:all runs it.
// The rest of test:all stays on the Chrome job.
const { spawnSync } = require('child_process');
const path = require('path');

const tests = [
  'sync-test.js',
  'event-test.js',
  'break-queue-test.js',
  'offline-badge-test.js',
  'simple-mode-test.js',
];

console.log('Firefox quick tier: ' + tests.join(', '));
for (const file of tests) {
  const r = spawnSync(process.execPath, [path.join(__dirname, file)], {
    stdio: 'inherit',
    env: { ...process.env, PWBROWSER: 'firefox' },
  });
  if (r.status !== 0) process.exit(r.status == null ? 1 : r.status);
}
