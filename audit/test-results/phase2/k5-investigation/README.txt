Source evidence for docs/reports/K5_WORKER_DISAPPEARANCE_INVESTIGATION.md (first K5 run, 2026-11-22 16:01 IST).
- postgres-server-log-16.00-16.08-IST.txt : embedded PostgreSQL server log lines 16:00-16:08 IST (append-only log of the test server).
  Key line: 16:03:31.84 IST, six simultaneous "could not receive data from client ... forcibly closed" (worker C's sessions).
- kafka-broker-log-k5-group-10.30-10.38-UTC.txt : broker log lines for the k5 consumer group (docker logs aisleforge-kafka-1).
  Key lines: 10:33:25.83 C joins; 10:33:38.09 C removed "on heartbeat expiration".
Worker C's own log file was deleted before its significance was understood (see the report); only excerpts quoted in the report survive.
Windows event logs (Application/System, 16:02:30-16:05 IST) were queried: no node.exe Application Error/WER and no Resource-Exhaustion-Detector events.