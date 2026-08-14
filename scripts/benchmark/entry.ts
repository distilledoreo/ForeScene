// Preserve the generic V3 fixture interface for existing reliability tests.
// The ordinary path (no legacy --spec/--skip-live flags) is the frozen V3-Lite
// contract and never enters the lifecycle runner.
const argv = process.argv.slice(2);
const legacy = argv.includes('--spec') || argv.includes('--skip-live') || argv.includes('--skip-candidate');
const code = legacy
  ? await (await import('./run')).main(argv)
  : await (await import('./v3LiteRun')).main(argv);
process.exitCode = code;
