# Batch endpoint checkpoint — 23 October 2026

Milestone 2 is implemented and running in the local Docker stack. The backend
has an opt-in `POST /brouter/batch` endpoint, also forwarded through port 3000.
The UI is connected to the stream. The next increment adds an optional shared decoded graph cache.

## Behavior

-   One base profile and a set of literal parameter variations per request.
-   At most eight active batches and 64 scenarios per batch.
-   Four background workers plus one reserved foreground worker, shared across
    batches. Legacy single requests retain their existing scheduling.
-   Progressive NDJSON events: start, individual results/errors, heartbeat, complete.
-   Only the current scenario returns full geometry; previews return distance/time.
-   Cooperative cancellation removes queued work and terminates active searches.
-   A failed scenario does not suppress successful results from other scenarios.

The backend documentation is `../backend/docs/developers/batch_routing.md`,
relative to the frontend checkout. It includes a directly usable curl example.
The workspace Compose defaults enable the endpoint. Its flag is separate from
the legacy POST-routing flag; deployments without the batch flag return 404.

## Measurements

Three repetitions per longer-route schedule, using the same 11 scenarios as
the initial baseline. Both legacy overlap and batch use four background workers;
the batch additionally reserves a worker for foreground jobs. These measurements
use direct backend HTTP requests and do not predict UI timing.

-   Munich–Herrsching, 42.4 km: current sequence 7.957 s overall, legacy overlap
    4.884 s, batch 4.883 s. Foreground medians are 1.647, 1.734, and 1.716 s.
-   Same endpoints, alternative index 1, 41.3 km: current sequence 16.090 s,
    legacy overlap 9.897 s, batch 9.969 s. Foreground medians are 3.237, 3.524,
    and 3.515 s.
-   Batch start events arrive in approximately 2 ms, demonstrating progressive
    delivery before any route is ready.

All scenario distances and durations match individual routing requests. Current
geometry also matches. Preview geometry is deliberately not returned or compared.
The batch performs similarly to the equivalent overlapping individual requests:
it implements coordinated scheduling and streaming, not graph-cache acceleration.
The gain over the current UI sequence comes from overlapping searches and
removing the duplicate baseline. Small samples and fixed order limit precision.

## Protocol and cancellation checks

Through port 3000: unsupported GET returns 405, malformed body returns 400,
OPTIONS returns 200 with POST allowed, and a ninth active batch returns 429 with
Retry-After. Eight admitted batches were disconnected while work remained.
After heartbeat cancellation, a new batch completed successfully. Backend CPU
usage over a later two-second idle window was about 14 ms, rather than sustained
processing of obsolete previews. This is an observation, not a cancellation SLA.

Java tests cover bounded admission, reserved foreground capacity, queued and
active cancellation, shutdown, nested form parsing, mixed scenario success/error,
and equivalence with the existing route API. The backend full build, tests,
Checkstyle and PMD passed; focused tests additionally cover the latest test cases.
Eight Node checks cover scenario construction, worker limits, fragmented UTF-8,
out-of-order results, and truncated/cancelled streams.

Raw reports remain outside Git in the workspace `.local/benchmarks/` directory:
`batch-comparison.json`, `batch-smoke.json`, `batch-proxy-comparison.json`, and
`batch-proxy-cancellation.json`.

## UI integration

The local Docker frontend enables `BR.conf.useRouteBatches`. The shared-backend
configuration template leaves it off. Set `USE_ROUTE_BATCHES=false` before
recreating the frontend container to select the legacy request flow.

The UI sends one batch per routed leg, preserving alternative indices and nogos.
Straight-line legs have no routing request and contribute zero to differences.
The current scenario supplies the displayed geometry and the comparison baseline;
there is no duplicate baseline GET. Each indicator appears once its candidate
and baseline totals are available across every routed leg. Completed map legs
stay visible while estimates continue arriving.

The existing estimates switch cancels previews. Obsolete streams are aborted and
late results ignored. If a cancelled stream still owns a pending, unchanged map
leg, that leg uses the ordinary route endpoint. Changed route/profile arguments
reject stale geometry. Unapplied drafts can be previewed without changing the map.
Missing batch endpoints (404/405/501) disable batching for the page session and
fall back to ordinary requests. Other failures retain completed results and mark
missing comparisons unavailable. Unsupported structural profile changes also
retain the legacy preview path.

Browser verification on a 40.2 km route observed one batch POST: displayed route
at 1.76 s after navigation, with 0 of 24 comparisons ready; the final comparison
arrived at 7.42 s. Changing the forest preference issued one normal profile upload
and one batch POST, with no separate route GET. These are individual functional
observations, not benchmark medians. Browser checks also confirmed that rapid
preference edits followed by switching estimates off abort the stream, keep the
map route through the single-route fallback, clear indicators, and do not restart
previews when the map request finishes. No browser errors were observed.
The final frontend build and all 153 Jest
checks passed, as did lint for changed JavaScript and the eight benchmark checks.

## Shared graph cache checkpoint

The backend now optionally shares immutable decoded RD5 cells. The workspace
Compose default is 256 MiB; set `BROUTER_SHARED_GRAPH_CACHE_MB=0` when recreating
the backend to disable it. Search state and profile costs remain independent.
See `../backend/docs/developers/shared_graph_cache.md` relative to the frontend
checkout for invariants, diagnostics, validation and the initial 10–12% batch
latency improvement on longer routes. Prefetching remains a separate experiment.
