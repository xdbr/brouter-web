# Batch routing baseline — 23 October 2026

Milestone 1 is complete: a repeatable HTTP benchmark, correctness checks, a
fresh-JVM comparison, and a separate JVM execution/allocation recording.
The running application's scheduling and routing algorithms are unchanged.

## Workload and environment

The benchmark uses the production preference generator with trekking, forest
and water preference 3, cycle-route adherence off, and town avoidance off. It
calculates the current scenario and ten single-setting variations. Other
settings retain the profile defaults. The routes are representative fixtures,
not a reproduction of the user's exact saved profile and 50 km ride.

-   Southern Munich: current route 11.9 km.
-   Munich–Herrsching: current route 42.4 km.
-   Same endpoints, alternative index 1: current route 41.3 km.

Host: Apple M2 Max, 12 logical CPUs; Node 26.12.0; Docker Java 17.0.20.1;
16 GiB maximum heap; 40 backend request threads; routing memory class 256.
Docker may provide fewer effective CPUs than the host; these results do not
establish performance on another machine. Unrelated containers were also running.
The image was `sha256:c363ebfe46139ed32a0e9ab69a2e0a985fc66b83ba1f1ab5a4d4aa274d71efa5`.

Frontend reference: `c0e534637e855e928675d398daf815108df1fd03`.
Backend reference: `f0d434effad4f878ade21a1271fc3f0a7601475b`.
Source trekking SHA-256:
`caa6294eee4b292cfbece3da509bcc5ac62552206b85af7fb1091a774fbcdaa1`.
Exact inputs, generated profile, and per-request geometry hashes are in the raw
reports under the workspace's `.local/benchmarks/` directory, outside Git.

## Uninstrumented timings

63 schedules, 630 routing requests. Each combination has three repetitions.
The following are medians, using eight background workers. The overlap schedule
also has one foreground request. Browser connection limits do not apply to this
Node runner; timings include response transfer/parsing but exclude UI debounce,
polling, and profile upload. The browser's existing preview-result cache is bypassed.

-   11.9 km: current sequence completes in 1.015 s; overlap in 0.525 s.
    Foreground completion changes from 0.264 s to 0.299 s.
-   42.4 km: current sequence completes in 6.475 s; overlap in 3.519 s.
    Foreground completion changes from 1.643 s to 1.986 s.
-   41.3 km alternative: current sequence completes in 12.947 s; overlap in
    6.681 s. Foreground completion changes from 3.188 s to 3.749 s.

Overlap removes the duplicate baseline and starts variations concurrently with
the displayed route. At four workers, the 42.4 km comparison is 7.932 s versus
4.829 s overall, with foreground 1.597 s versus 1.705 s. This smaller foreground
penalty is a reason to measure conservative worker limits and implement priority.

A separate reversed-order check on the 42.4 km case at eight workers gives
6.348 s current versus 3.654 s overlap, with foreground 1.599 s versus 2.172 s.
The direction of the result survives reversal; these small samples do not justify
precise speed guarantees or tail-latency claims.

Every scenario's distance, duration, and geometry match across repetitions and
schedules within each invocation. Profiles genuinely alter routes: the three
fixtures produce respectively 3, 8, and 9 distinct geometries among 11 scenarios.

The fresh-JVM 42.4 km single-route timings are 1.959, 1.624, and 1.604 s.
Profile upload/validation precedes them. This is not a cold-disk experiment:
restarting the JVM does not flush OS file caches.

## Diagnostic recording

A separate approximately 51-second Flight Recorder workload includes startup,
profile validation, and single/current/overlap schedules for both longer cases.
Do not compare its instrumented timings directly with the measurements above.
Among 9,385 execution samples with application frames:

-   34.45% include graph access or decoding.
-   28.15% include the narrower block decoding/materialization context.
-   29.85% include path extension.
-   17.82% include profile expression evaluation.
-   6.57% include priority-queue operations.
-   0.05% include profile parsing; 0.02% include output formatting.

These are overlapping inclusive stack categories, not a disjoint wall-time
breakdown. Stack sampling cannot predict how much time a cache will save.
In particular, graph access includes operations a shared decoded cache would
still need to perform.

Weighted allocation samples are dominated by `StdPath` (52.33%), `OsmNode`
(18.67%), and `OsmPathElement` (13.47%). The sampled weights sum to roughly
32 GiB over the workload; this is an allocation estimate, not resident memory.
Recorded GC events have approximately 0.65 s of aggregate pauses. Search-local
path allocation is therefore an additional concern, separate from map decoding.

## Next checkpoint

Implement a bounded backend batch scheduler and progressive results, retaining
isolated search contexts. Give foreground work priority and avoid the duplicate
baseline. Benchmark this against the same fixtures before integrating the UI.

Keep shared decoded graph caching as a subsequent measured change. The recording
supports investigating it; it does not establish that caching will eliminate
most search work. Cache entries need safe eviction, bounded memory, and reload
correctness, as agreed. Preserve all existing profile and route behavior.

See `ROUTING-BENCHMARK.md` for runner commands and measurement limitations.
