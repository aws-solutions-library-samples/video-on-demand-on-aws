/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. Apache-2.0.
 *
 * Parse the ESAM SignalProcessingNotification (SCC XML) that the pipeline persists per asset
 * (`adMarkersEsamXml`) into a flat list of ad avails for the operator asset page. The XML is the
 * source of truth for the authored SCTE-35 markers; each avail is a START ResponseSignal
 * (SegmentationDescriptorInfo@segmentTypeId="52", carrying the duration) at an NPTPoint (seconds).
 * Browser-only (uses DOMParser); returns [] on empty/malformed input so the caller can fall back to
 * showing the raw XML.
 */

/** One ad avail: a placement opportunity start on the final output timeline. */
export interface AdAvail {
  /** 1-based position after sorting by start time. */
  index: number;
  /** Avail start, in seconds on the final output timeline (NPT). */
  startSeconds: number;
  /** Avail duration in seconds; null = open/unbounded (e.g. PT0S or absent). */
  durationSeconds: number | null;
}

/** SegmentationDescriptor segmentTypeId for a Provider Placement Opportunity Start. */
const PPO_START = '52';

/** Parse an ISO-8601 duration like `PT30S`, `PT1M30S`, `PT1H2M3S`. Returns null when absent/blank/zero-less. */
function parsePtSeconds(value: string | null | undefined): number | null {
  if (!value) return null;
  const m = /^PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(value.trim());
  if (!m) return null;
  const [, h, min, s] = m;
  if (h === undefined && min === undefined && s === undefined) return null;
  return (Number(h ?? 0) * 3600) + (Number(min ?? 0) * 60) + Number(s ?? 0);
}

/** Nearest `ResponseSignal` ancestor of a node, or null. */
function responseSignalAncestor(node: Element | null): Element | null {
  for (let el = node; el; el = el.parentElement) {
    if (el.localName === 'ResponseSignal') return el;
  }
  return null;
}

/**
 * Parse the raw ESAM SCC XML into a sorted list of ad avails. Empty/whitespace/malformed input yields
 * an empty array (the caller then shows the raw XML only).
 */
export function parseEsamAvails(xml: string | null | undefined): AdAvail[] {
  if (!xml || !xml.trim()) return [];
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(xml, 'application/xml');
  } catch {
    return [];
  }
  // A parse failure surfaces as a <parsererror> element in the returned document.
  if (doc.getElementsByTagName('parsererror').length > 0) return [];

  const descriptors = Array.from(doc.getElementsByTagNameNS('*', 'SegmentationDescriptorInfo'));
  const avails: Omit<AdAvail, 'index'>[] = [];
  for (const desc of descriptors) {
    if (desc.getAttribute('segmentTypeId') !== PPO_START) continue;
    const signal = responseSignalAncestor(desc);
    if (!signal) continue;

    // Start: prefer the NPTPoint@nptPoint child, fall back to ResponseSignal@signalPointID.
    const npt = signal.getElementsByTagNameNS('*', 'NPTPoint')[0]?.getAttribute('nptPoint');
    const start = Number(npt ?? signal.getAttribute('signalPointID'));
    if (!Number.isFinite(start)) continue;

    // Duration: the START descriptor carries it; fall back to a sibling ConditioningInfo whose
    // acquisitionSignalIDRef points back at this signal's acquisitionSignalID.
    let duration = parsePtSeconds(desc.getAttribute('duration'));
    if (duration === null) {
      const acqId = signal.getAttribute('acquisitionSignalID');
      if (acqId) {
        const cond = Array.from(doc.getElementsByTagNameNS('*', 'ConditioningInfo')).find(
          (c) => c.getAttribute('acquisitionSignalIDRef') === acqId,
        );
        duration = parsePtSeconds(cond?.getAttribute('duration'));
      }
    }
    avails.push({ startSeconds: start, durationSeconds: duration });
  }

  return avails
    .sort((a, b) => a.startSeconds - b.startSeconds)
    .map((a, i) => ({ index: i + 1, ...a }));
}

/** Format seconds as `mm:ss`, or `h:mm:ss` at/above one hour. */
export function formatTimecode(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}
