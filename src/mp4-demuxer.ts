import { createFile, DataStream, Endianness, MP4BoxBuffer } from "mp4box";
import type { ISOFile, Sample, Track } from "mp4box";

export interface DemuxResult {
  config: VideoDecoderConfig;
  durationSeconds: number;
}

/**
 * Demuxes the first video track of an MP4 file, invoking `onConfig` once the
 * decoder config is known and `onChunk` for every sample, in decode order.
 */
export function demuxVideoTrack(
  arrayBuffer: ArrayBuffer,
  onConfig: (result: DemuxResult) => void,
  onChunk: (chunk: EncodedVideoChunk) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = createFile();
    let videoTrackId = -1;

    file.onError = (module, message) => {
      reject(new Error(`mp4box error in ${module}: ${message}`));
    };

    file.onReady = (info) => {
      const videoTrack = info.videoTracks[0];
      if (!videoTrack) {
        reject(new Error("No video track found in this file."));
        return;
      }

      videoTrackId = videoTrack.id;
      onConfig({
        config: buildDecoderConfig(file, videoTrack),
        durationSeconds: videoTrack.duration / videoTrack.timescale,
      });

      file.setExtractionOptions(videoTrackId, undefined, { nbSamples: 100 });
      file.start();
    };

    file.onSamples = (trackId, _user, samples) => {
      if (trackId !== videoTrackId) return;
      for (const sample of samples) {
        onChunk(sampleToChunk(sample));
      }
    };

    const mp4Buffer = MP4BoxBuffer.fromArrayBuffer(arrayBuffer, 0);
    file.appendBuffer(mp4Buffer);
    file.flush();
    resolve();
  });
}

function sampleToChunk(sample: Sample): EncodedVideoChunk {
  return new EncodedVideoChunk({
    type: sample.is_sync ? "key" : "delta",
    timestamp: (sample.cts * 1_000_000) / sample.timescale,
    duration: (sample.duration * 1_000_000) / sample.timescale,
    data: sample.data!,
  });
}

/**
 * Builds a VideoDecoderConfig for a track, including the codec-specific
 * `description` (avcC/hvcC/vpcC/av1C box contents) that VideoDecoder needs
 * for AVC/HEVC "not annex B" bitstreams. mp4box doesn't expose this
 * directly, so we re-serialize whichever config box is present on the first
 * sample entry and strip its 8-byte box header.
 */
function buildDecoderConfig(file: ISOFile, track: Track): VideoDecoderConfig {
  const trak = file.getTrackById(track.id);
  const entry = trak.mdia.minf.stbl.stsd.entries[0] as unknown as {
    avcC?: { write(stream: DataStream): void };
    hvcC?: { write(stream: DataStream): void };
    vpcC?: { write(stream: DataStream): void };
    av1C?: { write(stream: DataStream): void };
  };
  const configBox = entry.avcC ?? entry.hvcC ?? entry.vpcC ?? entry.av1C;

  let description: Uint8Array | undefined;
  if (configBox) {
    const stream = new DataStream(undefined, 0, Endianness.BIG_ENDIAN);
    configBox.write(stream);
    description = new Uint8Array(stream.buffer, 8);
  }

  return {
    codec: track.codec,
    codedWidth: track.video?.width ?? track.track_width,
    codedHeight: track.video?.height ?? track.track_height,
    description,
  };
}
