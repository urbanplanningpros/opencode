# StrongWorkflow Brand Video Studio

Remotion-powered preview and rendering layer for the Brand Content Command Center.

## What it does

- Detects brand workspaces saved by the Brand Content Command Center in the same browser.
- Converts any content asset into one normalized `BrandVideoJob`.
- Previews the exact Remotion composition with `@remotion/player`.
- Supports shorts, story content, micro-films, and 16:9 training videos.
- Applies brand colors, short code or logo, typography, hook, message, proof, CTA, captions, voiceover, and optional direct media.
- Exports portable render-job JSON.
- Renders the same job to MP4 through `@remotion/renderer`.

## Commands

```bash
bun install
bun run typecheck
bun run dev
bun run studio
bun run validate-job -- ./example/brand-video-job.json
bun run render -- ./example/brand-video-job.json ./out/brand-video.mp4
```

## Important source distinction

`sourceReferenceUrl` is the editorial reference—such as an exact YouTube watch URL. Remotion cannot render a YouTube watch page as media. To place source footage inside the composition, supply an authorized direct media file URL through `backgroundVideoUrl` or `sourceMediaUrl`.

## Rendering

The GitHub Actions render workflow accepts a repository job path or a public JSON URL. The output MP4 and render metadata are uploaded as workflow artifacts.

## License

Remotion uses a special license. Individuals, qualifying small companies, nonprofits, and evaluation use may be eligible for the free license. Larger for-profit organizations may require a Remotion company license. Review Remotion's current license before commercial deployment.
