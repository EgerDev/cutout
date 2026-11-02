import { BenchmarkContractError } from "./contract.mjs";

function responseFields(response) {
  return {
    status: response.status,
    mimeType: response.mimeType || null,
    protocol: response.protocol || null,
    fromDiskCache: Boolean(response.fromDiskCache),
    fromServiceWorker: Boolean(response.fromServiceWorker),
    fromPrefetchCache: Boolean(response.fromPrefetchCache),
  };
}

export function summarizeNetwork(entries) {
  const completed = entries.filter((entry) => entry.terminal === "completed");
  const failed = entries.filter((entry) => entry.terminal === "failed");
  return {
    count: entries.length,
    completedCount: completed.length,
    failedCount: failed.length,
    incompleteCount: entries.length - completed.length - failed.length,
    encodedDataLength: completed.reduce((total, entry) => total + entry.encodedDataLength, 0),
    cache: {
      servedFromCache: entries.filter((entry) => entry.servedFromCache).length,
      fromDiskCache: entries.filter((entry) => entry.fromDiskCache).length,
      fromServiceWorker: entries.filter((entry) => entry.fromServiceWorker).length,
      fromPrefetchCache: entries.filter((entry) => entry.fromPrefetchCache).length,
    },
    entries,
  };
}

function summarizeContext(entries) {
  const completed = entries.filter((entry) => entry.terminal === "completed");
  const failed = entries.filter((entry) => entry.terminal === "failed");
  return {
    count: entries.length,
    completedCount: completed.length,
    failedCount: failed.length,
    incompleteCount: entries.length - completed.length - failed.length,
    fromServiceWorker: entries.filter((entry) => entry.fromServiceWorker).length,
    entries,
  };
}

export function combinedNetworkSummary(pageEntries, contextEntries) {
  const pageTarget = summarizeNetwork(pageEntries);
  const browserContext = summarizeContext(contextEntries);
  const unmatched = [...pageEntries];
  const unmeasuredByPageTarget = contextEntries.filter((entry) => {
    const match = unmatched.findIndex((candidate) => candidate.url === entry.url && candidate.method === entry.method);
    if (match === -1) return true;
    unmatched.splice(match, 1);
    return false;
  });
  return {
    observedRequestCount: contextEntries.length,
    encodedDataLength: pageTarget.encodedDataLength,
    encodedDataLengthScope: "Page-target CDP Network.loadingFinished only",
    completeEncodedCoverage: unmeasuredByPageTarget.length === 0
      && pageTarget.incompleteCount === 0
      && pageTarget.failedCount === 0
      && browserContext.incompleteCount === 0
      && browserContext.failedCount === 0,
    unmeasuredByPageTargetCount: unmeasuredByPageTarget.length,
    unmeasuredByPageTarget,
    workerEncodedDataLength: {
      value: null,
      reason: "Playwright browser-context worker request events do not expose encoded transfer length",
    },
    pageTarget,
    browserContext,
  };
}

export function observeContextNetwork(context, currentFixture) {
  const entries = [];
  const requests = new WeakMap();
  const listeners = {
    request: (request) => {
      const entry = {
        fixtureId: currentFixture(),
        url: request.url(),
        method: request.method(),
        resourceType: request.resourceType(),
        terminal: "pending",
        status: null,
        fromServiceWorker: false,
        failure: null,
      };
      entries.push(entry);
      requests.set(request, entry);
    },
    response: (response) => {
      const entry = requests.get(response.request());
      if (!entry) return;
      entry.status = response.status();
      entry.fromServiceWorker = response.fromServiceWorker();
    },
    requestfinished: (request) => {
      const entry = requests.get(request);
      if (entry) entry.terminal = "completed";
    },
    requestfailed: (request) => {
      const entry = requests.get(request);
      if (!entry) return;
      entry.terminal = "failed";
      entry.failure = request.failure();
    },
  };
  for (const [event, listener] of Object.entries(listeners)) context.on(event, listener);
  return {
    entriesFor(fixtureId) {
      return entries.filter((entry) => entry.fixtureId === fixtureId);
    },
    async waitForSettled(fixtureId, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      while (entries.some((entry) => entry.fixtureId === fixtureId && entry.terminal === "pending")) {
        if (Date.now() >= deadline) throw new BenchmarkContractError(`Browser-context requests for ${fixtureId} did not settle within ${timeoutMs} ms`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    },
    stop() {
      for (const [event, listener] of Object.entries(listeners)) context.removeListener(event, listener);
    },
  };
}

export async function observeNetwork(cdp, currentFixture) {
  const entries = [];
  const active = new Map();
  const listeners = {
    "Network.requestWillBeSent": (event) => {
      const redirected = active.get(event.requestId);
      if (redirected && event.redirectResponse) {
        Object.assign(redirected, responseFields(event.redirectResponse), {
          terminal: "completed",
          encodedDataLength: event.redirectResponse.encodedDataLength ?? 0,
        });
      }
      const entry = {
        requestId: event.requestId,
        fixtureId: currentFixture(),
        url: event.request.url,
        method: event.request.method,
        resourceType: event.type,
        status: null,
        mimeType: null,
        protocol: null,
        terminal: "pending",
        encodedDataLength: null,
        servedFromCache: false,
        fromDiskCache: false,
        fromServiceWorker: false,
        fromPrefetchCache: false,
        failure: null,
      };
      entries.push(entry);
      active.set(event.requestId, entry);
    },
    "Network.responseReceived": (event) => {
      const entry = active.get(event.requestId);
      if (entry) Object.assign(entry, responseFields(event.response));
    },
    "Network.requestServedFromCache": (event) => {
      const entry = active.get(event.requestId);
      if (entry) entry.servedFromCache = true;
    },
    "Network.loadingFinished": (event) => {
      const entry = active.get(event.requestId);
      if (!entry) return;
      entry.terminal = "completed";
      entry.encodedDataLength = event.encodedDataLength;
      active.delete(event.requestId);
    },
    "Network.loadingFailed": (event) => {
      const entry = active.get(event.requestId);
      if (!entry) return;
      entry.terminal = "failed";
      entry.failure = {
        errorText: event.errorText,
        canceled: Boolean(event.canceled),
        blockedReason: event.blockedReason ?? null,
      };
      active.delete(event.requestId);
    },
  };
  for (const [event, listener] of Object.entries(listeners)) cdp.on(event, listener);
  await cdp.send("Network.enable");
  let stopped = false;
  return {
    entriesFor(fixtureId) {
      return entries.filter((entry) => entry.fixtureId === fixtureId);
    },
    async waitForSettled(fixtureId, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      while (entries.some((entry) => entry.fixtureId === fixtureId && entry.terminal === "pending")) {
        if (Date.now() >= deadline)
          throw new BenchmarkContractError(`Network requests for ${fixtureId} did not settle within ${timeoutMs} ms`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      for (const [event, listener] of Object.entries(listeners)) cdp.removeListener(event, listener);
      await cdp.send("Network.disable").catch(() => undefined);
    },
  };
}
