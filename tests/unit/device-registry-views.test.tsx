import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CustomerDeviceRegistry, InstallerDeviceRegistry, SuperAdminDeviceRegistry } from "@/features/device-registry/device-registry-views";
import { DeviceSimulatorConsole } from "@/features/device-simulator/device-simulator-console";

test("customer and installer registry views expose read-only role-specific content", () => {
  const customer = renderToStaticMarkup(createElement(CustomerDeviceRegistry));
  const installer = renderToStaticMarkup(createElement(InstallerDeviceRegistry));

  assert.match(customer, /Devices in your home/);
  assert.match(customer, /Your households/);
  assert.match(customer, /Loading household devices/);
  assert.doesNotMatch(customer, /Register a device record|Save associations|Update product/);
  assert.match(installer, /Devices in your assigned work/);
  assert.match(installer, /Assigned installations/);
  assert.match(installer, /Loading assigned devices/);
  assert.doesNotMatch(installer, /Register a device record|Save associations|Update product/);
});

test("Super Admin registry view exposes platform registry controls without lifecycle or device-control actions", () => {
  const admin = renderToStaticMarkup(createElement(SuperAdminDeviceRegistry));

  assert.match(admin, /Register a device record/);
  assert.match(admin, /Search IDs and associations/);
  assert.match(admin, /Loading device registry/);
  assert.doesNotMatch(admin, /Retire|Reactivate|Turn on|Turn off|MQTT|OTA|Firmware/);
});

test("simulator view is clearly simulated and exposes only registry workflow controls", () => {
  const simulator = renderToStaticMarkup(createElement(DeviceSimulatorConsole));

  assert.match(simulator, /Local emulator only/);
  assert.match(simulator, /Create simulated device/);
  assert.match(simulator, /Loading simulator records/);
  assert.match(simulator, /does not represent connectivity, telemetry, appliance state, or device control/);
  assert.doesNotMatch(simulator, /Relay|Fan speed|Online|Offline|MQTT|OTA|Firmware|Turn on|Turn off/);
});
