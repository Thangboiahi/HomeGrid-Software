export {};

const projectId = process.env.FIREBASE_PROJECT_ID ?? "demo-homegrid";
const authHost = process.env.FIREBASE_AUTH_EMULATOR_HOST ?? "127.0.0.1:9099";
const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST ?? "127.0.0.1:8080";
const loopback = (host: string, port: string) => host === `127.0.0.1:${port}` || host === `localhost:${port}`;
if (process.env.NODE_ENV === "production" || projectId !== "demo-homegrid" ||
    (process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID && process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID !== projectId) ||
    !loopback(authHost, "9099") || !loopback(firestoreHost, "8080")) {
  throw new Error("Outbox worker is restricted to the local demo-homegrid Auth and Firestore emulators.");
}
Object.assign(process.env, { NODE_ENV: process.env.NODE_ENV ?? "development", FIREBASE_PROJECT_ID: projectId, NEXT_PUBLIC_FIREBASE_PROJECT_ID: projectId, FIREBASE_USE_EMULATORS: "true", FIREBASE_AUTH_EMULATOR_HOST: authHost, FIRESTORE_EMULATOR_HOST: firestoreHost });

async function main() {
  const [{ processPendingAccountAccessOperations }, { processPendingSessionSignOutOperations }, { runOutboxDomains }] = await Promise.all([
    import("@/services/security/account-access-operations"),
    import("@/services/auth/session-signout-operations"),
    import("@/services/security/outbox-domain-runner"),
  ]);
  const results = await runOutboxDomains({ accountAccess: processPendingAccountAccessOperations, sessionSignOut: processPendingSessionSignOutOperations });
  console.log(JSON.stringify({ projectId, accountAccess: results.accountAccess, sessionSignOut: results.sessionSignOut }));
  if (results.accountAccess.status === "rejected" || results.sessionSignOut.status === "rejected" ||
      results.accountAccess.value.status === "failed" || results.sessionSignOut.value.status === "failed") process.exitCode = 1;
}
void main().catch((error: unknown) => { console.error("Outbox worker failed.", error instanceof Error ? error.name : "unknown"); process.exitCode = 1; });
