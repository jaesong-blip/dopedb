// Shared render isolation for optional rich surfaces. It deliberately keeps
// error details out of the UI; diagnostics can attach an explicit observer later.
import {
  Component,
  type ReactNode,
} from "react";

type RenderRecoveryBoundaryProps = {
  children: ReactNode;
  fallback: (controls: { retry: () => void }) => ReactNode;
  resetKeys?: readonly unknown[];
};

type RenderRecoveryBoundaryState = {
  failed: boolean;
};

export default class RenderRecoveryBoundary extends Component<
  RenderRecoveryBoundaryProps,
  RenderRecoveryBoundaryState
> {
  state: RenderRecoveryBoundaryState = { failed: false };

  static getDerivedStateFromError(): RenderRecoveryBoundaryState {
    return { failed: true };
  }

  componentDidUpdate(previous: RenderRecoveryBoundaryProps) {
    if (
      this.state.failed &&
      resetKeysChanged(previous.resetKeys, this.props.resetKeys)
    ) {
      this.setState({ failed: false });
    }
  }

  private retry = () => {
    this.setState({ failed: false });
  };

  render() {
    if (this.state.failed) {
      return this.props.fallback({ retry: this.retry });
    }
    return this.props.children;
  }
}

function resetKeysChanged(
  previous: readonly unknown[] | undefined,
  next: readonly unknown[] | undefined,
) {
  if (previous === next) return false;
  if (!previous || !next || previous.length !== next.length) return true;
  return previous.some((value, index) => !Object.is(value, next[index]));
}
