import {Player} from '@remotion/player';
import {useEffect, useMemo, useState, type ChangeEvent} from 'react';
import {BrandVideo} from './BrandVideo';
import {sampleJob} from './sample-job';
import type {BrandVideoCaption, BrandVideoJob, BrandVideoVariant} from './types';
import {normalizeJob, parseTargetDuration, toDurationInFrames, variantDimensions} from './types';

const JOB_STORAGE_KEY = 'strongworkflow.brand-video-studio.job.v1';
const RENDER_WORKFLOW_URL = 'https://github.com/urbanplanningpros/opencode/actions/workflows/brand-remotion-render.yml';

const recordOf = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const stringOf = (value: unknown, fallback = ''): string =>
  typeof value === 'string' ? value : typeof value === 'number' ? String(value) : fallback;

const arrayOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const valueFrom = (record: Record<string, unknown>, keys: string[], fallback = ''): string => {
  for (const key of keys) {
    const value = stringOf(record[key]).trim();
    if (value) return value;
  }
  return fallback;
};

const download = (filename: string, contents: string, type: string) => {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([contents], {type}));
  link.download = filename;
  link.click();
  URL.revokeObjectURL(link.href);
};

const variantFromFormat = (format: string): BrandVideoVariant => {
  const normalized = format.toLowerCase();
  if (normalized.includes('film') || normalized.includes('documentary')) return 'film';
  if (normalized.includes('story')) return 'story';
  if (normalized.includes('training') || normalized.includes('explainer') || normalized.includes('landscape')) return 'training';
  return 'short';
};

const buildCaptions = (job: BrandVideoJob): BrandVideoCaption[] => {
  const sentences = [job.content.hook, ...job.content.body.split(/(?<=[.!?])\s+/), job.content.proof]
    .map((sentence) => sentence.trim())
    .filter(Boolean);
  if (sentences.length === 0) return [];
  const usableMs = Math.max(2000, job.output.durationInSeconds * 1000 - 2500);
  const segmentMs = usableMs / sentences.length;
  return sentences.map((text, index) => ({
    startMs: Math.round(index * segmentMs),
    endMs: Math.round((index + 1) * segmentMs),
    text,
  }));
};

type WorkspaceBrand = {
  key: string;
  name: string;
  brand: Record<string, unknown>;
  assets: Record<string, unknown>[];
  sources: Record<string, unknown>[];
};

const findWorkspaces = (): WorkspaceBrand[] => {
  const found: WorkspaceBrand[] = [];
  for (let index = 0; index < localStorage.length; index += 1) {
    const storageKey = localStorage.key(index);
    if (!storageKey || storageKey === JOB_STORAGE_KEY) continue;
    try {
      const parsed = JSON.parse(localStorage.getItem(storageKey) ?? 'null') as unknown;
      const root = recordOf(parsed);
      const possibleBrands = arrayOf(root.brands).length > 0 ? arrayOf(root.brands) : arrayOf(recordOf(root.workspace).brands);
      possibleBrands.forEach((value, brandIndex) => {
        const brand = recordOf(value);
        const name = valueFrom(brand, ['name', 'brandName', 'title'], `Brand ${brandIndex + 1}`);
        const assets = arrayOf(brand.assets ?? brand.contentAssets ?? brand.queue).map(recordOf);
        const sources = arrayOf(brand.sources ?? brand.sourceLibrary).map(recordOf);
        if (assets.length === 0 && sources.length === 0) return;
        found.push({key: `${storageKey}:${brandIndex}`, name, brand, assets, sources});
      });
    } catch {
      // Ignore unrelated localStorage entries.
    }
  }
  return found;
};

const sourceForAsset = (asset: Record<string, unknown>, sources: Record<string, unknown>[]): Record<string, unknown> => {
  const sourceId = valueFrom(asset, ['sourceId', 'source_id']);
  return sources.find((source) => valueFrom(source, ['sourceId', 'source_id', 'id']) === sourceId) ?? {};
};

const jobFromWorkspace = (workspace: WorkspaceBrand, asset: Record<string, unknown>): BrandVideoJob => {
  const brand = workspace.brand;
  const source = sourceForAsset(asset, workspace.sources);
  const format = valueFrom(asset, ['format', 'contentType'], 'Short');
  const variant = variantFromFormat(format);
  const dimensions = variantDimensions[variant];
  const brandName = valueFrom(brand, ['name', 'brandName', 'title'], workspace.name);
  const shortCode = valueFrom(brand, ['shortCode', 'code'], brandName.split(/\s+/).map((word) => word[0]).join('').slice(0, 3));
  const exactSource = valueFrom(asset, ['exactYoutubeUrl', 'timestampedYoutubeUrl', 'sourceUrl'], valueFrom(source, ['exactYoutubeUrl', 'youtubeUrl', 'url', 'sourceUrl']));
  const duration = parseTargetDuration(asset.targetDuration ?? asset.duration, variant);

  return normalizeJob({
    id: `render-${valueFrom(asset, ['assetId', 'id'], Date.now().toString())}`,
    assetId: valueFrom(asset, ['assetId', 'id'], 'UNASSIGNED'),
    brand: {
      name: brandName,
      shortCode,
      primaryColor: valueFrom(brand, ['primaryColor', 'brandColor'], '#071a2f'),
      accentColor: valueFrom(brand, ['accentColor', 'secondaryColor'], '#e1ad45'),
      backgroundColor: valueFrom(brand, ['backgroundColor'], '#06111f'),
      textColor: valueFrom(brand, ['textColor'], '#ffffff'),
      logoUrl: valueFrom(brand, ['logoUrl', 'logo']),
      fontFamily: valueFrom(brand, ['fontFamily'], 'Inter, Arial, sans-serif'),
    },
    content: {
      headline: valueFrom(asset, ['headline', 'onScreenHeadline', 'title'], 'BRAND CONTENT'),
      hook: valueFrom(asset, ['hook'], 'Earn attention. Teach clearly. Move to the next step.'),
      body: valueFrom(asset, ['script', 'voiceover', 'voiceoverScript', 'body'], valueFrom(brand, ['corePromise', 'promise'])),
      proof: valueFrom(asset, ['proof', 'whyItMatters', 'visualDirection'], valueFrom(brand, ['primaryOffer', 'offer'], 'Structure + Content + Support')),
      cta: valueFrom(asset, ['cta'], valueFrom(brand, ['primaryCta', 'primaryCTA', 'cta'], 'BOOK NOW')),
      sourceLabel: valueFrom(source, ['creator', 'channel'], valueFrom(asset, ['creator'], 'Original Brand Content')),
      sourceReferenceUrl: exactSource,
      sourceMediaUrl: valueFrom(asset, ['sourceMediaUrl', 'mediaUrl']),
      backgroundVideoUrl: valueFrom(asset, ['backgroundVideoUrl', 'brollUrl']),
      voiceoverUrl: valueFrom(asset, ['voiceoverUrl', 'audioUrl']),
    },
    output: {
      variant,
      width: dimensions.width,
      height: dimensions.height,
      fps: 30,
      durationInSeconds: duration,
    },
    captions: arrayOf(asset.captions),
    createdAt: new Date().toISOString(),
  });
};

const initialJob = (): BrandVideoJob => {
  try {
    const stored = localStorage.getItem(JOB_STORAGE_KEY);
    if (stored) return normalizeJob(JSON.parse(stored) as unknown);
  } catch {
    // Fall through to the sample job.
  }
  return sampleJob;
};

const TextField = ({label, value, onChange, multiline = false}: {label: string; value: string; onChange: (value: string) => void; multiline?: boolean}) => (
  <label className="field">
    <span>{label}</span>
    {multiline ? <textarea value={value} rows={4} onChange={(event) => onChange(event.target.value)} /> : <input value={value} onChange={(event) => onChange(event.target.value)} />}
  </label>
);

export const App = () => {
  const [job, setJob] = useState<BrandVideoJob>(initialJob);
  const [workspaces, setWorkspaces] = useState<WorkspaceBrand[]>(() => findWorkspaces());
  const [workspaceKey, setWorkspaceKey] = useState('');
  const [assetId, setAssetId] = useState('');
  const [status, setStatus] = useState('Preview and render from the same job JSON.');

  const activeWorkspace = workspaces.find((workspace) => workspace.key === workspaceKey);
  const playerHeight = job.output.height > job.output.width ? 720 : 500;
  const durationInFrames = toDurationInFrames(job);

  useEffect(() => {
    localStorage.setItem(JOB_STORAGE_KEY, JSON.stringify(job));
  }, [job]);

  const activeAssets = useMemo(() => activeWorkspace?.assets ?? [], [activeWorkspace]);

  const updateBrand = (key: keyof BrandVideoJob['brand'], value: string) =>
    setJob((current) => normalizeJob({...current, brand: {...current.brand, [key]: value}}));

  const updateContent = (key: keyof BrandVideoJob['content'], value: string) =>
    setJob((current) => normalizeJob({...current, content: {...current.content, [key]: value}}));

  const updateOutput = (key: keyof BrandVideoJob['output'], value: string | number) =>
    setJob((current) => normalizeJob({...current, output: {...current.output, [key]: value}}));

  const applyVariant = (variant: BrandVideoVariant) => {
    const dimensions = variantDimensions[variant];
    setJob((current) => normalizeJob({...current, output: {...current.output, variant, ...dimensions}}));
  };

  const loadWorkspaceAsset = () => {
    if (!activeWorkspace) return;
    const asset = activeWorkspace.assets.find((candidate) => valueFrom(candidate, ['assetId', 'id']) === assetId);
    if (!asset) return;
    const next = jobFromWorkspace(activeWorkspace, asset);
    setJob({...next, captions: next.captions.length > 0 ? next.captions : buildCaptions(next)});
    setStatus(`${next.assetId} loaded from ${activeWorkspace.name}.`);
  };

  const refreshWorkspaces = () => {
    const next = findWorkspaces();
    setWorkspaces(next);
    setStatus(`${next.length} dashboard brand workspace${next.length === 1 ? '' : 's'} detected.`);
  };

  const importJob = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text()) as unknown;
      const next = normalizeJob(parsed);
      setJob(next);
      setStatus(`${next.assetId} render job imported.`);
    } catch (error) {
      setStatus(`Import failed: ${String(error)}`);
    } finally {
      event.target.value = '';
    }
  };

  const exportJob = () => {
    download(`${job.assetId || 'brand-video'}-remotion-job.json`, `${JSON.stringify(job, null, 2)}\n`, 'application/json');
    setStatus('Render job downloaded.');
  };

  const copyJob = async () => {
    await navigator.clipboard.writeText(JSON.stringify(job, null, 2));
    setStatus('Render job copied to clipboard.');
  };

  const generateCaptions = () => {
    setJob((current) => ({...current, captions: buildCaptions(current)}));
    setStatus('Caption timing generated from the current script.');
  };

  return (
    <div className="studio-shell">
      <header className="studio-header">
        <div className="brand-lockup">
          <div className="brand-mark">SW</div>
          <div>
            <div className="eyebrow">StrongWorkflow × Remotion</div>
            <h1>Brand Video Studio</h1>
            <p>Turn any approved content brief into a previewable, render-ready composition.</p>
          </div>
        </div>
        <div className="header-actions">
          <a className="button ghost" href="../brand-content-command-center/index.html">← Command Center</a>
          <a className="button secondary" href={RENDER_WORKFLOW_URL} target="_blank" rel="noreferrer">Render MP4</a>
          <button className="button primary" type="button" onClick={exportJob}>Download Job</button>
        </div>
      </header>

      <div className="studio-grid">
        <aside className="control-panel">
          <section className="panel-card dashboard-import">
            <div className="section-heading">
              <div>
                <span>Dashboard connection</span>
                <h2>Load a brand asset</h2>
              </div>
              <button className="text-button" type="button" onClick={refreshWorkspaces}>Refresh</button>
            </div>
            {workspaces.length === 0 ? (
              <p className="empty-copy">No dashboard workspace was found in this browser. Import a render job or open the Command Center first.</p>
            ) : (
              <>
                <label className="field">
                  <span>Brand workspace</span>
                  <select value={workspaceKey} onChange={(event) => {setWorkspaceKey(event.target.value); setAssetId('');}}>
                    <option value="">Choose a brand</option>
                    {workspaces.map((workspace) => <option key={workspace.key} value={workspace.key}>{workspace.name}</option>)}
                  </select>
                </label>
                <label className="field">
                  <span>Content asset</span>
                  <select value={assetId} onChange={(event) => setAssetId(event.target.value)} disabled={!activeWorkspace}>
                    <option value="">Choose an asset</option>
                    {activeAssets.map((asset, index) => {
                      const id = valueFrom(asset, ['assetId', 'id'], `Asset ${index + 1}`);
                      const headline = valueFrom(asset, ['headline', 'onScreenHeadline', 'title']);
                      return <option key={`${id}-${index}`} value={id}>{id}{headline ? ` — ${headline}` : ''}</option>;
                    })}
                  </select>
                </label>
                <button className="button primary full" type="button" disabled={!assetId} onClick={loadWorkspaceAsset}>Load Into Studio</button>
              </>
            )}
            <label className="button upload-button full">
              Import Render Job
              <input type="file" accept="application/json" hidden onChange={importJob} />
            </label>
          </section>

          <section className="panel-card">
            <div className="section-heading"><div><span>Output</span><h2>Format and timing</h2></div></div>
            <div className="variant-grid">
              {(['short', 'story', 'film', 'training'] as const).map((variant) => (
                <button className={`variant-button ${job.output.variant === variant ? 'active' : ''}`} type="button" key={variant} onClick={() => applyVariant(variant)}>{variant}</button>
              ))}
            </div>
            <div className="field-row">
              <label className="field"><span>Seconds</span><input type="number" min="6" max="180" value={job.output.durationInSeconds} onChange={(event) => updateOutput('durationInSeconds', event.target.value)} /></label>
              <label className="field"><span>FPS</span><input type="number" min="12" max="60" value={job.output.fps} onChange={(event) => updateOutput('fps', event.target.value)} /></label>
            </div>
          </section>

          <section className="panel-card">
            <div className="section-heading"><div><span>Brand system</span><h2>Identity</h2></div></div>
            <TextField label="Brand name" value={job.brand.name} onChange={(value) => updateBrand('name', value)} />
            <TextField label="Short code" value={job.brand.shortCode} onChange={(value) => updateBrand('shortCode', value)} />
            <div className="color-grid">
              {(['primaryColor', 'accentColor', 'backgroundColor', 'textColor'] as const).map((key) => (
                <label className="color-field" key={key}><span>{key.replace('Color', '')}</span><input type="color" value={job.brand[key]} onChange={(event) => updateBrand(key, event.target.value)} /></label>
              ))}
            </div>
            <TextField label="Logo URL" value={job.brand.logoUrl} onChange={(value) => updateBrand('logoUrl', value)} />
          </section>

          <section className="panel-card">
            <div className="section-heading"><div><span>Creative brief</span><h2>Message</h2></div></div>
            <TextField label="Hook" value={job.content.hook} multiline onChange={(value) => updateContent('hook', value)} />
            <TextField label="On-screen headline" value={job.content.headline} multiline onChange={(value) => updateContent('headline', value)} />
            <TextField label="Body / voiceover" value={job.content.body} multiline onChange={(value) => updateContent('body', value)} />
            <TextField label="Proof / positioning" value={job.content.proof} multiline onChange={(value) => updateContent('proof', value)} />
            <TextField label="Call to action" value={job.content.cta} onChange={(value) => updateContent('cta', value)} />
          </section>

          <section className="panel-card">
            <div className="section-heading"><div><span>Media</span><h2>Production inputs</h2></div></div>
            <TextField label="Source reference URL" value={job.content.sourceReferenceUrl} onChange={(value) => updateContent('sourceReferenceUrl', value)} />
            <TextField label="Direct background video URL" value={job.content.backgroundVideoUrl} onChange={(value) => updateContent('backgroundVideoUrl', value)} />
            <TextField label="Voiceover audio URL" value={job.content.voiceoverUrl} onChange={(value) => updateContent('voiceoverUrl', value)} />
            <button className="button ghost full" type="button" onClick={generateCaptions}>Generate Caption Timing</button>
          </section>
        </aside>

        <main className="preview-column">
          <section className="preview-card">
            <div className="preview-toolbar">
              <div>
                <span className="status-dot" /> Live Remotion preview
                <strong>{job.output.width} × {job.output.height} · {job.output.fps} fps · {job.output.durationInSeconds}s</strong>
              </div>
              <div className="preview-actions">
                {job.content.sourceReferenceUrl ? <a href={job.content.sourceReferenceUrl} target="_blank" rel="noreferrer">Open source ↗</a> : null}
                <button type="button" onClick={copyJob}>Copy JSON</button>
              </div>
            </div>
            <div className={`player-stage ${job.output.height > job.output.width ? 'vertical' : 'horizontal'}`} style={{minHeight: playerHeight}}>
              <Player
                component={BrandVideo}
                inputProps={job}
                durationInFrames={durationInFrames}
                compositionWidth={job.output.width}
                compositionHeight={job.output.height}
                fps={job.output.fps}
                controls
                loop
                clickToPlay
                style={{width: '100%', maxHeight: playerHeight, aspectRatio: `${job.output.width} / ${job.output.height}`}}
              />
            </div>
          </section>

          <section className="job-card">
            <div className="job-head">
              <div>
                <span>Render job</span>
                <h2>{job.assetId}</h2>
              </div>
              <div className="job-state">{status}</div>
            </div>
            <div className="job-metrics">
              <div><span>Composition</span><strong>BrandVideo</strong></div>
              <div><span>Frames</span><strong>{durationInFrames.toLocaleString()}</strong></div>
              <div><span>Captions</span><strong>{job.captions.length}</strong></div>
              <div><span>Variant</span><strong>{job.output.variant}</strong></div>
            </div>
            <div className="render-command">
              <span>Local render command</span>
              <code>bun run render -- ./example/brand-video-job.json ./out/{job.assetId}.mp4</code>
            </div>
            <div className="job-buttons">
              <button className="button ghost" type="button" onClick={copyJob}>Copy Job JSON</button>
              <button className="button primary" type="button" onClick={exportJob}>Download Render Job</button>
            </div>
          </section>
        </main>
      </div>
    </div>
  );
};
