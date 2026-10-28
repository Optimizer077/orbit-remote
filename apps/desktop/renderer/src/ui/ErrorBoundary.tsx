import { Component, type ErrorInfo, type ReactNode } from 'react';
import './error-boundary.css';

type Props = { children: ReactNode };
type State = { failed: boolean };

// Root error boundary. Without it, one value React cannot draw (for example an object
// where a name belongs) unmounts the whole tree and leaves an empty window.
export class AppErrorBoundary extends Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Orbit could not draw this window.', error, info.componentStack);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="app-error" role="alert" aria-labelledby="app-error-title">
        <div className="app-error-card">
          <h1 id="app-error-title">This window could not be shown</h1>
          <p>Something unexpected stopped Orbit from drawing this window. Your paired computers, settings and the
            background host are not affected. Try again, or reload the window.</p>
          <div className="app-error-actions">
            <button type="button" className="button primary" onClick={() => this.setState({ failed: false })}>Try again</button>
            <button type="button" className="button secondary" onClick={() => window.location.reload()}>Reload window</button>
          </div>
        </div>
      </main>
    );
  }
}
