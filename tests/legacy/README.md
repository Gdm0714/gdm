# TypeScript compatibility oracle

This snapshot is test data for the Rust migration. Nothing here is installed,
launched or imported by the production harness. Native compatibility checks use
its independently implemented schemas, hashes and expected behavior.

The former CLI sources in `cli/src` likewise remain a test oracle; production
builds and installation use the root Cargo crate. Pi requires a JavaScript host
adapter; `agents/pi` contains only those adapters and static prompts.
