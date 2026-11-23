import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        // Real PostgreSQL. One server per run (embedded, or TEST_DATABASE_URL); files run serially because they
        // share one database and several tests measure contention/timing.
        test: {
          name: 'db',
          include: [
            'tests/integration/**/*.test.ts',
            'tests/concurrency/**/*.test.ts',
            'tests/security/**/*.test.ts',
          ],
          environment: 'node',
          globalSetup: ['tests/support/global-setup-db.ts'],
          // `fileParallelism` is not a per-project option (typecheck rejects it); a single fork runs files one by one.
          pool: 'forks',
          poolOptions: { forks: { singleFork: true } },
          testTimeout: 180_000,
          hookTimeout: 180_000,
        },
      },
      {
        // Real Kafka broker (docker compose up -d kafka) + real PostgreSQL. Fails (never skips) without a broker.
        test: {
          name: 'kafka',
          include: ['tests/kafka/**/*.test.ts'],
          environment: 'node',
          globalSetup: ['tests/support/global-setup-db.ts', 'tests/support/global-setup-kafka.ts'],
          pool: 'forks',
          poolOptions: { forks: { singleFork: true } },
          testTimeout: 300_000,
          hookTimeout: 180_000,
        },
      },
    ],
  },
});
