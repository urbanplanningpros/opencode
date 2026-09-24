import {Composition} from 'remotion';
import {BrandVideo} from './BrandVideo';
import {sampleJob} from './sample-job';
import {normalizeJob, toDurationInFrames} from './types';

export const RemotionRoot = () => (
  <Composition
    id="BrandVideo"
    component={BrandVideo}
    defaultProps={sampleJob}
    durationInFrames={toDurationInFrames(sampleJob)}
    fps={sampleJob.output.fps}
    width={sampleJob.output.width}
    height={sampleJob.output.height}
    calculateMetadata={({props}) => {
      const job = normalizeJob(props);
      return {
        durationInFrames: toDurationInFrames(job),
        fps: job.output.fps,
        width: job.output.width,
        height: job.output.height,
        props: job,
      };
    }}
  />
);
