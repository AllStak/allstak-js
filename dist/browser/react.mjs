import {
  AllStak
} from "./chunk-ULJA5QL6.mjs";
import "./chunk-KENGFPTD.mjs";

// src/integrations/react.tsx
import * as React from "react";
var AllStakErrorBoundary = class extends React.Component {
  constructor() {
    super(...arguments);
    this.state = { error: null };
    this.reset = () => this.setState({ error: null });
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    try {
      AllStak.addBreadcrumb("ui", "React error boundary caught error", "error", {
        componentStack: info.componentStack ?? ""
      });
      const context = {
        componentStack: info.componentStack ?? "",
        source: "react-error-boundary"
      };
      if (this.props.tags) {
        for (const [k, v] of Object.entries(this.props.tags)) {
          context[`tag.${k}`] = v;
        }
      }
      AllStak.captureException(error, context);
    } catch {
    }
    try {
      this.props.onError?.(error, info);
    } catch {
    }
  }
  render() {
    if (this.state.error) {
      const { fallback } = this.props;
      if (typeof fallback === "function") {
        return fallback({ error: this.state.error, reset: this.reset });
      }
      if (fallback !== void 0) return fallback;
      return null;
    }
    return this.props.children;
  }
};
function useAllStak() {
  return React.useMemo(
    () => ({
      captureException: (error, ctx) => AllStak.captureException(error, ctx),
      captureMessage: (msg, level = "info") => AllStak.captureMessage(msg, level),
      setUser: (user) => AllStak.setUser(user),
      setTag: (key, value) => AllStak.setTag(key, value),
      addBreadcrumb: (type, message, level, data) => AllStak.addBreadcrumb(type, message, level, data)
    }),
    []
  );
}
function withAllStakProfiler(Component2, name) {
  const displayName = name ?? Component2.displayName ?? Component2.name ?? "AnonymousComponent";
  const Wrapped = (props) => {
    React.useEffect(() => {
      AllStak.addBreadcrumb("navigation", `Mounted <${displayName}>`, "info");
    }, []);
    return React.createElement(Component2, props);
  };
  Wrapped.displayName = `withAllStakProfiler(${displayName})`;
  return Wrapped;
}
export {
  AllStak,
  AllStakErrorBoundary,
  useAllStak,
  withAllStakProfiler
};
//# sourceMappingURL=react.mjs.map