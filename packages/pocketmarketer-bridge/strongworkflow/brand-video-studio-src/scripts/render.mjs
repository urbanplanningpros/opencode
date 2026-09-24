import {mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {bundle} from '@remotion/bundler';
import {renderMedia, selectComposition} from '@remotion/renderer';

const directory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(directory, '..');
const jobPath = path.resolve(projectRoot, process.argv[2] ?? './example/brand-video-job.json');
const outputPath = path.resolve(projectRoot, process.argv[3] ?? './out/brand-video.mp4');
const inputProps = JSON.parse(await readFile(jobPath, 'utf8'));

await mkdir(path.dirname(outputPath), {recursive: true});

console.log('Bundling Remotion composition…');
const serveUrl = await bundle({
  entryPoint: path.join(projectRoot, 'src/remotion-index.ts'),
  onProgress: (progress) => process.stdout.write(`\rBundle ${Math.round(progress * 100)}%`),
});
process.stdout.write('\n');

const composition = await selectComposition({
  serveUrl,
  id: 'BrandVideo',
  inputProps,
});

console.log(`Rendering ${composition.width}×${composition.height} at ${composition.fps} fps…`);
await renderMedia({
  composition,
  serveUrl,
  codec: 'h264',
  audioCodec: 'aac',
  outputLocation: outputPath,
  inputProps,
  crf: 18,
  imageFormat: 'jpeg',
  onProgress: ({progress}) => process.stdout.write(`\rRender ${Math.round(progress * 100)}%`),
});
process.stdout.write('\n');

const metadataPath = outputPath.replace(/\.[^.]+$/, '.render.json');
await writeFile(
  metadataPath,
  `${JSON.stringify(
    {
      outputPath,
      jobPath,
      compositionId: composition.id,
      width: composition.width,
      height: composition.height,
      fps: composition.fps,
      durationInFrames: composition.durationInFrames,
      renderedAt: new Date().toISOString(),
    },
    null,
    2,
  )}\n`,
  'utf8',
);

console.log(`Rendered: ${outputPath}`);
console.log(`Metadata: ${metadataPath}`);
