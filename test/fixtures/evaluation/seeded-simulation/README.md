# Deterministic queue simulation fixture

Node 20+, no dependencies. This bounded simulator uses a seed-offset periodic arrival schedule, not a statistical PRNG.

```sh
npm test
```

Seed 7 and four ticks produce arrivals 3,1,3,2. Baseline admits all arrivals; the Objective adds capacity.
No wall clock, host telemetry, or real queue is used or claimed.
