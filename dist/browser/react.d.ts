import * as React from 'react';
export { AllStak } from './index.js';
import './database-C7jn1y4z.js';

/**
 * React integration for AllStak.
 *
 * Exposes:
 *  - <AllStakErrorBoundary /> — catches render/lifecycle errors and reports them
 *    with the React component stack.
 *  - useAllStak() hook — convenience accessors to capture, setUser, setTag.
 *  - withAllStakProfiler — HOC that drops a navigation breadcrumb on mount.
 *
 * This file has a peer dependency on React. It uses only public AllStak APIs,
 * so it can be tree-shaken out of non-React bundles.
 */

interface AllStakErrorBoundaryProps {
    children: React.ReactNode;
    fallback?: React.ReactNode | ((props: {
        error: Error;
        reset: () => void;
    }) => React.ReactNode);
    /** Extra tags attached only to errors captured by this boundary. */
    tags?: Record<string, string>;
    /** Called after the error has been captured. */
    onError?: (error: Error, info: React.ErrorInfo) => void;
}
interface AllStakErrorBoundaryState {
    error: Error | null;
}
declare class AllStakErrorBoundary extends React.Component<AllStakErrorBoundaryProps, AllStakErrorBoundaryState> {
    state: AllStakErrorBoundaryState;
    static getDerivedStateFromError(error: Error): AllStakErrorBoundaryState;
    componentDidCatch(error: Error, info: React.ErrorInfo): void;
    private reset;
    render(): React.ReactNode;
}
/**
 * Convenience hook — exposes the most common capture/context APIs with a
 * stable identity so components don't have to import the namespace.
 */
declare function useAllStak(): {
    captureException: (error: Error, ctx?: Record<string, unknown>) => void;
    captureMessage: (msg: string, level?: "fatal" | "error" | "warning" | "info") => void;
    setUser: (user: {
        id?: string;
        email?: string;
    }) => void;
    setTag: (key: string, value: string) => void;
    addBreadcrumb: (type: string, message: string, level?: string, data?: Record<string, unknown>) => void;
};
/**
 * HOC: drop a navigation breadcrumb when a component mounts. Useful to mark
 * screen boundaries without a router.
 */
declare function withAllStakProfiler<P extends object>(Component: React.ComponentType<P>, name?: string): React.FC<P>;

export { AllStakErrorBoundary, type AllStakErrorBoundaryProps, useAllStak, withAllStakProfiler };
