import React from 'react';

export interface WorkspaceErrorBoundaryProps {
  /** Human label for the workspace (e.g. "Shots"). */
  workspaceName: string;
  /** Called when the user chooses Return to Build (or primary recovery). */
  onReturnHome?: () => void;
  children: React.ReactNode;
}

interface WorkspaceErrorBoundaryState {
  error: Error | null;
}

/**
 * Surfaces lazy-workspace chunk / module evaluation failures instead of
 * leaving Suspense stuck on “Loading workspace…”.
 */
export class WorkspaceErrorBoundary extends React.Component<
  WorkspaceErrorBoundaryProps,
  WorkspaceErrorBoundaryState
> {
  constructor(props: WorkspaceErrorBoundaryProps) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): WorkspaceErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }): void {
    console.error(
      `[WorkspaceErrorBoundary] ${this.props.workspaceName} failed to load`,
      error,
      info.componentStack,
    );
  }

  handleRetry = (): void => {
    this.setState({ error: null });
  };

  handleReturnHome = (): void => {
    this.setState({ error: null });
    this.props.onReturnHome?.();
  };

  render(): React.ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    const { workspaceName, onReturnHome } = this.props;
    return (
      <div
        className="flex h-full flex-col items-center justify-center gap-4 bg-surface-base px-6 text-center"
        data-workspace-error={workspaceName.toLowerCase()}
        role="alert"
      >
        <div className="max-w-md space-y-2">
          <h2 className="text-lg font-semibold text-primary">
            {workspaceName} could not load in this browser.
          </h2>
          <p className="text-sm text-secondary">
            {error.message || 'An unexpected error occurred while loading this workspace.'}
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-center gap-2">
          <button
            type="button"
            onClick={this.handleRetry}
            className="rounded-xl border border-subtle bg-surface-raised px-4 py-2 text-sm font-medium text-primary transition hover:bg-surface-overlay"
            data-workspace-error-retry
          >
            Retry
          </button>
          {onReturnHome ? (
            <button
              type="button"
              onClick={this.handleReturnHome}
              className="rounded-xl border border-transparent bg-accent px-4 py-2 text-sm font-medium text-white transition hover:opacity-90"
              data-workspace-error-home
            >
              Return to Build
            </button>
          ) : null}
        </div>
      </div>
    );
  }
}
