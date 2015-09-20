'use strict';

var _ = require('lodash'),
    Promise = require('bluebird'),
    domain = require('./domain'),
    http = require('http'),
    EventEmitter = require('events').EventEmitter,
    ProxyAgent = require('./proxy-agent'),
    TimeCounter = require('./time-counter'),
    url = require('url'),
    util = require('util'),
    winston = require('winston');


module.exports = ProxiesMaster;


////////////

function ProxiesMaster(config, manager) {
    var self = this;

    EventEmitter.call(self);

    self._config = config;
    self._manager = manager;

    // Stats
    self._requestsTimeAverageCounter = new TimeCounter();
    self._requestsFinishedCounter = 0;
    self._bytesSent = 0;
    self._bytesReceived = 0;

    refreshStats();

    // Proxy Auth
    if (self._config.auth &&
        self._config.auth.username &&
        self._config.auth.password ) {
        self._.auth = 'Basic ' + new Buffer(self._config.auth.username + ':' + self._config.auth.password).toString('base64');
    }

    // HTTP Agent
    self._agent = new ProxyAgent({
        agent: new http.Agent(),
    });

    // Config server
    self._server = http.createServer();

    self._server.on('request', requestFn);


    ////////////

    function refreshStats() {
        setInterval(function() {
            var requestsTimeAverage = self._requestsTimeAverageCounter.getAverageAndClear(),
                kbytesSent = Math.floor(self._bytesSent / 1024),
                kbytesReceived = Math.floor(self._bytesReceived / 1024);

            var stats = {
                requests_time_average: requestsTimeAverage,
                requests_finished: self._requestsFinishedCounter,
                kbytes_sent: kbytesSent,
                kbytes_received: kbytesReceived,
            };

            self._requestsFinishedCounter = 0;
            self._bytesSent = 0;
            self._bytesReceived = 0;

            self.emit('stats', stats);
        }, config.statsSamplingDelay);
    }

    function requestFn(req, res) {
        winston.debug('[ProxiesMaster] request (%s) %s %s', req.connection.remoteAddress, req.method, req.url);

        // Check auth
        if (self._auth) {
            if (!req.headers['proxy-authorization'] || req.headers['proxy-authorization'] !== self._auth) {
                res.writeHead(407);
                return res.end('Wrong proxy credentials');
            }
        }

        // Log errors
        req.on('error', function(err) {
            winston.error('[ProxiesMaster] request (error client) %s %s => %s', req.method, req.url, err.toString());
        });

        res.on('error', function(err) {
            winston.error('[ProxiesMaster] request (error client) %s %s => %s', req.method, req.url, err.toString());
        });

        // Trigger scaling if necessary
        self._manager.requestReceived();


        // Get domain
        var uri = domain.convertHostnamePathToUri(req.hostname, req.url);
        var basedomain = domain.getBaseDomainForUri(uri);


        // Find instance
        var forceName = req.headers['x-cache-proxyname'],
            //instance = self._manager.getNextRunningInstanceForDomain(basedomain, forceName);
            instance = self._manager.getFirstInstance(forceName);

        if (!instance) {
            winston.error('[ProxiesMaster] request: no running instance found');

            res.writeHead(407);
            return res.end('No running instance found');
        }


        // Update headers
        instance.updateHeaders(req);

        // Make request
        winston.debug('[ProxiesMaster] makeRequest from %s: (%s) %s %s', instance.toString(), req.connection.remoteAddress, req.method, req.url);

        var proxyOpts = _.assign(createProxyOpts(req.url), {
            method: req.method,
            headers: req.headers,
            agent: self._agent,
            proxy: instance.getProxyParameters(),
        });

        var proxy_req = http.request(proxyOpts);

        proxy_req.on('error', function(err) {
            winston.error('[ProxiesMaster] request (error proxy) %s %s => %s', req.method, req.url, err.toString());

            res.writeHead(500);
            res.end('Error in proxy request: ' + err.toString());
        });

        // Start time
        var start = process.hrtime();

        proxy_req.on('response', function(proxy_res) {
            proxy_res.on('error', function(err) {
                winston.error('[ProxiesMaster] response (error proxy) %s %s => %s', req.method, req.url, err.toString());

                res.writeHead(500);
                res.end('Error in proxy response: ' + err.toString());
            });

            proxy_res.on('end', function() {
                // Stop time and record time
                var elapsed = process.hrtime(start);

                // Add elapsed time
                self._requestsTimeAverageCounter.add(elapsed);

                // Increment count
                ++self._requestsFinishedCounter;

                // Add bytes (flow)
                self._bytesSent += proxy_res.socket._bytesDispatched;
                self._bytesReceived += proxy_res.socket.bytesRead;
            });

            var headers = _.assign({}, proxy_res.headers, {
                'x-cache-proxyname': instance.getName(),
            });

            res.writeHead(proxy_res.statusCode, headers);

            proxy_res.pipe(res);
        });

        req.pipe(proxy_req);


        ////////////

        function createProxyOpts(target) {
            var opts = url.parse(target);

            opts = _.pick(opts, 'protocol', 'hostname', 'port', 'path');
            if (opts.protocol) {
                if (opts.protocol === 'https:') {
                    opts.ssl = true;
                }

                delete opts.protocol;
            }

            if (!opts.port) {
                opts.port = opts.ssl ? 443 : 80;
            }

            return opts;
        }
    }
}
util.inherits(ProxiesMaster, EventEmitter);


ProxiesMaster.prototype.listen = function listenFn() {
    var self = this;

    return new Promise(function(resolve, reject) {
        self._server.listen(self._config.port, function(err) {
            if (err) return reject(new Error('[ProxiesMaster] Cannot listen at port ' + self._config.port + ': ' + err.toString()));

            winston.info('Proxy is listening at http://localhost:%d', self._config.port);

            return resolve();
        });
    });
};


ProxiesMaster.prototype.shutdown = function shutdownFn() {
    winston.debug('[ProxiesMaster] shutdown');

    this._server.close();
};
