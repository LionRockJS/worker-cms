import { execFileSync } from 'node:child_process';
import { readManifest } from './build-migrations.mjs';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const features = readManifest();
execFileSync(npm, ['run', 'build:migrations'], { stdio: 'inherit' });
execFileSync(npm, ['run', 'db:migrate:admin'], { stdio: 'inherit' });
if (features.publish) execFileSync(npm, ['run', 'db:migrate:published'], { stdio: 'inherit' });
