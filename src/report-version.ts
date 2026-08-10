// The report contract version. Closed per version: the outcome vocabulary and attribution
// catalog are stable within a version; new categories require a bump.
//
// The trajectory report contract keeps its ratified lineage identifier `provider-conformance-report/2`
// (the trajectory-aware version 2 of the conformance report family) — the measurement LANGUAGE is
// continuous with Phase II even though this RUNTIME is a separate package. The `REPORT_GENERATOR`
// provenance below records which package actually produced the report.
export const TRAJECTORY_REPORT_VERSION = 'provider-conformance-report/2';
export const REPORT_GENERATOR = '@zioladev/interop-runtime';
export const REPORT_GENERATOR_VERSION = '0.1.0';
