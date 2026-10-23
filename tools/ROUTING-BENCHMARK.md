# Route preview benchmark

This runner began with milestone 1 and now also measures the streamed batch API.
It does not change the application's frontend scheduling.
Node 22 or later and the local Docker stack are required for live runs.
Initial measured findings and the next checkpoint are in `ROUTING-BASELINE.md`.

From this frontend checkout:

```sh
node --test tools/routing-benchmark.test.cjs
node tools/routing-benchmark.cjs --case munich-short --repeats 3
node tools/routing-benchmark.cjs --case munich-ammersee --repeats 3 \
  --concurrency 1,4,8 --container brouter-web-local-brouter-1
```

The fixture contains short and longer Munich-area rides and an alternative-route
case. Distances are measured, not assumed from straight-line distances. Change
the fixture to add the exact slow route observed in the browser. Its default
profile is the sibling backend's `misc/profiles2/trekking.brf`. The benchmark uses
the actual frontend preference generator and override encoder, with forest and
water at 3, cycle-route adherence off, and town avoidance off: 11 scenarios.
Other settings come from that profile. To measure a particular saved profile,
pass `--profile-file /absolute/path/to/profile.brf` (it must support these controls).

Schedules:

-   `single`: only the displayed route.
-   `current`: displayed route, then a duplicate preview baseline, then ten
    variations through a bounded worker pool. This reproduces the current
    dependency chain with an empty browser result cache, excluding UI delays.
-   `overlap`: displayed route and ten variations start together; its totals are
    reused as the baseline. This tests scheduling through the existing API only.
-   `batch`: one streamed request to the opt-in `/brouter/batch` endpoint. Workers
    are server-managed, so its report uses `concurrency:null`. Compare with
    `--modes single,overlap,batch`; configure `batchWorkers` on the backend.
    Preview totals and current geometry are checked against individual requests.

`--concurrency` counts background workers for non-batch schedules; overlap has
one additional foreground request. Node's connection behavior differs from a
browser's. The output separates foreground from full-batch completion and is not
a prediction of browser latency. Totals are checked for every scenario, and
geometry is checked where returned.

One generated profile is uploaded per invocation under a unique benchmark name.
The upload remains in the local custom-profile volume, as normal uploads do.
It neither selects nor overwrites any browser profile. Redirects and remote
targets are rejected, so it cannot accidentally load a public routing service.

Reports default to `../.local/benchmarks/` outside both repositories. Each report
contains the generated profile, its source hash, exact parameters, per-request
timings, geometry hashes, deltas, and partial results if the run fails. Options:
`--output FILE`, `--url http://127.0.0.1:3000`, `--modes single,current,overlap`,
`--profile trekking`, `--label TEXT`, and repeated `--case ID`.

With `--container`, resource readings use Docker's cgroup v2 counters. CPU is
the container CPU-time difference around each schedule. Memory is measured
before and after; the reported peak is explicitly the container's lifetime peak,
not the schedule's peak and not Java live heap. CPU can include health checks
or other concurrent users. Run without interacting with the app for clean data.

For a fresh-JVM comparison, restart only the backend and wait for health before
a separate `--modes single --label fresh-jvm --repeats 3` invocation. The first
route follows profile upload/validation, so it is not a completely untouched JVM.
Restarting does not flush the OS file cache; do not call this a cold-disk test.
Warm runs reuse JVM/JIT and OS state, plus whatever caches the engine retains.
The harness does not artificially flush caches or change production settings.

For CPU/allocation profiling, temporarily start the backend JVM with
`-XX:StartFlightRecording=filename=/tmp/routing-baseline.jfr,settings=profile,duration=180s,dumponexit=true`
in addition to its existing Java options. Run representative routes, then copy
the recording out of the container after recording completes. Restore the normal
configuration afterward. JFR sampling indicates likely hotspots; allocation
samples are not an exact count of bytes allocated. Keep profiling runs separate
from uninstrumented timing comparisons.

Before accepting a speedup, compare repeated warm results, foreground latency,
full-batch latency, CPU time, and memory. Schedule order is fixed in this initial
runner, so repeat invocations with reversed `--modes` and worker order to check
warmup/order effects. Host load, Docker CPU limits, tile versions, and profile
content must match. The first measurements are a baseline, not a speed claim.
