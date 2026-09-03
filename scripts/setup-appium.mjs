import { spawnSync } from 'node:child_process';

function run(command, args) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: process.env,
  });
  if (result.error || result.status !== 0) {
    process.exitCode = result.status || 1;
    throw result.error || new Error(`${command} ${args.join(' ')} failed`);
  }
}

console.log('Installing Appium 3 and the official UiAutomator2 driver into the current npm environment...');
run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--no-save', 'appium@^3']);
run(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['appium', 'driver', 'install', 'uiautomator2']);
console.log('\nDone. Start Appium with: npx appium');
console.log('Then run this mini-app; it uses http://127.0.0.1:4723 by default.');
