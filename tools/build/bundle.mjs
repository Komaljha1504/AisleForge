// Bundles the API, the worker and the DB-init tool into single ESM files for the production images.
// Native modules stay external and are installed in the runtime image: the Kafka client (librdkafka) and argon2.
//   node tools/build/bundle.mjs   → dist/server/{api,worker,init-db}.mjs
import { build } from 'esbuild';

const entries = {
  api: 'apps/api/src/main.ts',
  worker: 'apps/worker/src/main.ts',
  'init-db': 'tools/seed/init-db.ts',
  'load-seed': 'tools/seed/load-seed.ts',
};

await build({
  entryPoints: entries,
  outdir: 'dist/server',
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  legalComments: 'none',
  external: ['@confluentinc/kafka-javascript', '@node-rs/argon2', 'pg-native', 'embedded-postgres'],
  // CommonJS dependencies (pg, pino) call require(); give the ESM bundle a real one.
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
  logLevel: 'info',
});
