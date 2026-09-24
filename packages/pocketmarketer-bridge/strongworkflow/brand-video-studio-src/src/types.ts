export type BrandVideoVariant = 'short' | 'story' | 'film' | 'training';

export type BrandVideoCaption = {
  startMs: number;
  endMs: number;
  text: string;
};

export type BrandIdentity = {
  name: string;
  shortCode: string;
  primaryColor: string;
  accentColor: string;
  backgroundColor: string;
  textColor: string;
  logoUrl: string;
  fontFamily: string;
};

export type BrandVideoContent = {
  headline: string;
  hook: string;
  body: string;
  proof: string;
  cta: string;
  sourceLabel: string;
  sourceReferenceUrl: string;
  sourceMediaUrl: string;
  backgroundVideoUrl: string;
  galleryImageUrls: string[];
  voiceoverUrl: string;
};

export type BrandVideoOutput = {
  variant: BrandVideoVariant;
  width: number;
  height: number;
  fps: number;
  durationInSeconds: number;
};

export type BrandVideoJob = {
  id: string;
  assetId: string;
  brand: BrandIdentity;
  content: BrandVideoContent;
  output: BrandVideoOutput;
  captions: BrandVideoCaption[];
  createdAt: string;
};

export const variantDimensions: Record<BrandVideoVariant, {width: number; height: number}> = {
  short: {width: 1080, height: 1920},
  story: {width: 1080, height: 1920},
  film: {width: 1080, height: 1920},
  training: {width: 1920, height: 1080},
};

const recordOf = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const stringOf = (value: unknown, fallback = ''): string =>
  typeof value === 'string' ? value : typeof value === 'number' ? String(value) : fallback;

const stringArrayOf = (value: unknown): string[] => {
  if (Array.isArray(value)) {
    return value.map((item) => stringOf(item).trim()).filter(Boolean);
  }
  if (typeof value === 'string') {
    return value
      .split(/\r?\n|,/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
};

const numberOf = (value: unknown, fallback: number): number => {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const colorOf = (value: unknown, fallback: string): string => {
  const candidate = stringOf(value).trim();
  return /^#[0-9a-f]{6}$/i.test(candidate) ? candidate : fallback;
};

const variantOf = (value: unknown): BrandVideoVariant => {
  if (value === 'story' || value === 'film' || value === 'training') return value;
  return 'short';
};

export const normalizeJob = (input: unknown): BrandVideoJob => {
  const root = recordOf(input);
  const brand = recordOf(root.brand);
  const content = recordOf(root.content);
  const output = recordOf(root.output);
  const variant = variantOf(output.variant);
  const dimensions = variantDimensions[variant];
  const captions = Array.isArray(root.captions)
    ? root.captions
        .map((caption) => {
          const row = recordOf(caption);
          return {
            startMs: Math.max(0, numberOf(row.startMs, 0)),
            endMs: Math.max(0, numberOf(row.endMs, 0)),
            text: stringOf(row.text).trim(),
          };
        })
        .filter((caption) => caption.text && caption.endMs > caption.startMs)
    : [];

  return {
    id: stringOf(root.id, `job-${Date.now()}`),
    assetId: stringOf(root.assetId, 'UNASSIGNED'),
    brand: {
      name: stringOf(brand.name, 'Your Brand'),
      shortCode: stringOf(brand.shortCode, 'BR').slice(0, 4).toUpperCase(),
      primaryColor: colorOf(brand.primaryColor, '#071a2f'),
      accentColor: colorOf(brand.accentColor, '#e1ad45'),
      backgroundColor: colorOf(brand.backgroundColor, '#06111f'),
      textColor: colorOf(brand.textColor, '#ffffff'),
      logoUrl: stringOf(brand.logoUrl),
      fontFamily: stringOf(brand.fontFamily, 'Inter, Arial, sans-serif'),
    },
    content: {
      headline: stringOf(content.headline, 'Build content that moves people.'),
      hook: stringOf(content.hook, 'Attention is earned in the first two seconds.'),
      body: stringOf(content.body, 'Use a clear problem, an understandable mechanism, and one next step.'),
      proof: stringOf(content.proof, 'Structure + Content + Support'),
      cta: stringOf(content.cta, 'Book Now'),
      sourceLabel: stringOf(content.sourceLabel, 'Original Brand Content'),
      sourceReferenceUrl: stringOf(content.sourceReferenceUrl),
      sourceMediaUrl: stringOf(content.sourceMediaUrl),
      backgroundVideoUrl: stringOf(content.backgroundVideoUrl),
      galleryImageUrls: stringArrayOf(content.galleryImageUrls ?? content.imageUrls ?? content.images),
      voiceoverUrl: stringOf(content.voiceoverUrl),
    },
    output: {
      variant,
      width: Math.round(numberOf(output.width, dimensions.width)),
      height: Math.round(numberOf(output.height, dimensions.height)),
      fps: Math.max(12, Math.round(numberOf(output.fps, 30))),
      durationInSeconds: Math.max(6, Math.min(180, numberOf(output.durationInSeconds, variant === 'film' ? 75 : variant === 'training' ? 90 : 35))),
    },
    captions,
    createdAt: stringOf(root.createdAt, new Date().toISOString()),
  };
};

export const toDurationInFrames = (job: BrandVideoJob): number =>
  Math.max(1, Math.round(job.output.durationInSeconds * job.output.fps));

export const parseTargetDuration = (value: unknown, variant: BrandVideoVariant): number => {
  const text = stringOf(value);
  const numbers = text.match(/\d+/g)?.map(Number).filter(Number.isFinite) ?? [];
  if (numbers.length > 0) return Math.max(6, Math.min(180, numbers[numbers.length - 1]));
  return variant === 'film' ? 75 : variant === 'training' ? 90 : variant === 'story' ? 40 : 35;
};
