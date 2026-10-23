# Installation

As an alternative to the [online version](https://brouter.de/brouter-web/), the standalone server of BRouter can also be run on your local desktop.

## Run the frontend and backend with Docker Compose

With this checkout in `frontend/` and the backend fork in `../backend`, run:

```sh
docker compose -f compose.workspace.yaml up --build -d
```

Open `http://127.0.0.1:3000`. A preparation container downloads any missing
Germany tiles and generates profiles. The Java backend starts next; the
frontend waits for its health check. Both run continuously under Docker, with
only localhost ports published. No host Node.js or Java installation is needed.

The Docker build uses `config.template.js` and empty template API keys, excluding
local `config.js`, `keys.js`, Git metadata, dependencies, and build artifacts.
Private routing, automatic Apply, and route estimates are configured at startup.
The frontend proxies requests over Docker's internal network to the backend.

Tiles are retained in `../.local/brouter/segments4`; generated profiles and
uploaded profiles use separate persistent volumes. Existing uploaded profiles
are preserved. The preparation service exiting with code 0 is expected.

```sh
docker compose -f compose.workspace.yaml ps
docker compose -f compose.workspace.yaml logs -f frontend brouter
docker compose -f compose.workspace.yaml down
```

Use `up --build -d` after source changes. Avoid `down --volumes` if you want to
keep Docker-managed profiles. Set `FRONTEND_PORT` to use another host port;
`ROUTE_ESTIMATE_CONCURRENCY` (1–32), `ALLOW_AUTO_APPLY`, and `ALLOW_ROUTE_ESTIMATES`
configure the frontend. Backend settings remain `BROUTER_MAX_THREADS` and
`BROUTER_JAVA_OPTS`. An absolute `BROUTER_DATA_DIR` overrides the tile directory.

## Manual frontend with a Docker routing service

This frontend checkout lives beside a separate `../backend` fork. The backend
owns its local service configuration in `compose.local.yaml` and its launcher
at `misc/scripts/standalone/start-local.sh`. See that repository's
`docs/developers/local_germany_service.md` for details.

Start Docker, then run from this frontend repository:

```sh
npm run backend:up
```

The launcher downloads nine routing tiles covering Germany and neighbouring
areas, reusing any existing tiles in `../.local/brouter/segments4`. It generates
upstream profile variants, builds the backend checkout's Dockerfile, and starts
the persistent service at `http://127.0.0.1:17777`. It does not reset the backend
branch or overwrite local source changes.

For the frontend, copy `config.template.js` to `config.js` and
`keys.template.js` to `keys.js` if those files do not already exist. In the
desktop configuration branch of `config.js`, set:

```js
BR.conf.host = origin;
BR.conf.profilesUrl = origin + '/profiles2/';
BR.conf.allowAutoApply = true;
BR.conf.allowRouteEstimates = true;
BR.conf.routeEstimateConcurrency = 32;
```

Then build and serve the frontend:

```sh
npm run build
npm run serve:local
```

Open `http://127.0.0.1:3000`. This local server forwards routing and custom
profile uploads to the Docker backend and serves the same profile files from
`../backend/misc/profiles2`. It has no fallback to the shared routing service.
Map backgrounds still use their configured tile providers.

On this private backend, **Apply automatically** applies option changes after
a 400 ms pause, including numeric fields and the five-step preferences. Its
switch remembers your choice in browser localStorage; turn it off to use Apply
manually. Invalid values are not sent. Applying also updates the selected saved
profile, just like the Apply button. The raw profile editor remains manual.
Automatic updates are disabled by default in `config.template.js` so shared
backend instances do not receive additional requests without configuration.

**Show route estimates** previews the time and distance differences for each
unpaved, forest, water, and quiet-surroundings rating, plus routing switches for
traffic, wet conditions, slopes, elevation, towns, cycle routes, steps, ferries,
road access, turn restrictions, and waypoint handling where the profile supports
them. Export-only switches do not get estimates. Each comparison
changes only one option relative to the current form settings. They are not
additive. With batching disabled, set `BR.conf.routeEstimateConcurrency = 32`
in `config.js` to allow up to thirty-two preview workers; the template defaults to one.
Only available comparisons are requested: a ten-option batch uses at most ten workers.
Each worker processes route segments sequentially. The legacy preview run uploads
one separate temporary base profile and uses BRouter's `profile:` parameters
for changes to global numeric and boolean values. This avoids a separate upload for every candidate. Changes to expressions
fall back to a separate upload. Previews do not change the route, selected profile, or saved
library. Results are cached in memory for the current route, alternative,
avoidance areas, and profile text. Editing a setting or route cancels outdated
previews. The switch remembers its state in localStorage and immediately stops
pending previews when turned off. Estimated differences use whole minutes and
tenths of a kilometre. This feature is disabled in the shared-backend template.

The workspace Docker frontend now enables `BR.conf.useRouteBatches`: it sends
one streaming `POST /brouter/batch` per routed leg, combining the displayed route
and all comparisons. The current result updates the map immediately; differences
appear as results arrive. Alternative routes, avoidance areas, and straight-line
legs retain their existing meaning. This mode uses the server's batch worker
budget (four background workers and one reserved foreground worker by default),
rather than `routeEstimateConcurrency`. A displayed route does not need another
baseline request. See [the batch checkpoint](tools/ROUTING-BATCH.md).

Set `USE_ROUTE_BATCHES=false` when recreating the frontend container to disable
batching. The template defaults to off for shared services. Servers returning
404, 405, or 501 for the endpoint automatically use the older request flow for
that page session. Turning estimates off cancels batch previews while preserving
any pending map route through the ordinary endpoint. Unapplied drafts remain
previews; batching does not apply them to the map.

The Java service stays running between requests. `MAXTHREADS=40` limits concurrent
legacy requests; it does not parallelize an individual route. Upstream creates a routing
context per request and synchronizes its shared profile cache. Its overload
policy can cancel the oldest request once the thread limit is reached, so avoid
unbounded parallel previews. Increasing this limit also increases potential
memory use; the current JVM heap limit is 16 GiB. Thirty-two preview workers leave capacity
for foreground routing. Turning estimates off aborts all pending preview requests.

Useful service commands:

```sh
docker compose -f ../backend/compose.local.yaml ps
docker compose -f ../backend/compose.local.yaml logs --tail=50 brouter
npm run backend:down
```

Downloaded source and routing data stay in the workspace-level `../.local/` directory, outside this repository.
Uploaded custom profiles persist in a Docker named volume; stopping the service
does not delete them. Your named profile library remains in browser localStorage.
The backend is published only on the local loopback interface and restarts with
Docker unless explicitly stopped. Routing data are not updated automatically.

## Install standalone zip (client and server)

1.  download and unzip latest standalone archive (`brouter-web-standalone.<version>.zip`) from https://github.com/nrenner/brouter-web/releases e.g. for Linux (replace `~/opt/` with your preferred install directory and `0.11.0` with latest version):

            mkdir -p ~/opt/brouter
            cd ~/opt/brouter
            wget https://github.com/nrenner/brouter-web/releases/download/0.11.0/brouter-web-standalone.0.11.0.zip
            unzip brouter-web-standalone.0.11.0.zip

2.  download one or more rd5 data file(s) from the [download directory](https://brouter.de/brouter/segments4/) or the [grid map](https://umap.openstreetmap.de/de/map/brouter-rd5-grid_9438) into the `segments4` directory

### Configure BRouter-Web

In the `brouter-web` subdirectory:

1.  copy `config.template.js` to `config.js`
2.  add your API keys (optional)  
    copy `keys.template.js` to `keys.js` and edit to add your keys

### Run

1.  start `./run.sh`

## Running as Docker container (client only)

brouter-web can be run as a Docker container, making it easy for continous deployment or running locally
without having to install any build tools.

The `Dockerfile` builds the application inside a NodeJS container and copies the built application into a
separate Nginx based image. The application runs from a webserver only container serving only static files.

### Prerequisites

-   Docker installed
-   working directory is this repository
-   `config.template.js` copied to `config.js` and modified with a Brouter server, see `BR.conf.host`
-   `keys.template.js` to `keys.js` and add your API keys
-   Optionally create `profiles` directory with `brf` profile files and add path to `config.js`:
    BR.conf.profilesUrl = 'profiles/';

### Building Docker image

To build the Docker container run:

      docker build -t brouter-web .

This creates a Docker image with the name `brouter-web`.

### Running Docker container

To run the previously build Docker image run:

      docker run --rm --name brouter-web \
        -p 127.0.0.1:8080:80 \
        -v "`pwd`/config.js:/usr/share/nginx/html/config.js" \
        -v "`pwd`/keys.js:/usr/share/nginx/html/keys.js" \
        -v "`pwd`/profiles:/usr/share/nginx/html/profiles" \
        brouter-web

This command does the following:

1. Runs a container with the name `brouter-web` and removes it automatically after stopping
1. Binds port 80 of the container to the host interface 127.0.0.1 on port 8080
1. Takes the absolute paths of `config.js`, `keys.js` and `profiles` and mounts them inside the container
1. Uses the image `brouter-web` to run as a container

brouter-web should be accessible at http://127.0.0.1:8080.
