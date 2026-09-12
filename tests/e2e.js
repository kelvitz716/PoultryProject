#!/usr/bin/env node
'use strict';

// Compatibility entry point. The former suite could target an arbitrary URL
// and mutate its data. Batch 18A replaces it with an isolated copied-app run.
require('./playwright/batch18a').main().catch(error => {
  process.stderr.write(`Isolated E2E harness failed: ${error.message}\n`);
  process.exitCode = 1;
});
