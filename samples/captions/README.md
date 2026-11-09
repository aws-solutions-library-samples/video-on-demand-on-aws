# Caption sidecar samples (`captionsProfile` overlay)

The captions overlay (`-c captionsProfile=ON`) adds WebVTT/IMSC caption tracks to an asset when a
per-asset **caption sidecar** accompanies the source video in the source bucket.

## Naming convention

For a source object `some/prefix/movie.mp4`, upload the caption sidecar as
`some/prefix/movie.mp4.vtt` (the full source key + `.vtt`). This mirrors the ad-markers convention
(`<source>.esam.xml`). The EventBridge trigger rule excludes `*.vtt` (when `captionsProfile=ON`) so the
sidecar never starts its own workflow.

- **Source format (v1):** WebVTT (`.vtt`), single language.
- **Output formats:** WebVTT on the HLS and CMAF outputs, IMSC on the DASH output.
- **Graceful skip:** an asset with **no** sidecar encodes normally (no caption tracks, no failure).

`sample.vtt` here is a minimal dummy you can rename to `<your-source>.vtt` for upload testing.

Enable with `captionsProfile=ON` on the core stack; see the [root README](../../README.md#configuration).
