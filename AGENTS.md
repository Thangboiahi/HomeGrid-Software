# HomeGrid engineering rules

1. HomeGrid uses one application with three roles.
2. Authentication and authorisation must be enforced server-side.
3. The client must never determine its own authoritative role or permissions.
4. Customer resources must be protected by ownership and household membership.
5. Installer resources must be protected by assigned installation scope.
6. Super Admin manages the HomeGrid platform, not customer appliances.
7. Super Admin must never receive appliance-control or household-automation-write capabilities.
8. Device communication contracts must be approved through HomeGrid HQ.
9. Never invent MQTT topics, payloads, firmware APIs, device commands or telemetry schemas.
10. Simulated devices must be distinguishable from physical devices.
11. Never commit secrets, private keys or service-account credentials.
12. All security-sensitive operations require appropriate audit logging.
13. Do not modify approved architecture without documenting the proposed change.

These rules apply to all application code, documentation, configuration and future services in this repository.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
