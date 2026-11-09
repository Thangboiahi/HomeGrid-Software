export type SimulatorEnvironment = {
  projectId: string;
  authHost: string;
  authPort: number;
  firestoreHost: string;
  firestorePort: number;
};

type Environment = Record<string, string | undefined>;

const EXPECTED_AUTH_PORT = 9099;
const EXPECTED_FIRESTORE_PORT = 8080;

/** Returns configuration only when every Firebase endpoint is an explicit local demo emulator. */
export function getSimulatorEnvironment(environment: Environment = process.env): SimulatorEnvironment | undefined {
  if (environment.NODE_ENV === "production" || environment.FIREBASE_USE_EMULATORS !== "true" ||
      environment.NEXT_PUBLIC_FIREBASE_USE_EMULATORS !== "true") return undefined;

  const projectId = environment.FIREBASE_PROJECT_ID;
  if (!projectId?.startsWith("demo-") || environment.NEXT_PUBLIC_FIREBASE_PROJECT_ID !== projectId) return undefined;

  const auth = parseHostPort(environment.FIREBASE_AUTH_EMULATOR_HOST);
  const firestore = parseHostPort(environment.FIRESTORE_EMULATOR_HOST);
  const publicFirestorePort = Number(environment.NEXT_PUBLIC_FIRESTORE_EMULATOR_PORT);
  let publicAuth: URL;
  try {
    publicAuth = new URL(environment.NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_URL ?? "");
  } catch {
    return undefined;
  }

  const publicFirestoreHost = environment.NEXT_PUBLIC_FIRESTORE_EMULATOR_HOST;
  const publicAuthPort = Number(publicAuth.port || (publicAuth.protocol === "https:" ? 443 : 80));
  if (publicAuth.protocol !== "http:" || publicAuth.pathname !== "/" || publicAuth.username || publicAuth.password || publicAuth.search || publicAuth.hash ||
      !auth || !firestore || !isLoopback(auth.host) || !isLoopback(firestore.host) ||
      !isLoopback(publicAuth.hostname) || !publicFirestoreHost || !isLoopback(publicFirestoreHost) ||
      auth.port !== EXPECTED_AUTH_PORT || publicAuthPort !== auth.port ||
      !isLoopbackHostEqual(publicAuth.hostname, auth.host) ||
      firestore.port !== EXPECTED_FIRESTORE_PORT || publicFirestorePort !== firestore.port ||
      !isLoopbackHostEqual(publicFirestoreHost, firestore.host)) return undefined;

  return {
    projectId,
    authHost: auth.host,
    authPort: auth.port,
    firestoreHost: firestore.host,
    firestorePort: firestore.port,
  };
}

function parseHostPort(value: string | undefined): { host: string; port: number } | undefined {
  if (!value) return undefined;
  const match = value.match(/^([^:\[\]]+|\[[0-9a-fA-F:]+\]):(\d{1,5})$/);
  if (!match) return undefined;
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined;
  return { host: match[1].replace(/^\[|\]$/g, ""), port };
}

function isLoopback(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

function isLoopbackHostEqual(left: string, right: string): boolean {
  const normalized = (host: string) => host === "localhost" ? "127.0.0.1" : host.replace(/^\[|\]$/g, "");
  return normalized(left) === normalized(right);
}
