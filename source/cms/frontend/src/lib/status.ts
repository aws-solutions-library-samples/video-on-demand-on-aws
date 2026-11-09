/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. Apache-2.0.
 */
import type { StatusIndicatorProps } from '@cloudscape-design/components';

/** Map a workflow status string to a Cloudscape StatusIndicator type. */
export function statusType(status: string | null | undefined): StatusIndicatorProps.Type {
  switch ((status ?? '').toLowerCase()) {
    case 'complete':
      return 'success';
    case 'error':
      return 'error';
    case 'ingest':
    case 'encoding':
      return 'in-progress';
    default:
      return 'pending';
  }
}

/** A failed asset (workflowStatus="Error") is the only state the re-drive accepts. */
export function canRedrive(status: string | null | undefined): boolean {
  return (status ?? '').toLowerCase() === 'error';
}
