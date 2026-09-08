import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { LIMITS } from '../dist/game/limits.mjs';
import { campaign } from '../dist/game/content/mill-creek.mjs';

const root=path.resolve(fileURLToPath(new URL('..',import.meta.url)));
const errors=[],hashes=new Map(),metrics={files:0,sourceBytes:0,initialGzipBytes:0,codeGzipBytes:0,campaignGzipBytes:0,largestAssetBytes:0,duplicateFiles:0,runtimeModelCallsPerMove:0};
const lock=JSON.parse(await fs.readFile(path.join(root,'resource-policy.lock.json'),'utf8'));
for(const [name,key] of [['dist/game/limits.mjs','limitsSha256'],['resource-contract.json','contractSha256']]){const hash=createHash('sha256').update(await fs.readFile(path.join(root,name))).digest('hex');if(hash!==lock[key])errors.push('Locked resource policy changed: '+name);}
async function walk(directory){const result=[];for(const entry of await fs.readdir(directory,{withFileTypes:true})){const name=path.join(directory,entry.name);if(entry.isSymbolicLink()){errors.push('Symlink not allowed: '+path.relative(root,name));continue;}if(entry.isDirectory()){if(/^(node_modules|routes|levels|copies|variants|cache|backups)$/i.test(entry.name))errors.push('Unbounded or duplicate-prone directory: '+path.relative(root,name));result.push(...await walk(name));}else if(entry.isFile())result.push(name);}return result;}
const files=await walk(path.join(root,'dist'));
for(const name of files){const data=await fs.readFile(name),relative=path.relative(root,name).replaceAll(path.sep,'/'),gzip=gzipSync(data,{level:9}).length;
  metrics.files++;metrics.sourceBytes+=data.length;
  if(/\.(html|css|mjs|js)$/.test(name))metrics.initialGzipBytes+=gzip;else metrics.initialGzipBytes+=data.length;
  if(/\.(mjs|js)$/.test(name))metrics.codeGzipBytes+=gzip;
  if(relative.includes('/content/'))metrics.campaignGzipBytes+=gzip;
  if(relative.includes('/assets/')){metrics.largestAssetBytes=Math.max(metrics.largestAssetBytes,data.length);if(data.length>LIMITS.assetBytes)errors.push(relative+' exceeds assetBytes');}
  if(data.length>1024){const hash=createHash('sha256').update(data).digest('hex');if(hashes.has(hash)){metrics.duplicateFiles++;errors.push('Duplicate file: '+relative+' = '+hashes.get(hash));}hashes.set(hash,relative);}
  if(/\.(html|css|mjs|js)$/.test(name)){const text=data.toString();if(/data:(image|audio|video)|https?:\/\/[^\s"']+\.(m?js|css)/i.test(text))errors.push('Embedded media or remote executable: '+relative);if(/\b(fetch|XMLHttpRequest|WebSocket|EventSource)\s*\(/.test(text))errors.push('Unreviewed runtime network call: '+relative);if(/eval\s*\(|new Function\s*\(/.test(text))errors.push('Dynamic code execution: '+relative);}
}
for(const metric of ['files','sourceBytes','initialGzipBytes','codeGzipBytes','campaignGzipBytes']){const limit=metric==='files'?LIMITS.maxFiles:LIMITS[metric];if(metrics[metric]>limit)errors.push(metric+': '+metrics[metric]+' > '+limit);}
const allIds=[...campaign.actions.map(a=>a.id),...campaign.routes.map(r=>'exit:'+r.id)];if(new Set(allIds).size!==allIds.length)errors.push('Duplicate content ID');
const ids=new Set(campaign.actions.map(a=>a.id)),reached=new Set();for(let i=0;i<campaign.actions.length;i++)for(const a of campaign.actions)if(a.needs.every(n=>reached.has(n)))reached.add(a.id);
for(const a of [...campaign.actions,...campaign.routes])for(const needed of [...a.needs,...(a.guidanceNeeds??[])])if(!ids.has(needed))errors.push(a.id+': dangling prerequisite '+needed);
for(const a of campaign.actions){if(!reached.has(a.id))errors.push('Unreachable move: '+a.id);if(a.cost<0||a.days<1||!Number.isInteger(a.cost)||!Number.isInteger(a.days))errors.push('Invalid move cost: '+a.id);}
const html=await fs.readFile(path.join(root,'dist/index.html'),'utf8');for(const match of html.matchAll(/(?:src|href)="(\.\/[^"?#]+)"/g)){const target=path.resolve(root,'dist',match[1]);try{await fs.access(target);}catch{errors.push('Missing entrypoint asset: '+match[1]);}}
const context=await fs.readFile(path.join(root,'CONTINUE.md'));if(context.length>LIMITS.contextBytes)errors.push('Continuation context exceeds '+LIMITS.contextBytes+' bytes');
console.log(JSON.stringify({status:errors.length?'FAIL':'PASS',metrics,limits:LIMITS,consumptionRatioCertified:false,errors},null,2));if(errors.length)process.exitCode=1;
