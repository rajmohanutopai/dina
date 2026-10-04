/**
 * Memory limits every Jest config in the workspace spreads in.
 *
 * Without them Jest starts one worker per core, and a ts-jest worker grows
 * with every file it compiles, so a full `npm test` could take most of a
 * 16 GB machine. Half the cores, and a worker that passes 1 GB is replaced
 * between test files.
 *
 * Override per run: `--maxWorkers=2`, `--workerIdleMemoryLimit=2GB`, or
 * `--runInBand` for a single suite.
 */
module.exports = {
  maxWorkers: '50%',
  workerIdleMemoryLimit: '1GB',
};
