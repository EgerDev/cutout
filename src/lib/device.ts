export type ClientEnv = {
  userAgent: string;
  maxTouchPoints: number;
  pointerCoarse: boolean;
  compactViewport: boolean;
  framed: boolean;
};

export type ClientProfile = {
  ios: boolean;
  android: boolean;
  phone: boolean;
  compact: boolean;
  framed: boolean;
  skipSavePicker: boolean;
  saveViaShare: boolean;
};

export const COMPACT_QUERY = "(max-width: 720px)";

function matchesMedia(query: string) {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  try {
    return window.matchMedia(query).matches;
  } catch {
    return false;
  }
}

export function isIosUserAgent(userAgent: string, maxTouchPoints = 0, pointerCoarse?: boolean) {
  if (/\b(?:iPhone|iPad|iPod)\b/i.test(userAgent)) return true;
  // iPadOS 13+ desktop UA is Macintosh. Mac trackpads can report maxTouchPoints > 1
  // but use a fine pointer — do not treat those as iOS.
  if (!/\bMacintosh\b/i.test(userAgent) || maxTouchPoints <= 1) return false;
  if (pointerCoarse === false) return false;
  return true;
}

export function isAndroidUserAgent(userAgent: string) {
  return /\bAndroid\b/i.test(userAgent);
}

export function isPhoneUserAgent(userAgent: string) {
  if (/\bi(Phone|Pod)\b/i.test(userAgent)) return true;
  if (/\bAndroid\b/i.test(userAgent) && /Mobile/i.test(userAgent)) return true;
  return false;
}

let hostEnv: ClientEnv | null = null;

/** A worker has no window: the page sends its environment, so the iOS and phone
 *  budgets (processingLimits) also hold for work done off the main thread. */
export function adoptHostEnv(env: ClientEnv) {
  hostEnv = env;
}

export function readEnv(): ClientEnv {
  if (typeof window === "undefined" || typeof navigator === "undefined")
    return hostEnv ?? SERVER_ENV;
  return {
    userAgent: navigator.userAgent || "",
    maxTouchPoints: navigator.maxTouchPoints || 0,
    pointerCoarse: matchesMedia("(pointer: coarse)"),
    compactViewport: matchesMedia(COMPACT_QUERY),
    framed: window.parent !== window,
  };
}

export function readClient(env: ClientEnv = readEnv()): ClientProfile {
  const ios = isIosUserAgent(env.userAgent, env.maxTouchPoints, env.pointerCoarse);
  const android = isAndroidUserAgent(env.userAgent);
  const phone = isPhoneUserAgent(env.userAgent);
  const compact = phone || env.compactViewport;
  return {
    ios,
    android,
    phone,
    compact,
    framed: env.framed,
    skipSavePicker: ios || android || compact || env.framed,
    saveViaShare: ios,
  };
}

/** The environment the server renders with; the client's first render must match it. */
export const SERVER_ENV: ClientEnv = {
  userAgent: "",
  maxTouchPoints: 0,
  pointerCoarse: false,
  compactViewport: false,
  framed: false,
};

/**
 * Major Safari/iOS version from the user agent, or 0 when it cannot be read.
 * iPhone and iPod agents carry "OS 17_5"; iPad (desktop-class agent) and Mac
 * carry "Version/17.5". Used only to pick canvas limits, so 0 must mean "old".
 */
export function appleVersion(userAgent: string) {
  const os = /\bOS (\d+)_/.exec(userAgent);
  if (os) return Number(os[1]);
  const version = /\bVersion\/(\d+)/.exec(userAgent);
  return version ? Number(version[1]) : 0;
}
