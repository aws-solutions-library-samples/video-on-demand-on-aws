# Ad-marker sidecar samples (`adMarkersProfile` overlay)

The ad-markers overlay (`-c adMarkersProfile=ON`) inserts SCTE-35 ad-break markers into an asset's
outputs when a per-asset **ESAM SCC XML sidecar** accompanies the source video in the source bucket.

## Naming convention

For a source object `some/prefix/movie.mp4`, upload the ESAM sidecar as
`some/prefix/movie.mp4.esam.xml` (the full source key + `.esam.xml`). Upload the sidecar before (or
together with) the video. The EventBridge trigger rule excludes `*.esam.xml` so the sidecar never starts
its own workflow.

- **Format:** an ESAM `SignalProcessingNotification` document (CableLabs `OC-SP-ESAM-API-I03-131025`),
  passed to MediaConvert inline as `Settings.Esam.SignalProcessingNotification.SccXml`.
- **Timing:** insertion points are relative to the final output timeline (starting at 0) and land on the
  nearest segment boundary, so align avails to the 6s segment length.
- **Graceful skip:** an asset with **no** sidecar encodes normally (no markers, no failure). A malformed
  sidecar fails the asset at the Process stage with a MediaConvert error.

`scte35-esam-sample.xml` here defines two 30-second ad avails (at 120s and 300s). Rename it to
`<your-source>.esam.xml` and edit the `ResponseSignal` / `ConditioningInfo` entries (NPT point,
`startOffset`, `duration`) to match your content. The comments in the file explain the structure.

Enable with `adMarkersProfile=ON` on the core stack; see the [root README](../../README.md#configuration).
