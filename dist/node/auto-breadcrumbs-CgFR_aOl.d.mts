type AddBreadcrumbFn = (type: string, msg: string, level?: string, data?: Record<string, unknown>) => void;
interface AutoBreadcrumb {
    type: string;
    message: string;
    level?: string;
    data?: Record<string, unknown>;
}
type BeforeBreadcrumb = (breadcrumb: AutoBreadcrumb) => AutoBreadcrumb | null | undefined;
type TracePropagationTarget = string | RegExp;
interface HttpBodyCaptureOptions {
    enabled?: boolean;
    maxBodySize?: number;
    contentTypes?: string[];
    redactFields?: string[];
}
interface ClickBreadcrumbOptions {
    beforeBreadcrumb?: BeforeBreadcrumb;
    maxSelectorLength?: number;
}
/**
 * Capture privacy-safe click breadcrumbs. The SDK records only a bounded
 * selector summary (tag/id/classes/role/type), never input values or element
 * text. The final breadcrumb is redacted before it reaches the SDK buffer so a
 * custom beforeBreadcrumb hook cannot reintroduce obvious secrets.
 */
declare function instrumentClicks(addBreadcrumb: AddBreadcrumbFn, options?: ClickBreadcrumbOptions): void;
/** @internal - for tests. Resets the click wrap-once flag. */
declare function __resetClickInstrumentationFlagForTest(): void;

export { type AutoBreadcrumb as A, type BeforeBreadcrumb as B, type ClickBreadcrumbOptions as C, type HttpBodyCaptureOptions as H, type TracePropagationTarget as T, __resetClickInstrumentationFlagForTest as _, instrumentClicks as i };
