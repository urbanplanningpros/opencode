import type {CSSProperties, ReactNode} from 'react';
import {
  AbsoluteFill,
  Audio,
  Img,
  OffthreadVideo,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import type {BrandVideoJob} from './types';
import {normalizeJob} from './types';

const clamp = {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'} as const;

const splitBody = (body: string): string[] =>
  body
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean)
    .slice(0, 4);

const textShadow = '0 8px 34px rgba(0,0,0,.46)';

const safeUrl = (value: string): boolean => /^https?:\/\//i.test(value) || value.startsWith('data:') || value.startsWith('blob:');

const enterStyle = (frame: number, fps: number, delay = 0): CSSProperties => {
  const progress = spring({frame: frame - delay, fps, config: {damping: 18, mass: 0.72, stiffness: 130}});
  return {
    opacity: interpolate(frame - delay, [0, 8], [0, 1], clamp),
    transform: `translateY(${interpolate(progress, [0, 1], [72, 0])}px) scale(${interpolate(progress, [0, 1], [0.96, 1])})`,
  };
};

const SceneFrame = ({children, start, end}: {children: ReactNode; start: number; end: number}) => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [start, start + 8, end - 8, end], [0, 1, 1, 0], clamp);
  return <AbsoluteFill style={{opacity}}>{children}</AbsoluteFill>;
};

const AccentRule = ({color, width = '42%'}: {color: string; width?: string}) => (
  <div style={{height: 10, width, borderRadius: 999, background: color, boxShadow: `0 0 30px ${color}66`}} />
);

export const BrandVideo = (rawJob: BrandVideoJob) => {
  const job = normalizeJob(rawJob);
  const frame = useCurrentFrame();
  const {durationInFrames, fps, width, height} = useVideoConfig();
  const vertical = height > width;
  const compact = job.output.variant === 'story';
  const bodyLines = splitBody(job.content.body);
  const hookEnd = Math.round(durationInFrames * 0.22);
  const bodyEnd = Math.round(durationInFrames * 0.68);
  const proofEnd = Math.round(durationInFrames * 0.86);
  const outerPadding = vertical ? 74 : 96;
  const titleSize = vertical ? (compact ? 74 : 86) : 82;
  const bodySize = vertical ? 44 : 42;
  const activeCaption = job.captions.find((caption) => {
    const milliseconds = (frame / fps) * 1000;
    return milliseconds >= caption.startMs && milliseconds < caption.endMs;
  });
  const visualMediaUrl = job.content.backgroundVideoUrl || job.content.sourceMediaUrl;
  const backgroundStyle: CSSProperties = {
    background: `
      radial-gradient(circle at 18% 12%, ${job.brand.accentColor}44 0, transparent 31%),
      radial-gradient(circle at 88% 78%, ${job.brand.primaryColor}aa 0, transparent 34%),
      linear-gradient(145deg, ${job.brand.backgroundColor} 0%, ${job.brand.primaryColor} 58%, #02060b 100%)
    `,
    color: job.brand.textColor,
    fontFamily: job.brand.fontFamily,
    overflow: 'hidden',
  };
  const gridStyle: CSSProperties = {
    backgroundImage:
      'linear-gradient(rgba(255,255,255,.045) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.045) 1px, transparent 1px)',
    backgroundSize: vertical ? '72px 72px' : '86px 86px',
    opacity: 0.45,
    transform: `translateY(${frame * -0.22}px)`,
  };

  return (
    <AbsoluteFill style={backgroundStyle}>
      {safeUrl(visualMediaUrl) ? (
        <OffthreadVideo
          src={visualMediaUrl}
          muted
          style={{width: '100%', height: '100%', objectFit: 'cover', opacity: 0.22, filter: 'saturate(.7) contrast(1.12)'}}
        />
      ) : null}
      <AbsoluteFill style={gridStyle} />
      <AbsoluteFill style={{background: 'linear-gradient(180deg, rgba(0,0,0,.08), rgba(0,0,0,.32))'}} />

      <div
        style={{
          position: 'absolute',
          top: vertical ? 52 : 44,
          left: outerPadding,
          right: outerPadding,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 28,
          zIndex: 12,
        }}
      >
        <div style={{display: 'flex', alignItems: 'center', gap: 22}}>
          {safeUrl(job.brand.logoUrl) ? (
            <Img src={job.brand.logoUrl} style={{width: vertical ? 82 : 70, height: vertical ? 82 : 70, objectFit: 'contain'}} />
          ) : (
            <div
              style={{
                width: vertical ? 82 : 70,
                height: vertical ? 82 : 70,
                display: 'grid',
                placeItems: 'center',
                borderRadius: 20,
                background: job.brand.accentColor,
                color: job.brand.backgroundColor,
                fontWeight: 950,
                fontSize: vertical ? 29 : 25,
                letterSpacing: 1,
              }}
            >
              {job.brand.shortCode}
            </div>
          )}
          <div>
            <div style={{fontSize: vertical ? 28 : 25, fontWeight: 850, letterSpacing: 0.3}}>{job.brand.name}</div>
            <div style={{fontSize: vertical ? 21 : 18, color: 'rgba(255,255,255,.68)', marginTop: 3}}>{job.content.sourceLabel}</div>
          </div>
        </div>
        <div
          style={{
            padding: vertical ? '12px 20px' : '10px 18px',
            border: '1px solid rgba(255,255,255,.20)',
            borderRadius: 999,
            background: 'rgba(2,8,15,.34)',
            fontSize: vertical ? 20 : 17,
            fontWeight: 750,
            textTransform: 'uppercase',
            letterSpacing: 2,
          }}
        >
          {job.output.variant}
        </div>
      </div>

      <SceneFrame start={0} end={hookEnd}>
        <div
          style={{
            position: 'absolute',
            left: outerPadding,
            right: outerPadding,
            top: vertical ? '25%' : '28%',
            display: 'flex',
            flexDirection: 'column',
            gap: vertical ? 36 : 28,
            ...enterStyle(frame, fps, 0),
          }}
        >
          <div style={{fontSize: vertical ? 25 : 22, fontWeight: 900, letterSpacing: 4, color: job.brand.accentColor}}>THE HOOK</div>
          <div style={{fontSize: titleSize, lineHeight: 0.99, fontWeight: 950, maxWidth: vertical ? 940 : 1450, textShadow}}>{job.content.hook}</div>
          <AccentRule color={job.brand.accentColor} width={vertical ? '58%' : '34%'} />
        </div>
      </SceneFrame>

      <SceneFrame start={hookEnd - 1} end={bodyEnd}>
        <div
          style={{
            position: 'absolute',
            inset: vertical ? `${vertical ? 280 : 200}px ${outerPadding}px 260px` : `190px ${outerPadding}px 150px`,
            display: 'grid',
            gridTemplateColumns: vertical ? '1fr' : '0.9fr 1.35fr',
            alignItems: 'center',
            gap: vertical ? 46 : 74,
          }}
        >
          <div style={{...enterStyle(frame - hookEnd, fps, 0)}}>
            <div style={{fontSize: vertical ? 24 : 21, color: job.brand.accentColor, fontWeight: 900, letterSpacing: 3}}>THE MESSAGE</div>
            <div style={{fontSize: titleSize * 0.82, lineHeight: 1.02, marginTop: 22, fontWeight: 950, textShadow}}>{job.content.headline}</div>
          </div>
          <div style={{display: 'flex', flexDirection: 'column', gap: vertical ? 24 : 20}}>
            {bodyLines.map((line, index) => (
              <div
                key={`${line}-${index}`}
                style={{
                  ...enterStyle(frame - hookEnd, fps, 7 + index * 7),
                  display: 'grid',
                  gridTemplateColumns: vertical ? '58px 1fr' : '52px 1fr',
                  gap: 20,
                  alignItems: 'start',
                  padding: vertical ? '23px 25px' : '19px 22px',
                  borderRadius: 22,
                  background: 'rgba(2,8,15,.46)',
                  border: '1px solid rgba(255,255,255,.12)',
                  boxShadow: '0 20px 50px rgba(0,0,0,.18)',
                }}
              >
                <div
                  style={{
                    width: vertical ? 52 : 46,
                    height: vertical ? 52 : 46,
                    borderRadius: 15,
                    display: 'grid',
                    placeItems: 'center',
                    color: job.brand.backgroundColor,
                    background: job.brand.accentColor,
                    fontSize: vertical ? 24 : 21,
                    fontWeight: 950,
                  }}
                >
                  {index + 1}
                </div>
                <div style={{fontSize: bodySize, lineHeight: 1.18, fontWeight: 720}}>{line}</div>
              </div>
            ))}
          </div>
        </div>
      </SceneFrame>

      <SceneFrame start={bodyEnd - 1} end={proofEnd}>
        <div
          style={{
            position: 'absolute',
            inset: vertical ? '28% 70px auto' : '28% 120px auto',
            textAlign: 'center',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 36,
            ...enterStyle(frame - bodyEnd, fps, 0),
          }}
        >
          <div style={{fontSize: vertical ? 25 : 22, fontWeight: 900, letterSpacing: 4, color: job.brand.accentColor}}>WHY IT MATTERS</div>
          <div style={{fontSize: vertical ? 72 : 68, lineHeight: 1.04, fontWeight: 950, maxWidth: vertical ? 940 : 1440, textShadow}}>{job.content.proof}</div>
          <AccentRule color={job.brand.accentColor} width={vertical ? '48%' : '28%'} />
        </div>
      </SceneFrame>

      <SceneFrame start={proofEnd - 1} end={durationInFrames}>
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'grid',
            placeItems: 'center',
            textAlign: 'center',
            padding: outerPadding,
          }}
        >
          <div style={{display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 34, ...enterStyle(frame - proofEnd, fps, 0)}}>
            <div style={{fontSize: vertical ? 31 : 27, fontWeight: 850, color: 'rgba(255,255,255,.76)', letterSpacing: 1.5}}>TAKE THE NEXT STEP</div>
            <div
              style={{
                padding: vertical ? '30px 52px' : '25px 48px',
                borderRadius: 24,
                background: job.brand.accentColor,
                color: job.brand.backgroundColor,
                fontSize: vertical ? 64 : 58,
                lineHeight: 1,
                fontWeight: 950,
                boxShadow: `0 22px 70px ${job.brand.accentColor}55`,
              }}
            >
              {job.content.cta}
            </div>
            <div style={{fontSize: vertical ? 26 : 22, color: 'rgba(255,255,255,.68)'}}>{job.brand.name}</div>
          </div>
        </div>
      </SceneFrame>

      {activeCaption ? (
        <div
          style={{
            position: 'absolute',
            left: vertical ? 62 : 180,
            right: vertical ? 62 : 180,
            bottom: vertical ? 128 : 72,
            zIndex: 30,
            display: 'flex',
            justifyContent: 'center',
          }}
        >
          <div
            style={{
              maxWidth: vertical ? 920 : 1360,
              padding: vertical ? '20px 28px' : '15px 24px',
              borderRadius: 18,
              background: 'rgba(0,0,0,.76)',
              border: '1px solid rgba(255,255,255,.16)',
              textAlign: 'center',
              fontSize: vertical ? 39 : 32,
              lineHeight: 1.14,
              fontWeight: 850,
              textShadow,
            }}
          >
            {activeCaption.text}
          </div>
        </div>
      ) : null}

      <div style={{position: 'absolute', left: 0, right: 0, bottom: 0, height: 10, background: 'rgba(255,255,255,.12)', zIndex: 40}}>
        <div style={{height: '100%', width: `${(frame / Math.max(1, durationInFrames - 1)) * 100}%`, background: job.brand.accentColor}} />
      </div>

      {safeUrl(job.content.voiceoverUrl) ? <Audio src={job.content.voiceoverUrl} /> : null}
    </AbsoluteFill>
  );
};
