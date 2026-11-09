# Firmware/Software Integration Readiness Matrix

**Review date:** 2026-11-08  
**Evidence:** HomeGrid Software SW-01.4 through SW-01.6B records; HomeGrid Firmware `main` reports and GitHub PR/check metadata. See [SW-01.6C readiness report](../milestone-reports/SW-01.6C-integration-readiness.md) for qualifications and links.

## Status key

- **Verified, scoped:** implemented and evidenced within the stated host/mock or software boundary.
- **Approved, not implemented:** a decision exists, but the production integration does not.
- **Proposed:** documented as a design or planning proposal; not an approved shared contract.
- **Undefined:** an authoritative decision or contract is still required.

FW-02A–FW-02F is accepted and merged to Firmware `main` by PR #7. FW-02 is host/mock-only. Firmware's current FW-03 planning handover records additional hardware/interface proposals and open cross-department dependencies; those proposals do not authorize physical or communications integration.

| Integration area | Firmware status | Software status | Approved shared contract available? | Next dependency |
|---|---|---|---|---|
| Physical device identity | FW-02 uses an opaque identity boundary only; no physical format is implemented. FW-03 planning has not approved an identity scheme. | Firestore-generated `devices/{id}` is a software record ID only; no physical identity/provisioning fields exist. | No | HQ/Architecture defines identity, uniqueness, lifecycle and mapping; Hardware evidence may be required. |
| Device provisioning | Not implemented. | Not implemented. | No | HQ/Security approves provisioning flow, credentials, recovery and ownership. |
| Device authentication | Not implemented. User Firebase authentication is for people using the app, not devices. | No device credentials or device-auth API. | No | HQ/Security approves device trust and key lifecycle; Software defines the server boundary. |
| Network connectivity | No Wi-Fi/BLE/network stack in FW-02. | No device transport/connectivity service. | No | HQ approval plus network/security requirements and later firmware authorization. |
| MQTT or other transport | No transport implementation; firmware command port is abstract. | No broker client, listener, topic handling or device transport. | No | Software/HQ selects and approves a versioned transport contract; FW-02 does not establish MQTT topics. |
| Message/payload schemas | FW-02 has transport-neutral internal command types only. | No firmware message schemas or device API routes. | No | Software/HQ approves versioned schemas and compatibility rules. |
| Device telemetry | FW-02 has local bounded diagnostic events/counters only; no export. | No telemetry ingestion. Existing diagnostics APIs read platform records; they are not a device telemetry receiver. | No | Software/HQ defines telemetry/diagnostic export, privacy and transport contracts. |
| Appliance commands | Firmware domain validates a command behind an explicit policy seam; output permission is permanently denied. There is no network input. | No appliance command endpoint, message handling or device-command permission. | No | HQ/Product defines authority and arbitration; Software/HQ defines the command contract; separate security review/authorization. |
| Relay/fan control | Mock actuator only. No physical GPIO, relay/fan actuation or mains/load testing. | No appliance/relay/fan control or appliance-state write API. | No | Hardware evidence and safety review, HQ authorization, and a separately approved architecture. |
| Device acknowledgement | Mock outcomes exist for host tests, not as a wire acknowledgement. | No device acknowledgement receiver or schema. | No | Software/HQ defines acknowledgement, ordering, timeout and error semantics. |
| Fault reporting | FW-02 has bounded local diagnostic/fault state; no external reporting. FW-03 proposes requirements, not a shared schema. | No firmware fault/telemetry ingestion. | No | Software/HQ defines export schema and security/privacy requirements. |
| Firmware version reporting | No device-to-cloud firmware-version report. | `firmwareReleases` APIs manage product/version-label metadata only; they do not report the installed version. | No | Software/HQ defines authenticated device version reporting and its identity binding. |
| OTA/update mechanism | Not implemented. | No firmware artifact delivery, signature verification, deployment or OTA endpoints. | No | HQ approves authenticity, rollout, rollback and recovery policy before separate work. |
| Device lifecycle | FW-02 switch runtime states are internal operational state, not registry lifecycle. FW-03 does not establish a shared device lifecycle. | Registry states are `unassigned`, `assigned`, `retired`; lifecycle mutation remains unavailable while transition policy is deferred. | No | HQ/Architecture approves lifecycle vocabulary/transitions and firmware mapping. |

## Related software-only boundaries

- Customer reads are household-membership scoped; Installer reads are scoped to assigned installations; Super Admin registry access is permission checked and platform scoped.
- Super Admin has no appliance operation, device command, appliance state write or household automation write capability.
- The local simulator is restricted to matching `demo-*` Auth/Firestore emulators and loopback endpoints. It models registry records and associations only.
- Firebase client Firestore rules deny all reads and writes. Trusted server services use the Admin SDK and perform authorization and scope checks.
- Product association and `firmwareReleases` metadata must not be represented as device provisioning or deployed firmware state.
