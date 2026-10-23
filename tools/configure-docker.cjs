// Generate private-instance configuration without copying host API keys or config.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const template = fs.readFileSync(path.join(root, 'config.template.js'), 'utf8');
const workers = Number(process.env.ROUTE_ESTIMATE_CONCURRENCY || 32);
if (!Number.isInteger(workers) || workers < 1 || workers > 32) {
    throw new Error('ROUTE_ESTIMATE_CONCURRENCY must be an integer from 1 to 32.');
}
const overrides = `
// This container proxies exclusively to its private BRouter service.
BR.conf.host = window.location.origin;
BR.conf.profilesUrl = window.location.origin + '/profiles2/';
BR.conf.allowAutoApply = ${process.env.ALLOW_AUTO_APPLY !== 'false'};
BR.conf.allowRouteEstimates = ${process.env.ALLOW_ROUTE_ESTIMATES !== 'false'};
BR.conf.routeEstimateConcurrency = ${workers};
BR.conf.useRouteBatches = ${process.env.USE_ROUTE_BATCHES !== 'false'};
`;
fs.writeFileSync(path.join(root, 'config.js'), template + overrides);
