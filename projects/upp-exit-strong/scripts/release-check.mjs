import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('..',import.meta.url));
for(const command of [['scripts/check-resources.mjs'],['--test','tests/game.test.mjs']]){const result=spawnSync(process.execPath,command,{cwd:root,stdio:'inherit'});if(result.status!==0)process.exit(result.status??1);}
console.log('Release checks passed. Publishing and payment activation are separate operations.');
