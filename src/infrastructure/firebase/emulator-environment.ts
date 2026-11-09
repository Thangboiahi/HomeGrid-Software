export type EmulatorEnvironment = {
  enabled: boolean;
  production: boolean;
  authHost?: string;
  firestoreHost?: string;
};

/** Reject mixed or production emulator configuration before any SDK is created. */
export function assertEmulatorEnvironment({
  enabled,
  production,
  authHost,
  firestoreHost,
}: EmulatorEnvironment): boolean {
  const hasEmulatorHosts = Boolean(authHost || firestoreHost);

  if (production && (enabled || hasEmulatorHosts)) {
    throw new Error("Firebase emulators must never be enabled in production.");
  }

  if (!enabled && hasEmulatorHosts) {
    throw new Error("Firebase emulator hosts are set while emulator mode is disabled.");
  }

  if (enabled && (!authHost || !firestoreHost)) {
    throw new Error("Both Firebase Auth and Firestore emulator hosts are required.");
  }

  return enabled;
}
