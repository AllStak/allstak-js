type TracePropagationTarget = string | RegExp;
interface HttpBodyCaptureOptions {
    enabled?: boolean;
    maxBodySize?: number;
    contentTypes?: string[];
    redactFields?: string[];
}

export type { HttpBodyCaptureOptions as H, TracePropagationTarget as T };
