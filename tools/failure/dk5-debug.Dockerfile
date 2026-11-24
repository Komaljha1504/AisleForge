# D-K5 diagnostics only (never deployed): the worker image plus gdb, so a native crash prints the faulting frames.
#   docker build -f tools/failure/dk5-debug.Dockerfile -t aisleforge/worker:dk5-debug .
#   REPRO_WORKER_IMAGE=aisleforge/worker:dk5-debug REPRO_GDB=1 pnpm tsx tools/failure/dk5-linux-repro.ts 6 60 gdb
FROM aisleforge/worker:dev
USER root
RUN apt-get update && apt-get install -y --no-install-recommends gdb && rm -rf /var/lib/apt/lists/*
USER node
