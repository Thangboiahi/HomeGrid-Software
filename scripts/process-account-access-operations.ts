export {};

const projectId = process.env.FIREBASE_PROJECT_ID ?? "demo-homegrid";
const authHost = process.env.FIREBASE_AUTH_EMULATOR_HOST ?? "127.0.0.1:9099";
const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST ?? "127.0.0.1:8080";

function isLoopbackHost(value: string, port: string): boolean {
  return value === `127.0.0.1:${port}` || value === `localhost:${port}`;
}

if (process.env.NODE_ENV === "production" || projectId !== "demo-homegrid" ||
    (process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID && process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID !== projectId) ||
    !isLoopbackHost(authHost, "9099") || !isLoopbackHost(firestoreHost, "8080")) {
  throw new Error("Account access outbox processing is restricted to the local demo-homegrid Auth and Firestore emulators.");
}

Object.assign(process.env, {
  NODE_ENV: process.env.NODE_ENV ?? "development",
  FIREBASE_PROJECT_ID: projectId,
  NEXT_PUBLIC_FIREBASE_PROJECT_ID: projectId,
  FIREBASE_USE_EMULATORS: "true",
  FIREBASE_AUTH_EMULATOR_HOST: authHost,
  FIRESTORE_EMULATOR_HOST: firestoreHost,
});

async function main() {
  const { processPendingAccountAccessOperations } = await import("@/services/security/account-access-operations");
  const summary = await processPendingAccountAccessOperations();
  console.log(JSON.stringify({ projectId, ...summary }));
  if (summary.status === "failed") process.exitCode = 1;
}

void main().catch((error: unknown) => {
  console.error("Account access outbox processing failed.", error instanceof Error ? error.name : "unknown");
  process.exitCode = 1;
});
