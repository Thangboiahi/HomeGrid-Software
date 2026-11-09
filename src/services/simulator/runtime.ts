import "server-only";

import { createConnection } from "node:net";
import { getSimulatorEnvironment, type SimulatorEnvironment } from "@/domain/simulator/configuration";

export class SimulatorUnavailableError extends Error {
  constructor(readonly status: 404 | 503, message: string) {
    super(message);
    this.name = "SimulatorUnavailableError";
  }
}

/** Simulator operations are unavailable unless both Firebase services are local demo emulators. */
export function requireSimulatorConfiguration(): SimulatorEnvironment {
  const environment = getSimulatorEnvironment();
  if (!environment) throw new SimulatorUnavailableError(404, "Simulator is unavailable in this environment.");
  return environment;
}

/** Checks both local emulator sockets before any simulator service touches Firebase. */
export async function assertSimulatorEmulatorsReady(): Promise<SimulatorEnvironment> {
  const environment = requireSimulatorConfiguration();
  try {
    await Promise.all([
      assertTcpEndpoint(environment.authHost, environment.authPort),
      assertTcpEndpoint(environment.firestoreHost, environment.firestorePort),
    ]);
  } catch {
    throw new SimulatorUnavailableError(503, "Start the local Auth and Firestore emulators before using the simulator.");
  }
  return environment;
}

function assertTcpEndpoint(host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host, port });
    const timer = setTimeout(() => socket.destroy(new Error("Emulator connection timed out.")), 1500);
    const finish = (error?: Error) => {
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.destroy();
      if (error) reject(error);
      else resolve();
    };
    socket.once("connect", () => finish());
    socket.once("error", finish);
    socket.once("timeout", () => finish(new Error("Emulator connection timed out.")));
  });
}
