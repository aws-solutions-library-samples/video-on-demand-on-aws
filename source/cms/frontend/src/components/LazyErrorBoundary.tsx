/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. Apache-2.0.
 *
 * Error boundary for lazily loaded UI (code-split chunks). Without one, a chunk that fails to load
 * (typically a tab left open across a CMS redeploy, see lib/staleBuild.ts) or throws while rendering
 * unmounts the whole React tree and the page goes blank. This contains the failure to the one section
 * and tells the operator how to recover.
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { StatusIndicator } from '@cloudscape-design/components';

interface Props {
  /** What failed, for the message (e.g. "the quality-metrics chart"). */
  what: string;
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export default class LazyErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`Failed to render ${this.props.what}`, error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <StatusIndicator type="warning">
          Couldn&apos;t load {this.props.what}. The CMS may have been updated since this page was opened - reload the
          page to continue.
        </StatusIndicator>
      );
    }
    return this.props.children;
  }
}
