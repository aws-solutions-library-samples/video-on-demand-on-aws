/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. Apache-2.0.
 *
 * Manual quality-level (rendition) selector shared by the CMS players. Native <video controls> only
 * exposes ABR auto; this dropdown lets an operator pin a specific ladder rung (or return to Auto).
 * Purely presentational — each player owns the hls.js / dash.js wiring.
 */
import { FormField, Select, type SelectProps } from '@cloudscape-design/components';

export interface QualityLevel {
  height?: number;
  bitrate?: number; // bits per second
}

interface Props {
  levels: QualityLevel[];
  /** -1 = Auto (ABR), otherwise the level index. */
  value: number;
  /** When on Auto, the level index ABR is currently playing (to annotate "Auto (720p)"). */
  activeAuto?: number;
  onChange: (index: number) => void;
}

/** "720p" when height is known, else "2.5 Mbps", else "Level N". */
function labelFor(level: QualityLevel, index: number): string {
  if (level.height) return `${level.height}p`;
  if (level.bitrate) return `${(level.bitrate / 1_000_000).toFixed(1)} Mbps`;
  return `Level ${index + 1}`;
}

export default function QualitySelector({ levels, value, activeAuto, onChange }: Props) {
  const autoLabel =
    activeAuto != null && activeAuto >= 0 && levels[activeAuto]
      ? `Auto (${labelFor(levels[activeAuto], activeAuto)})`
      : 'Auto';

  // Highest rendition first so the menu reads top-down like a typical quality picker.
  const options: SelectProps.Option[] = [
    { label: autoLabel, value: '-1' },
    ...levels
      .map((l, i) => ({ label: labelFor(l, i), value: String(i) }))
      .sort((a, b) => Number(b.value) - Number(a.value)),
  ];
  const selected = options.find((o) => o.value === String(value)) ?? options[0];

  return (
    <FormField label="Quality">
      <Select
        selectedOption={selected}
        options={options}
        onChange={({ detail }) => onChange(Number(detail.selectedOption.value))}
        expandToViewport
      />
    </FormField>
  );
}
