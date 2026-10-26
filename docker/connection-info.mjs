import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const config = JSON.parse(readFileSync(join(homedir(), '.infinite-canvas', 'canvas-agent.json'), 'utf8'));
console.log('Agent URL: <your Web URL>/canvas-agent');
console.log(`Connect token: ${config.token}`);
