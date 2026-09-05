/**
 * Decodes a bounded range of chunks `[startIndex, endIndexExclusive)` with a
 * fresh `VideoDecoder`, and resolves with every output `VideoFrame` in
 * presentation order. `startIndex` must be a keyframe — this doesn't
 * validate that, callers (seeking, reverse playback) get it from
 * `KeyframeIndex`, which only ever returns keyframe chunk indices for GOP
 * boundaries.
 *
 * Used both for seeking (decode the target GOP, then pick the frame at/
 * after the requested timestamp) and reverse playback (decode a whole GOP,
 * then play the resulting array back-to-front). A GOP is small enough
 * (one keyframe interval) that decoding it whole is cheap and much simpler
 * than trying to stream partial output mid-GOP.
 */
export function decodeChunkRange(
  chunks: readonly EncodedVideoChunk[],
  config: VideoDecoderConfig,
  startIndex: number,
  endIndexExclusive: number,
): Promise<VideoFrame[]> {
  return new Promise((resolve, reject) => {
    const frames: VideoFrame[] = [];
    // On any failure path, the caller never receives `frames` — so any
    // frames already produced before the failure would otherwise leak
    // (nothing else holds a reference to close them). `settled` also
    // guards against double-cleanup, since a decode error can trigger both
    // the `error` callback below and a rejected `flush()` for the same
    // underlying failure.
    let settled = false;
    function fail(error: unknown): void {
      if (settled) return;
      settled = true;
      frames.forEach((frame) => frame.close());
      frames.length = 0;
      reject(error);
    }

    const decoder = new VideoDecoder({
      output: (frame) => frames.push(frame),
      error: (error) => fail(error),
    });

    try {
      decoder.configure(config);
      for (let i = startIndex; i < endIndexExclusive; i++) {
        decoder.decode(chunks[i]);
      }
    } catch (error) {
      fail(error);
      return;
    }

    decoder
      .flush()
      .then(() => {
        if (settled) return;
        settled = true;
        decoder.close();
        resolve(frames);
      })
      .catch((error) => fail(error));
  });
}
