import {
  AllStak,
  SDK_VERSION
} from "./chunk-PVMCT2AH.mjs";
import {
  __require
} from "./chunk-KENGFPTD.mjs";

// src/integrations/react-native.ts
function instrumentXmlHttpRequest() {
  const flag = "__allstak_xhr_patched__";
  const X = globalThis.XMLHttpRequest;
  if (!X || X.prototype[flag]) return;
  const ownHost = (() => {
    try {
      const cfg = AllStak.getConfig?.();
      return cfg?.dsn?.split("@").pop()?.replace(/\/$/, "") ?? "";
    } catch {
      return "";
    }
  })();
  const origOpen = X.prototype.open;
  const origSend = X.prototype.send;
  X.prototype.open = function(method, url, ...rest) {
    this.__allstak_method__ = method;
    this.__allstak_url__ = url;
    return origOpen.call(this, method, url, ...rest);
  };
  X.prototype.send = function(body) {
    const start = Date.now();
    const method = this.__allstak_method__ || "GET";
    const url = this.__allstak_url__ || "";
    let host = "";
    let path = url;
    try {
      const u = new URL(url);
      host = u.host;
      path = u.pathname;
    } catch {
    }
    const isOwnIngest = ownHost && url.startsWith(ownHost);
    const onDone = (status) => {
      const durationMs = Date.now() - start;
      try {
        AllStak.addBreadcrumb(
          "http",
          `${method} ${path} -> ${status}`,
          status >= 400 ? "error" : "info",
          { method, url: path, statusCode: status, durationMs }
        );
      } catch {
      }
      if (!isOwnIngest) {
        try {
          AllStak.captureRequest({
            direction: "outbound",
            method: method.toUpperCase(),
            host,
            path,
            statusCode: status,
            durationMs
          });
        } catch {
        }
      }
    };
    this.addEventListener?.("load", () => onDone(this.status || 0));
    this.addEventListener?.("error", () => onDone(0));
    this.addEventListener?.("abort", () => onDone(0));
    this.addEventListener?.("timeout", () => onDone(0));
    return origSend.call(this, body);
  };
  X.prototype[flag] = true;
}
async function drainPendingNativeCrashes(release) {
  try {
    const rn = __require("react-native");
    const native = rn?.NativeModules?.AllStakNative;
    if (!native) return;
    if (typeof native.install === "function") {
      try {
        await native.install(release ?? "");
      } catch {
      }
    }
    if (typeof native.drainPendingCrash === "function") {
      const json = await native.drainPendingCrash();
      if (json && json !== "") {
        try {
          const payload = JSON.parse(json);
          const message = payload?.message ?? "Native crash";
          const err = new Error(message);
          err.name = payload?.exceptionClass ?? "NativeCrash";
          err.stack = Array.isArray(payload?.stackTrace) ? payload.stackTrace.join("\n") : String(payload?.stackTrace ?? "");
          AllStak.captureException(err, {
            ...payload?.metadata || {},
            "native.crash": "true"
          });
        } catch {
        }
      }
    }
  } catch {
  }
}
function installReactNative(options = {}) {
  const autoError = options.autoErrorHandler !== false;
  const autoPromise = options.autoPromiseRejections !== false;
  const autoDevice = options.autoDeviceTags !== false;
  const autoAppState = options.autoAppStateBreadcrumbs !== false;
  const autoNetwork = options.autoNetworkCapture !== false;
  AllStak.setTag("platform", "react-native");
  try {
    const hermes = typeof globalThis.HermesInternal !== "undefined";
    let dist;
    try {
      const rn = __require("react-native");
      const os = rn?.Platform?.OS;
      if (os === "ios" || os === "android") {
        dist = `${os}-${hermes ? "hermes" : "jsc"}`;
      }
    } catch {
    }
    AllStak.setIdentity({
      sdkName: "allstak-react-native",
      sdkVersion: SDK_VERSION,
      platform: "react-native",
      dist
    });
  } catch {
  }
  if (autoNetwork) {
    try {
      instrumentXmlHttpRequest();
    } catch {
    }
  }
  if (autoDevice) {
    try {
      const rn = __require("react-native");
      const Platform = rn?.Platform;
      if (Platform) {
        AllStak.setTag("device.os", String(Platform.OS ?? ""));
        AllStak.setTag("device.osVersion", String(Platform.Version ?? ""));
        if (Platform.constants?.Model) {
          AllStak.setTag("device.model", String(Platform.constants.Model));
        }
      }
    } catch {
    }
  }
  if (autoAppState) {
    try {
      const rn = __require("react-native");
      const AppState = rn?.AppState;
      if (AppState && typeof AppState.addEventListener === "function") {
        AppState.addEventListener("change", (next) => {
          try {
            AllStak.addBreadcrumb("navigation", `AppState \u2192 ${next}`, "info", { appState: next });
          } catch {
          }
        });
      }
    } catch {
    }
  }
  if (autoError) {
    const eu = globalThis.ErrorUtils;
    if (eu && typeof eu.setGlobalHandler === "function") {
      const prev = eu.getGlobalHandler();
      eu.setGlobalHandler((error, isFatal) => {
        try {
          AllStak.captureException(error, {
            source: "react-native-ErrorUtils",
            fatal: String(Boolean(isFatal))
          });
        } catch {
        }
        try {
          prev(error, isFatal);
        } catch {
        }
      });
    }
  }
  if (autoPromise) {
    try {
      const tracking = __require("promise/setimmediate/rejection-tracking");
      tracking.enable({
        allRejections: true,
        onUnhandled: (_id, rejection) => {
          const err = rejection instanceof Error ? rejection : new Error(`Unhandled promise rejection: ${String(rejection)}`);
          try {
            AllStak.captureException(err, { source: "unhandledRejection" });
          } catch {
          }
        },
        onHandled: () => {
        }
      });
    } catch {
      if (typeof globalThis.addEventListener === "function") {
        globalThis.addEventListener("unhandledrejection", (ev) => {
          const reason = ev?.reason;
          const err = reason instanceof Error ? reason : new Error(String(reason));
          try {
            AllStak.captureException(err, { source: "unhandledrejection" });
          } catch {
          }
        });
      }
    }
  }
}
export {
  AllStak,
  drainPendingNativeCrashes,
  installReactNative
};
//# sourceMappingURL=react-native.mjs.map