import {readFile} from 'node:fs/promises';
import path from 'node:path';

const jobPath = path.resolve(process.argv[2] ?? './example/brand-video-job.json');
const job = JSON.parse(await readFile(jobPath, 'utf8'));
const errors = [];

const requiredString = (value, label) => {
  if (typeof value !== 'string' || value.trim() === '') errors.push(`${label} must be a non-empty string`);
};

requiredString(job.id, 'id');
requiredString(job.assetId, 'assetId');
requiredString(job.brand?.name, 'brand.name');
requiredString(job.brand?.primaryColor, 'brand.primaryColor');
requiredString(job.brand?.accentColor, 'brand.accentColor');
requiredString(job.content?.hook, 'content.hook');
requiredString(job.content?.headline, 'content.headline');
requiredString(job.content?.body, 'content.body');
requiredString(job.content?.cta, 'content.cta');

if (!['short', 'story', 'film', 'training'].includes(job.output?.variant)) errors.push('output.variant must be short, story, film, or training');
if (!Number.isFinite(Number(job.output?.fps)) || Number(job.output.fps) < 12) errors.push('output.fps must be at least 12');
if (!Number.isFinite(Number(job.output?.durationInSeconds)) || Number(job.output.durationInSeconds) < 6) errors.push('output.durationInSeconds must be at least 6');
if (!Number.isFinite(Number(job.output?.width)) || Number(job.output.width) < 320) errors.push('output.width must be at least 320');
if (!Number.isFinite(Number(job.output?.height)) || Number(job.output.height) < 320) errors.push('output.height must be at least 320');

if (errors.length > 0) {
  console.error(`Invalid render job: ${jobPath}`);
  errors.forEach((error) => console.error(`- ${error}`));
  process.exit(1);
}

console.log(JSON.stringify({valid: true, jobPath, assetId: job.assetId, variant: job.output.variant}, null, 2));
