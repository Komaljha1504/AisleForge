# Investigation: worker process crashes (D-K5)

## Resolution (2026-11-23): root cause found with a native backtrace, fixed in our code, verified by reproduction

**Status: FIXED (mitigated in our code; the underlying librdkafka defect is not fixed upstream).** The worker
crashed natively in two distinct ways, and both are now avoided:

1. **The main crash.** The worker's status snapshot (every 5 s) read consumer-group offsets with the **Admin**
   client (`admin.fetchOffsets` → librdkafka `ListConsumerGroupOffsets`). gdb on Linux shows the faulting frames on
   the admin client's `rdk:main` thread:

   ```
   #0 rd_kafka_cgrp_op ()                                   ← SIGSEGV
   #1 rd_kafka_handle_OffsetFetch ()
   #2 rd_kafka_ListConsumerGroupOffsetsResponse_parse ()
   #3 rd_kafka_admin_worker ()
   #4 rd_kafka_admin_handle_response ()
   … rd_kafka_q_serve () → rd_kafka_thread_main ()
   ```

   - `rd_kafka_cgrp_op` operates on a client's consumer group, and an Admin client has none.
   - The crash happens only when the offset-fetch response has a coordinator problem. That matches every
     observation:
     - **first start against a fresh cluster:** `__consumer_offsets` is created by the first group;
     - **a broker stall:** the group coordinator is unloaded and reloaded (Windows run 3);
     - **never on a warm broker:** 20 kills on the long-lived Compose broker, every restarted worker on kind.
   - The trigger is an inference from the stack and these conditions. The exact librdkafka error-handling branch
     was not read in the C source.
   - Library versions: `@confluentinc/kafka-javascript` 1.11.0, bundled librdkafka 2.16.0.
   - **Fix:** the worker no longer calls the Admin offset fetch.
     - Committed offsets come from each consumer's own `committed()`, which goes through its consumer group
       (`rd_kafka_committed`). High watermarks come from ListOffsets.
     - Each worker now reports the lag of its own assignment, which also stops multi-worker sums from double-counting.
     - Code: `consumerLag` in `apps/worker/src/kafka/client.ts`.

2. **A secondary crash on exit.** After a designed fail-fast start-up error (`Broker transport failure`, broker not
   listening yet), `main.ts` called `process.exit(1)` with live librdkafka handles.
   - The process logged `process exiting {code: 1}`, then died with SIGSEGV during teardown (exit 139).
   - **Fix:** release the Kafka clients (`worker.stop()`, bounded to 10 s) before exiting.

### Reproduction experiments (Linux containers, `tools/failure/dk5-linux-repro.ts`)

Method:

- Each iteration starts a **fresh** single-node Kafka 4.1.1 broker with no volume, and the real worker image on an
  isolated Docker network.
- The harness acts as a supervisor (restarting the worker on every exit within the window, as Kubernetes and
  Compose do) and records every exit code.

Evidence: `audit/test-results/phase2/k5-investigation/linux-repro-*/` (`result.json` plus the worker log of every
iteration, and the broker log when a crash occurred).

| Run                                     | Worker build            | Worker start        | Iterations with a native crash | SIGSEGV           | Note                                                                                         |
| --------------------------------------- | ----------------------- | ------------------- | ------------------------------ | ----------------- | -------------------------------------------------------------------------------------------- |
| baseline (18:16Z)                       | before fixes            | with the broker     | —                              | —                 | aborted harness design (no supervisor; the worker only failed fast with exit 1) — `NOTE.txt` |
| baseline (18:24Z)                       | before fixes            | with the broker     | **6 / 6**                      | 6                 | 11–22 s after start; restarted workers never crashed                                         |
| delayed20 (07:52Z)                      | —                       | —                   | —                              | —                 | **environment-invalid**: the Docker engine was down after a reboot — `NOTE.txt`              |
| delayed20 (07:54Z)                      | before fixes            | broker ready + 20 s | **4 / 4**                      | 4                 | **falsified** "the broker is still loading" as the trigger                                   |
| gdb (08:05Z)                            | before fixes, under gdb | broker ready        | **2 / 2**                      | 2 (caught by gdb) | backtrace above, identical in both iterations                                                |
| fixed-consumer-committed (15:04Z)       | fix 1 only              | with the broker     | 2 / 6                          | 2                 | both after `process exiting {code: 1}` → found the exit-path crash                           |
| fixed-committed-and-clean-exit (15:19Z) | **fix 1 + fix 2**       | with the broker     | **0 / 6**                      | 0                 | 6 start-up failures, all exited cleanly with code 1                                          |
| fixed-delayed20 (15:30Z)                | **fix 1 + fix 2**       | broker ready + 20 s | **0 / 4**                      | 0                 | no exits at all (old build: 4 / 4)                                                           |

Before the fixes, 12 of 12 valid iterations crashed. After both fixes, none of 10 did. The fixed build is used for every Phase 10 run (Kafka suite, Compose, kind); see
`FINAL_VALIDATION_REPORT.md`.

### What is still open

- The librdkafka defect itself (an Admin `ListConsumerGroupOffsets` response with a coordinator error crashes the
  process) is **not fixed upstream**, as far as a search showed. Any code that calls `admin.fetchOffsets` while
  coordinators move can still hit it.
  - The tests and tools in this repository no longer call it.
  - Reporting it upstream, with this reproducer, is recommended. It was not filed, because publishing needs the
    owner's authorization.
- The Windows crashes (`0xC0000005`) were not re-run with the fix on Windows. The same code path, the same trigger
  conditions and the same symptom make the attribution strong, but it is an inference.

---

The investigation history follows unchanged; its "Status" paragraph is superseded by the resolution above.

## History: investigation report as of 2026-11-22

**Status (updated after official run 3): reproduced with diagnostics. The worker dies of a NATIVE ACCESS VIOLATION
(exit code `0xC0000005`), not a JS error, an explicit exit, the test harness or memory exhaustion.**

- In run 3 it followed a ~20 s broker stall that made librdkafka's consumer session time out and lose every broker
  connection.
- The faulting native module is not proven, because no crash dump was captured. The Kafka client
  (`@confluentinc/kafka-javascript` 1.11.0, librdkafka) is the only native code active in that path, so it is the
  prime suspect.
- Open defect **D-K5**. Data safety is unaffected: the outbox and deduplication were proven across every run. The risk
  is an unsupervised dead worker.
- To be re-verified on Linux containers with a supervisor (Phase 8).

### Run 3 (official, valid environment): the reproduction

| Time (UTC)              | Source         | Observation                                                                                                                                                           |
| ----------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 11:51:48.17             | broker         | C joins the group (1 member) and takes all partitions                                                                                                                 |
| 11:51:49.5 – 11:52:09.5 | broker         | **broker stall**: "Disconnecting from node 1 due to request timeout" (its own KRaft controller heartbeat), "Unable to send a heartbeat because the RPC got timed out" |
| 11:51:55                | sampler        | host free memory 555 MB (run minimum); Kafka container 505 MiB of 900 MiB                                                                                             |
| 11:52:01.64             | C (librdkafka) | `SESSTMOUT` consumer group session timed out (6 s test setting) → revoking assignment                                                                                 |
| 11:52:02.93             | C (librdkafka) | `REQTMOUT` GroupCoordinator request timed out                                                                                                                         |
| 11:52:09.53             | broker         | C "has failed, removing it from the group"; group-coordinator partitions unloaded and reloaded                                                                        |
| 11:52:09.84             | C              | "Error: all broker connections are down"                                                                                                                              |
| 11:52:12.85             | harness        | **C exits with code 3221225477 (`0xC0000005`)**, with no `process exiting` line                                                                                       |

Over the whole session the broker logged its self-heartbeat timeout **17 times**. Workers usually survive these stalls;
in run 3 one did not. The first failure (10:33 UTC) had no stall line in its own window (the nearest was at 10:32), so
its trigger is still unknown, though the symptom matches.

### Mitigations

1. The default consumer session timeout was raised from 10 s to 30 s, so a broker pause of this length no longer
   drops the consumer from its group.
2. The worker runs under a supervisor in every deployment: Compose `restart: unless-stopped` (Phase 8) and the
   Kubernetes Deployment (Phase 9). Restart-and-drain is proven by K5 E1 and E3.
3. Next verification: the K5 scenario against the Linux worker container (the production target), in Phase 8.
4. Not done: capturing a Windows crash dump needs the machine-wide `LocalDumps` registry key (administrator), which
   is outside what this work may change.

---

The original analysis (before run 3) follows.

### What happened

In the first execution of `tests/kafka/k5-worker-crash.test.ts` (run started 16:01:05 IST = 10:31:05 UTC), the E1
experiment did the following:

1. It hard-killed workers A and B.
2. It accepted orders for 30 s.
3. It started a single new worker process, **C**, to drain the backlog.

C started, processed some redelivered events, and then **disappeared about 6 seconds after starting**. Nothing
published the backlog, so the test timed out after 240 s:

- E1 failed.
- I5 failed (outbox rows left unpublished).

The test did not detect C's death at the time. It only waited for the backlog.

### Evidence

Times are in UTC. The embedded PostgreSQL log uses IST (UTC+5:30).

| Time              | Source                                                | Observation                                                                                                                                                            |
| ----------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 10:33:25.78       | C's log (`C-12.log`, excerpt captured in the session) | `worker started`                                                                                                                                                       |
| 10:33:25.83       | Kafka broker log (`docker logs aisleforge-kafka-1`)   | C joins group `…-k5.order-workflow`, becomes leader of generation 12, gets all 3 partitions                                                                            |
| 10:33:27.77–27.90 | C's log                                               | 21 `duplicate delivery skipped` lines (partition 2, offsets 219–239): correct dedupe of events A had applied but not committed                                         |
| 10:33:27.90       | C's log                                               | **last line written**                                                                                                                                                  |
| 10:33:31.84       | PostgreSQL log                                        | 6 sessions end simultaneously: `could not receive data from client: An existing connection was forcibly closed by the remote host`                                     |
| 10:33:38.09       | Kafka broker log                                      | C `has failed, removing it from the group` **on heartbeat expiration** (6 s session timeout). A graceful shutdown sends LeaveGroup instead.                            |
| 10:33–10:37       | Windows Application/System event logs                 | **no** `Application Error` (1000) or WER (1001) entry for `node.exe`; **no** Resource-Exhaustion-Detector event                                                        |
| 16:07:25 IST      | PostgreSQL log                                        | the embedded server's WAL writer exited with code 1 during test teardown. The data directory, then inside the OneDrive-synced workspace, could not be removed (EBUSY). |

Machine state that day:

- Committed memory was 17.5 of 22.7 GB.
- 0.5–0.8 GB physical memory was free before the run.
- A later run with the memory sampler recorded a minimum of 331 MB free.
- No memory sample exists for the failing run itself.

**Evidence lost:** C's complete log file and the first run's JSON evidence were deleted by me when the next run
began (`Remove-Item .tmp\k5-worker-logs`), before their significance was understood. Only the excerpts printed
during the session survive. Re-verification runs now write to separate directories, and the harness never
overwrites evidence.

### Hypotheses

| Hypothesis                                             | For                                                                                                                                                                                                                                                                                                       | Against                                                                                                                                                                                    | Verdict                                                                                                                                                    |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unhandled JS exception or unhandled rejection          | —                                                                                                                                                                                                                                                                                                         | Node prints a stack trace to stderr on an uncaught exception, and none was captured. But see the harness defect below: a late stderr write could have been lost.                           | Possible, not shown                                                                                                                                        |
| Explicit `process.exit` in worker code                 | —                                                                                                                                                                                                                                                                                                         | Every exit path in `main.ts` logged before exiting, and no such line was captured                                                                                                          | Unlikely                                                                                                                                                   |
| Native crash in librdkafka or another native module    | The termination was abrupt (no LeaveGroup, all sockets reset at once). It happened during C's first seconds of producing a large backlog batch while it was group leader.                                                                                                                                 | No WER/Application Error record, although Windows normally records access violations of `node.exe`. 60 later kills and restarts behaved correctly.                                         | Possible, not shown                                                                                                                                        |
| Memory pressure (V8 heap or native allocation failure) | The machine was under heavy memory pressure (≤ 0.8 GB free)                                                                                                                                                                                                                                               | A V8 heap OOM prints `FATAL ERROR … heap out of memory` to stderr (none captured). No Resource-Exhaustion-Detector event. A worker's heap was far below V8's limit (~150 MB RSS observed). | Possible, not shown                                                                                                                                        |
| Test harness or process management killed C            | —                                                                                                                                                                                                                                                                                                         | The harness kills only the worker it tracks under a name, and only A and B (by then other processes) were killed before C started. C was not killed until `afterAll`, 4 minutes later.     | Unlikely                                                                                                                                                   |
| **Harness lost C's final stderr output**               | Real defect: stdout and stderr were both piped into one file stream with `end: true`. Whichever stream ended first closed the file, so a final stack trace or `FATAL ERROR` on stderr could be dropped.                                                                                                   | —                                                                                                                                                                                          | **Confirmed harness defect.** It means the absence of a stack trace is not evidence of a native crash.                                                     |
| **Worker's own last log lines never written**          | Real defect, found by the negative control in the official run: pino's default stdout destination is **asynchronous** (SonicBoom `sync: false`) and flushes in its own exit hook. Lines buffered at the moment of an abrupt termination are lost, and lines logged in a later `exit` handler are dropped. | —                                                                                                                                                                                          | **Confirmed logging defect.** C's last line at 10:33:27.90 is only an upper bound on when it stopped working, and a final fatal line could have been lost. |

**Conclusion.** The worker process was terminated abruptly about 6 s after start. The evidence cannot distinguish
an uncaught JS error whose stderr was lost, a native crash and an allocation failure under memory pressure. No
root cause is claimed.

### What changed

1. **Worker (`apps/worker/src/main.ts`):**
   - The worker now logs **synchronously** (`createLogger(…, { sync: true })`). An earlier draft of this report
     claimed pino was already synchronous. That was wrong, and the negative control caught it: the first official
     run failed because the `process exiting` line was missing.
   - The `exit` and `uncaughtException` handlers are registered first. Every JS-level exit writes a
     `process exiting` or `uncaught exception` line, verified by the negative control: a worker exiting with code 2
     leaves `{"code":2,"message":"process exiting"}`.
   - A future disappearance _without_ that line can only be an external kill or a native or OS-level termination.
2. **Harness (`tests/kafka/k5-worker-crash.test.ts`):**
   - Each worker's file stream now uses `end: false` and is closed on the process `close` event, so no stderr
     output is lost.
   - Every exit is recorded with its code and its hex code (`0xc0000005` would identify an access violation), and
     flagged when the test did not kill that process.
   - Spawned workers run with `--report-on-fatalerror` (a Node diagnostic report on V8 fatal errors).
   - System free memory and the Kafka container's memory are sampled every 5 s.
   - A new test fails if any worker died on its own.
   - The drain wait **fails fast** in two cases, with diagnostics (exits, advisory-lock holder, sessions, worker
     snapshots, backlog):
     - no worker is alive;
     - no progress for 45 s.
   - A **negative control** proves all three detectors work:
     - a self-exiting worker is flagged (exit 2);
     - "no live worker" is detected in 19 ms;
     - a live worker that doesn't consume is reported as stalled in 8.8 s.
3. **Test database:** the embedded PostgreSQL data directory moved out of the OneDrive-synced workspace into
   `%TEMP%`, fixing the EBUSY on teardown.

### Runs after the failure

| Run | When (IST)               | Hard kills | Duplicate deliveries skipped | E1 drain (incl. worker start)             | Unexpected exits                    | Invariants I1–I6 |
| --- | ------------------------ | ---------- | ---------------------------- | ----------------------------------------- | ----------------------------------- | ---------------- |
| 1   | 16:01 (failing run)      | 10         | 26                           | — (never drained)                         | 1 (C, undetected at the time)       | I5 FAIL          |
| 2   | 16:09                    | 10         | 86                           | 10.8 s                                    | not tracked                         | PASS             |
| 3   | 16:13                    | 10         | 1                            | 9.0 s                                     | not tracked                         | PASS             |
| 4   | 16:16                    | 10         | 103                          | 7.0 s                                     | not tracked                         | PASS             |
| 5   | 16:22–16:31              | 10         | 288                          | 29.7 s (machine busy with lint/typecheck) | 0                                   | PASS             |
| 6   | 16:22–16:31              | 10         | 8                            | 8.1 s                                     | 0                                   | PASS             |
| 7   | 16:22–16:31              | 10         | 99                           | 8.8 s                                     | 0                                   | PASS             |
| 8   | 16:36 (hardened harness) | 10         | 1                            | 6.9 s (min. free RAM 331 MB)              | 0 (+1 deliberate, negative control) | PASS             |

Runs 2–8 were development runs with evidence in `.tmp/` (not committed). The official run is recorded in
`audit/test-results/phase2/K5-worker-crash-E3-E1.json`.

### Follow-up (tracked in IMPLEMENTATION_STATUS.md)

- **Phase 6:** run K5-equivalent kill loops against the Linux worker container under Docker Compose with
  `restart: unless-stopped`. Record container exit codes (`docker inspect … State.ExitCode`, `OOMKilled`).
- **Phase 8/9:** orchestrators restart a dead worker (Compose restart policy; Kubernetes restartPolicy). The
  liveness probe covers a hung worker. That limits the impact to a short publish delay, because the outbox keeps
  every event. It doesn't explain the death.
- If a worker ever disappears again, the `process exiting` line and the hex exit code now discriminate between the
  hypotheses.
