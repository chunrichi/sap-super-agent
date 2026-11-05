// @sap-superagent/testkit — in-memory repositories / fakes / e2e harness.
// Runtime code only depends on protocol + core; server + ai are dev deps used
// by the e2e walking skeleton in `e2e/`.
export * from './checksum.js';
export * from './temp.js';
export * from './http.js';
export * from './fake-executor.js';
export * from './fake-sap.js';
export * from './in-memory-repository.js';
// --- H2: SAP ICF Phase A fake (docs/004 §3.2, handoffs/H2 §1.6) ---
export * from './fake-icf-server.js';
// --- S4: in-process fake external system for the `http` hook target (docs/008) ---
export * from './fake-hook-target.js';
