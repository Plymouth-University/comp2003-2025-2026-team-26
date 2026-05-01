const PAGE_GUARD_PROMISE_KEY = "__friaryPageGuardPromise";

export function setPageGuardPromise(promise) {
  const nextPromise = Promise.resolve(promise);
  if (typeof window !== "undefined") {
    window[PAGE_GUARD_PROMISE_KEY] = nextPromise;
  }
  return nextPromise;
}

export function waitForPageGuard() {
  if (typeof window === "undefined") return Promise.resolve(null);
  return window[PAGE_GUARD_PROMISE_KEY] || Promise.resolve(null);
}
