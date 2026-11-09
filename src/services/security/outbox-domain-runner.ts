import "server-only";

/** Runs each domain independently and preserves a failure from either side as its own result. */
export async function runOutboxDomains<T>(processors: {
  accountAccess: () => Promise<T>;
  sessionSignOut: () => Promise<T>;
}) {
  const [accountAccess, sessionSignOut] = await Promise.allSettled([
    processors.accountAccess(),
    processors.sessionSignOut(),
  ]);
  return { accountAccess, sessionSignOut };
}
