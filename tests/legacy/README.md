# Legacy test fixtures

The TypeScript CLI under `cli/` remains an independent test oracle for the Rust
runtime where explicitly referenced by QA scripts. Production builds and
installation use the root Cargo crate. Pi adapters and their legacy fixtures
have been removed; current skill targets are Codex, Claude, and gid.
