/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. Apache-2.0.
 */
import { StatusIndicator, type StatusIndicatorProps } from '@cloudscape-design/components';

function typeFor(status: string): StatusIndicatorProps.Type {
  const s = status.toLowerCase();
  if (s.includes('playing')) return 'success';
  if (s.includes('error') || s.includes('missing') || s.includes('cannot') || /http (4|5)\d\d/.test(s)) return 'error';
  if (s.includes('loading')) return 'loading';
  if (s.includes('native') || s.includes('needs') || s.includes('not ')) return 'warning';
  return 'info';
}

export default function PlayerStatus({ status }: { status: string }) {
  return <StatusIndicator type={typeFor(status)}>{status}</StatusIndicator>;
}
