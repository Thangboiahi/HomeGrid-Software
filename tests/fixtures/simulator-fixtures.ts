import { getFirebaseAdminFirestore } from "@/infrastructure/firebase/admin";
import { createSimulatedDevice } from "@/services/simulator/operations";
import { assertSimulatorEmulatorsReady } from "@/services/simulator/runtime";

type FixtureInput = { productDefinitionId: string; householdId?: string; installationId?: string };

/** Test-process fixture registry. Cleanup is limited to IDs created through this instance. */
export class SimulatorFixtures {
  private readonly fixtures = new Map<string, string>();

  async create(key: string, input: FixtureInput, sessionCookie: string) {
    await assertSimulatorEmulatorsReady();
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(key)) throw new TypeError("Invalid simulator fixture key.");
    if (this.fixtures.has(key)) throw new TypeError("Simulator fixture key already exists.");
    const device = await createSimulatedDevice(input, sessionCookie);
    this.fixtures.set(key, device.id);
    return device;
  }

  async cleanup(): Promise<void> {
    if (process.env.HOMEGRID_SIMULATOR_TEST_CLEANUP !== "true") {
      throw new Error("Simulator fixture cleanup requires the explicit test cleanup flag.");
    }
    await assertSimulatorEmulatorsReady();
    const db = getFirebaseAdminFirestore();
    for (const deviceId of this.fixtures.values()) {
      const deviceRef = db.collection("devices").doc(deviceId);
      await db.runTransaction(async (transaction) => {
        const [device, audits] = await Promise.all([
          transaction.get(deviceRef),
          transaction.get(db.collection("auditEvents").where("resourceId", "==", deviceId)),
        ]);
        if (device.exists && device.data()?.kind !== "simulated") {
          throw new Error("Refusing to remove a non-simulated fixture record.");
        }
        if (device.exists) transaction.delete(deviceRef);
        for (const audit of audits.docs) transaction.delete(audit.ref);
      });
    }
    this.fixtures.clear();
  }

  get size(): number { return this.fixtures.size; }
}
