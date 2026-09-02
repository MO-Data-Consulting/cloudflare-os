import vitestTaskViteConfig, { withTestTimeout } from '../../scripts/vitest-task-vite-config.js'

// Each integration file owns a live Workerd harness. Running those harnesses in parallel can close
// a sibling's main RPC stub on Windows, so keep file execution serial while preserving each file's
// explicit `it.concurrent()` coverage.
const config = vitestTaskViteConfig('vitest run --no-file-parallelism')

export default {
  run: {
    tasks: {
      /** Builds the fixture and orders both validated Workers before test files start. */
      'build:test-gatekeeper': {
        command: withTestTimeout(
          'capnweb-validate build --cwd fixtures/gatekeeper-test --out .wrangler/validate',
        ),
        cache: false,
        dependsOn: ['@gadgets/workshop-backend#build:integration-worker'],
      },
      test: {
        command: config.run.tasks.test.command,
        // Backend source reaches this task through the gitignored validated entrypoint.
        // Running the fast suite is safer than maintaining a second source fingerprint.
        cache: false,
        dependsOn: ['build:test-gatekeeper'],
      },
    },
  },
}
