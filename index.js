'use strict'
const { ServerResponse } = require('node:http')
const WebSocket = require('ws')
const fp = require('fastify-plugin')
const qs = require('fast-querystring')
const http = require('http');
const https = require('https');
const { PassThrough } = require('stream');

const httpMethods = ['DELETE', 'GET', 'HEAD', 'PATCH', 'POST', 'PUT', 'OPTIONS']
const urlPattern = /^https?:\/\//
const kWs = Symbol('ws')
const kWsHead = Symbol('wsHead')
const kWsUpgradeListener = Symbol('wsUpgradeListener')
function convertUrlToWebSocket(urlString) {
    return urlString.replace(/^(http)(s)?:\/\//, 'ws$2://')
}
function liftErrorCode(code) {
    /* c8 ignore start */
    if (typeof code !== 'number') {
        // Sometimes "close" event emits with a non-numeric value
        return 1011
    } else if (code === 1004 || code === 1005 || code === 1006) {
        // ws module forbid those error codes usage, lift to "application level" (4xxx)
        return 3000 + code
    } else {
        return code
    }
    /* c8 ignore stop */
}

function closeWebSocket(socket, code, reason) {
    if (socket.readyState === WebSocket.OPEN) {
        socket.close(liftErrorCode(code), reason)
    }
}

function waitConnection(socket, write) {
    if (socket.readyState === WebSocket.CONNECTING) {
        socket.once('open', write)
    } else {
        write()
    }
}

function isExternalUrl(url) {
    return urlPattern.test(url)
}

function noop() { }

function proxyWebSockets(source, target) {
    function close(code, reason) {
        closeWebSocket(source, code, reason)
        closeWebSocket(target, code, reason)
    }

    source.on('message', (data, binary) => waitConnection(target, () => target.send(data, { binary })))
    /* c8 ignore start */
    source.on('ping', data => waitConnection(target, () => target.ping(data)))
    source.on('pong', data => waitConnection(target, () => target.pong(data)))
    /* c8 ignore stop */
    source.on('close', close)
    /* c8 ignore start */
    source.on('error', error => close(1011, error.message))
    source.on('unexpected-response', () => close(1011, 'unexpected response'))
    /* c8 ignore stop */

    // source WebSocket is already connected because it is created by ws server
    target.on('message', (data, binary) => source.send(data, { binary }))
    /* c8 ignore start */
    target.on('ping', data => source.ping(data))
    /* c8 ignore stop */
    target.on('pong', data => source.pong(data))
    target.on('close', close)
    /* c8 ignore start */
    target.on('error', error => close(1011, error.message))
    target.on('unexpected-response', () => close(1011, 'unexpected response'))
    /* c8 ignore stop */
}

function handleUpgrade(fastify, rawRequest, socket, head) {
    // Save a reference to the socket and then dispatch the request through the normal fastify router so that it will invoke hooks and then eventually a route handler that might upgrade the socket.
    rawRequest[kWs] = socket
    rawRequest[kWsHead] = head

    const rawResponse = new ServerResponse(rawRequest)
    rawResponse.assignSocket(socket)
    fastify.routing(rawRequest, rawResponse)

    rawResponse.on('finish', () => {
        socket.destroy()
    })
}

class WebSocketProxy {
    constructor(fastify, { wsServerOptions, wsClientOptions, upstream, wsUpstream, replyOptions: { getUpstream } = {} }) {
        this.logger = fastify.log
        this.wsClientOptions = {
            rewriteRequestHeaders: defaultWsHeadersRewrite,
            headers: {},
            ...wsClientOptions
        }
        this.upstream = upstream ? convertUrlToWebSocket(upstream) : ''
        this.wsUpstream = wsUpstream ? convertUrlToWebSocket(wsUpstream) : ''
        this.getUpstream = getUpstream

        const wss = new WebSocket.Server({
            noServer: true,
            ...wsServerOptions
        })

        if (!fastify.server[kWsUpgradeListener]) {
            fastify.server[kWsUpgradeListener] = (rawRequest, socket, head) =>
                handleUpgrade(fastify, rawRequest, socket, head)
            fastify.server.on('upgrade', fastify.server[kWsUpgradeListener])
        }

        this.handleUpgrade = (request, dest, cb) => {
            wss.handleUpgrade(request.raw, request.raw[kWs], request.raw[kWsHead], (socket) => {
                this.handleConnection(socket, request, dest)
                cb()
            })
        }

        // To be able to close the HTTP server,
        // all WebSocket clients need to be disconnected.
        // Fastify is missing a pre-close event, or the ability to
        // add a hook before the server.close call. We need to resort
        // to monkeypatching for now.
        {
            const oldClose = fastify.server.close
            fastify.server.close = function (done) {
                wss.close(() => {
                    oldClose.call(this, (err) => {
                        done && done(err)
                    })
                })
                for (const client of wss.clients) {
                    client.close()
                }
            }
        }

        /* c8 ignore start */
        wss.on('error', (err) => {
            this.logger.error(err)
        })
        /* c8 ignore stop */

        this.wss = wss
        this.prefixList = []
    }

    findUpstream(request, dest) {
        const { search, pathname } = new URL(request.url, 'ws://127.0.0.1')

        if (typeof this.wsUpstream === 'string' && this.wsUpstream !== '') {
            const target = new URL(this.wsUpstream)
            target.search = search
            target.pathname = target.pathname === '/' ? pathname : target.pathname
            return target
        }

        if (typeof this.upstream === 'string' && this.upstream !== '') {
            const target = new URL(dest, this.upstream)
            target.search = search
            return target
        }

        const upstream = this.getUpstream(request, '')
        const target = new URL(dest, upstream)
        /* c8 ignore next */
        target.protocol = upstream.indexOf('http:') === 0 ? 'ws:' : 'wss'
        target.search = search
        return target
    }

    handleConnection(source, request, dest) {
        const url = this.findUpstream(request, dest)
        const queryString = getQueryString(url.search, request.url, this.wsClientOptions, request)
        url.search = queryString

        const rewriteRequestHeaders = this.wsClientOptions.rewriteRequestHeaders
        const headersToRewrite = this.wsClientOptions.headers

        const subprotocols = []
        if (source.protocol) {
            subprotocols.push(source.protocol)
        }

        const headers = rewriteRequestHeaders(headersToRewrite, request)
        const optionsWs = { ...this.wsClientOptions, headers }

        const target = new WebSocket(url, subprotocols, optionsWs)
        this.logger.debug({ url: url.href }, 'proxy websocket')
        proxyWebSockets(source, target)
    }
}

function getQueryString(search, reqUrl, opts, request) {
    if (typeof opts.queryString === 'function') {
        return '?' + opts.queryString(search, reqUrl, request)
    }

    if (opts.queryString) {
        return '?' + qs.stringify(opts.queryString)
    }

    if (search.length > 0) {
        return search
    }

    return ''
}

function defaultWsHeadersRewrite(headers, request) {
    if (request.headers.cookie) {
        return { ...headers, cookie: request.headers.cookie }
    }
    return { ...headers }
}

function generateRewritePrefix(prefix, opts) {
    let rewritePrefix = opts.rewritePrefix || (opts.upstream ? new URL(opts.upstream).pathname : '/')

    if (!prefix.endsWith('/') && rewritePrefix.endsWith('/')) {
        rewritePrefix = rewritePrefix.slice(0, -1)
    }

    return rewritePrefix
}

async function fastifyHttpProxy(fastify, opts) {
    if (!opts.upstream && !opts.websocket && !((opts.upstream === '' || opts.wsUpstream === '') && opts.replyOptions && typeof opts.replyOptions.getUpstream === 'function')) {
        throw new Error('upstream must be specified')
    }

    const preHandler = opts.preHandler || opts.beforeHandler
    const rewritePrefix = generateRewritePrefix(fastify.prefix, opts)

    const internalRewriteLocationHeader = opts.internalRewriteLocationHeader ?? true
    const oldRewriteHeaders = (opts.replyOptions || {}).rewriteHeaders
    const replyOpts = Object.assign({}, opts.replyOptions, {
        rewriteHeaders
    })

    if (opts.preValidation) {
        fastify.addHook('preValidation', opts.preValidation)
    } else if (opts.proxyPayloads !== false) {
        fastify.addContentTypeParser('application/json', bodyParser)
        fastify.addContentTypeParser('*', bodyParser)
    }

    function rewriteHeaders(headers, req) {
        const location = headers.location
        if (location && !isExternalUrl(location) && internalRewriteLocationHeader) {
            headers.location = location.replace(rewritePrefix, fastify.prefix)
        }
        if (oldRewriteHeaders) {
            headers = oldRewriteHeaders(headers, req)
        }
        return headers
    }

    function bodyParser(req, payload, done) {
        done(null, payload)
    }

    const allowedHttpMethods = opts.allowedHttpMethods || httpMethods;

    fastify.route({
        url: '/',
        method: allowedHttpMethods,
        preHandler,
        config: opts.config || {},
        constraints: opts.constraints || {},
        handler
    })
    fastify.route({
        url: '/*',
        method: allowedHttpMethods,
        preHandler,
        config: opts.config || {},
        constraints: opts.constraints || {},
        handler
    })

    let wsProxy

    if (opts.websocket) {
        wsProxy = new WebSocketProxy(fastify, opts)
    }

    function extractUrlComponents(urlString) {
        const [path, queryString] = urlString.split('?', 2)
        const components = {
            path,
            queryParams: null
        }

        if (queryString) {
            components.queryParams = qs.parse(queryString)
        }

        return components
    }

    async function handler(request, reply) {
        const { path, queryParams } = extractUrlComponents(request.url)
        let dest = path

        if (this.prefix.includes(':')) {
            const requestedPathElements = path.split('/')
            const prefixPathWithVariables = this.prefix.split('/').map((_, index) => requestedPathElements[index]).join('/')

            let rewritePrefixWithVariables = rewritePrefix
            for (const [name, value] of Object.entries(request.params)) {
                rewritePrefixWithVariables = rewritePrefixWithVariables.replace(`:${name}`, value)
            }

            dest = dest.replace(prefixPathWithVariables, rewritePrefixWithVariables)
            if (queryParams) {
                dest += `?${qs.stringify(queryParams)}`
            }
        } else {
            dest = dest.replace(this.prefix, rewritePrefix)
        }

        if (request.raw[kWs]) {
            reply.hijack()
            try {
                wsProxy.handleUpgrade(request, dest || '/', noop)
            } /* c8 ignore start */ catch (err) {
                request.log.warn({ err }, 'websocket proxy error')
            } /* c8 ignore stop */
            return
        }
        await proxyRequest(request, reply, opts.upstream + dest, replyOpts, rewriteHeaders)
    }
}

async function proxyRequest(request, reply, target, replyOpts, rewriteHeaders) {
    const { method, headers, body, params, query } = request;
    let url = new URL(target);
    const isHttps = url.protocol === 'https:';
    const proxyHeaders = { ...headers };

    // Remove hop-by-hop headers
    delete proxyHeaders['connection'];
    delete proxyHeaders['transfer-encoding'];
    delete proxyHeaders['upgrade'];

    // Set host header to target host
    proxyHeaders['host'] = url.host;

    // Redirect loop detection
    const visitedUrls = new Set();

    // Redirect handling configuration - update the default mode to 'client' for better behavior with Next.js
    const handleRedirectsMode = replyOpts.handleRedirects || 'client';
    const followRedirects = (handleRedirectsMode === 'follow' || handleRedirectsMode === 'server') && 
                           replyOpts.followRedirects !== false;
    const maxRedirects = replyOpts.maxRedirects || 5; // Lower max redirects to prevent excessive requests
    const redirectStatusCodes = replyOpts.redirectStatusCodes || [301, 302, 303, 307, 308];

    // Don't follow redirects for certain request patterns (API, Next.js data, etc.)
    const shouldSkipRedirectFollow = (url, method) => {
        // Never follow redirects for HEAD requests (often used for preflight)
        if (method === 'HEAD') return true;
        
        // Don't follow redirects for Next.js data fetching
        if (url.includes('/_next/data/')) return true;
        
        // Don't follow redirects for API calls
        if (url.includes('/api/')) return true;
        
        return false;
    };

    // HTTPS options
    const httpsOptions = replyOpts.https || {};
    const rejectUnauthorized = typeof httpsOptions.rejectUnauthorized === 'boolean'
        ? httpsOptions.rejectUnauthorized
        : true;

    // Debug mode
    const debug = replyOpts.debug || false;
    
    // Timeout configuration - increased default from 30s to 60s
    const timeoutMs = replyOpts.timeout || 60000;
    
    // Retry configuration
    const maxRetries = replyOpts.maxRetries || 1;
    const retryDelay = replyOpts.retryDelay || 1000;

    // Add a response tracking flag
    let hasResponded = false;
    
    // Safe response function to avoid duplicate responses
    const sendResponse = (statusCode, payload) => {
        if (hasResponded || reply.sent) return;
        hasResponded = true;
        reply.status(statusCode).send(payload);
    };

    // Function to perform the actual HTTP request
    const performRequest = async (targetUrl, reqMethod, reqBody, redirectCount = 0, retryCount = 0, prevHeaders = {}) => {
        // If we already responded, don't perform another request
        if (hasResponded || reply.sent) {
            return;
        }
        
        let requestUrl = new URL(targetUrl);
        const reqIsHttps = requestUrl.protocol === 'https:';

        // Inject parameters into the path
        let path = requestUrl.pathname;
        for (const [name, value] of Object.entries(params)) {
            path = path.replace(`:${name}`, value);
        }

        // Append query parameters
        let queryString = requestUrl.search;
        if (query && Object.keys(query).length > 0) {
            const newQueryString = qs.stringify(query);
            queryString = queryString ? `${queryString}&${newQueryString}` : `?${newQueryString}`;
        }

        // Use the host from the current target URL
        const currentHeaders = { ...proxyHeaders, ...prevHeaders };
        currentHeaders['host'] = requestUrl.host;

        // Handle specific Cloudflare headers
        if (currentHeaders['cf-ray']) {
            // Keep Cloudflare headers that should be passed upstream
            const cloudflareHeaders = ['cf-connecting-ip', 'cf-ipcountry', 'cf-visitor'];
            cloudflareHeaders.forEach(header => {
                if (headers[header]) {
                    currentHeaders[header] = headers[header];
                }
            });
        }

        const reqOptions = {
            method: reqMethod,
            headers: currentHeaders,
            hostname: requestUrl.hostname,
            port: requestUrl.port || (reqIsHttps ? 443 : 80),
            path: path + queryString,
            timeout: timeoutMs,
        };

        // Add HTTPS specific options
        if (reqIsHttps) {
            reqOptions.rejectUnauthorized = rejectUnauthorized;

            if (httpsOptions.ca) reqOptions.ca = httpsOptions.ca;
            if (httpsOptions.cert) reqOptions.cert = httpsOptions.cert;
            if (httpsOptions.key) reqOptions.key = httpsOptions.key;
            if (httpsOptions.passphrase) reqOptions.passphrase = httpsOptions.passphrase;
        }

        if (debug) {
            request.log.info({
                targetUrl,
                method: reqMethod,
                headers: currentHeaders,
                redirectCount,
                retryCount,
                timeout: timeoutMs
            }, 'Proxy request details');
        }

        // Check for redirect loops
        if (visitedUrls.has(targetUrl)) {
            request.log.warn({
                targetUrl,
                redirectCount,
                method: reqMethod,
            }, 'Detected potential redirect loop - canceling redirect follow');
            
            // Force client-side handling for this redirect
            const tempRedirectMode = 'client';
            
            // Continue with the request, but we'll pass any redirect back to the client
            // instead of following it automatically
        }
        
        // Add this URL to visited set
        visitedUrls.add(targetUrl);

        return new Promise((resolve, reject) => {
            const req = (reqIsHttps ? https : http).request(reqOptions, (res) => {
                const statusCode = res.statusCode || 500;

                if (debug) {
                    request.log.info({
                        statusCode,
                        headers: res.headers,
                        redirectCount,
                        retryCount,
                        location: res.headers.location
                    }, 'Proxy response details');
                }

                // Enhanced redirect handling - log more details about redirects
                if (redirectStatusCodes.includes(statusCode) && res.headers.location) {
                    // Get the redirect URL - handle both absolute and relative URLs
                    const redirectUrl = /^https?:\/\//i.test(res.headers.location)
                        ? res.headers.location
                        : new URL(res.headers.location, targetUrl).href;

                    // Check if this is a URL we should skip automatic redirect handling for
                    const skipRedirect = shouldSkipRedirectFollow(targetUrl, reqMethod);

                    request.log.info({
                        redirectCount,
                        statusCode,
                        from: targetUrl,
                        to: redirectUrl,
                        method: reqMethod,
                        mode: skipRedirect ? 'client (forced)' : handleRedirectsMode,
                        willFollow: !skipRedirect && followRedirects && redirectCount < maxRedirects && 
                                   !visitedUrls.has(redirectUrl)
                    }, 'Found redirect');

                    // If we should skip redirect following for this URL or we've reached max redirects
                    // or we're in client mode, pass the redirect to the client
                    if (skipRedirect || handleRedirectsMode === 'client' || redirectCount >= maxRedirects) {
                        // Pass the redirect straight to the client
                        // Convert the location URL if needed
                        let locationUrl = res.headers.location;
                        
                        // If we have an internal URL, we may need to rewrite it for the client
                        if (!isExternalUrl(locationUrl)) {
                            // If it's a relative URL (no protocol/host), make it absolute for the client
                            if (locationUrl.startsWith('/')) {
                                // Get the original request host
                                const originalHost = request.headers.host;
                                const protocol = request.headers['x-forwarded-proto'] ||
                                    (request.socket.encrypted ? 'https' : 'http');

                                locationUrl = `${protocol}://${originalHost}${locationUrl}`;
                            }
                        }

                        // Set the status code and location header for the client
                        if (hasResponded || reply.sent) {
                            res.resume();
                            resolve();
                            return;
                        }

                        hasResponded = true;
                        reply.status(statusCode)
                            .header('location', locationUrl);

                        // Copy any other headers we want to preserve
                        const headersToPreserve = ['set-cookie', 'cache-control', 'expires'];
                        headersToPreserve.forEach(header => {
                            if (res.headers[header]) {
                                reply.header(header, res.headers[header]);
                            }
                        });

                        // Drain the response to avoid memory leaks
                        res.resume();
                        reply.send();
                        resolve();
                        return;
                    } 
                    // New 'follow' mode - automatically follows redirects and returns final response to client
                    else if (handleRedirectsMode === 'follow' && redirectCount < maxRedirects) {
                        // Determine which HTTP method to use for the redirect
                        let redirectMethod = reqMethod;

                        // Keep original method for 307/308 (unlike 301/302/303)
                        if (statusCode === 307 || statusCode === 308) {
                            // For 307/308, preserve the method according to HTTP spec
                            redirectMethod = reqMethod;
                        } 
                        // For 303, always use GET
                        else if (statusCode === 303) {
                            redirectMethod = 'GET';
                        }
                        // For 301 and 302, browsers typically change POST to GET
                        else if ((statusCode === 301 || statusCode === 302) && reqMethod === 'POST') {
                            redirectMethod = 'GET';
                        }

                        // Collect cookies from redirect response to pass to the next request
                        const redirectHeaders = {};
                        if (res.headers['set-cookie']) {
                            redirectHeaders['cookie'] = res.headers['set-cookie'];
                        }

                        // Drain the response to avoid memory leaks
                        res.resume();

                        // Make sure we don't already have a response before continuing
                        if (hasResponded || reply.sent) {
                            resolve();
                            return;
                        }

                        // Small delay before following redirect to avoid rate limiting
                        setTimeout(() => {
                            // Check if we've already visited this URL to prevent loops
                            if (visitedUrls.has(redirectUrl)) {
                                request.log.warn({
                                    redirectUrl,
                                    redirectCount,
                                    visitedUrls: Array.from(visitedUrls)
                                }, 'Redirect loop detected - passing to client');
                                
                                // Pass the redirect to client instead of following
                                if (!hasResponded && !reply.sent) {
                                    hasResponded = true;
                                    reply.status(statusCode);
                                    Object.keys(res.headers).forEach(header => {
                                        reply.header(header, res.headers[header]);
                                    });
                                    reply.send();
                                }
                                resolve();
                                return;
                            }
                            
                            resolve(performRequest(redirectUrl, redirectMethod,
                                // For 307/308 we need to reuse the body, for others only if not GET
                                (statusCode === 307 || statusCode === 308 || redirectMethod !== 'GET') ? reqBody : null,
                                redirectCount + 1, 0, redirectHeaders));
                        }, 100);  // Small 100ms delay to avoid overwhelming servers
                    }
                    // Server-side redirect handling (legacy mode, kept for compatibility)
                    else if (handleRedirectsMode === 'server' && followRedirects && redirectCount < maxRedirects) {
                        // Determine which HTTP method to use for the redirect
                        let redirectMethod = reqMethod;

                        // For 303, always use GET
                        if (statusCode === 303) {
                            redirectMethod = 'GET';
                        }
                        // For 301 and 302, browsers typically change POST to GET
                        else if ((statusCode === 301 || statusCode === 302) && reqMethod === 'POST') {
                            redirectMethod = 'GET';
                        }

                        // Collect cookies from redirect response to pass to the next request
                        const redirectHeaders = {};
                        if (res.headers['set-cookie']) {
                            redirectHeaders['cookie'] = res.headers['set-cookie'];
                        }

                        // Drain the response to avoid memory leaks
                        res.resume();

                        // Make sure we don't already have a response before continuing
                        if (hasResponded || reply.sent) {
                            resolve();
                            return;
                        }

                        // Small delay before following redirect to avoid rate limiting
                        setTimeout(() => {
                            resolve(performRequest(redirectUrl, redirectMethod,
                                // Don't forward body for GET requests
                                redirectMethod === 'GET' ? null : reqBody,
                                redirectCount + 1, 0, redirectHeaders));
                        }, retryDelay);
                    } else {
                        // We've reached max redirects or we're not configured to follow
                        // Pass the redirect to the client
                        if (hasResponded || reply.sent) {
                            res.resume();
                            resolve();
                            return;
                        }

                        hasResponded = true;
                        reply.status(statusCode);
                        Object.keys(res.headers).forEach(header => {
                            reply.header(header, res.headers[header]);
                        });
                        res.resume();
                        reply.send();
                        resolve();
                    }
                } else {
                    // This is not a redirect - handle normal response
                    if (hasResponded || reply.sent) {
                        res.resume();
                        resolve();
                        return;
                    }

                    const resHeaders = rewriteHeaders({ ...res.headers }, request);

                    try {
                        hasResponded = true;
                        reply.status(statusCode);
                        
                        // More robust header handling - check for invalid headers
                        Object.keys(resHeaders).forEach(header => {
                            try {
                                if (header.toLowerCase() !== 'transfer-encoding') {
                                    reply.header(header, resHeaders[header]);
                                }
                            } catch (err) {
                                request.log.warn({ header, value: resHeaders[header] }, 
                                    'Failed to set header, skipping');
                            }
                        });

                        if (replyOpts.contentType) {
                            reply.type(replyOpts.contentType);
                        }

                        if (replyOpts.rewriteBody) {
                            const chunks = [];
                            res.on('data', chunk => chunks.push(chunk));
                            res.on('end', async () => {
                                if (!reply.sent) {
                                    const buffer = Buffer.concat(chunks);
                                    const stringifiedBody = buffer.toString('utf8');
                                    try {
                                        const rewrittenBody = await replyOpts.rewriteBody(stringifiedBody, request, reply);
                                        reply.send(rewrittenBody);
                                    } catch (error) {
                                        request.log.error(error, 'Error rewriting response body');
                                        if (!reply.sent) {
                                            reply.status(500).send(error);
                                        }
                                    }
                                }
                                resolve();
                            });
                        } else {
                            const passThrough = new PassThrough();
                            res.pipe(passThrough);
                            reply.send(passThrough);
                            res.on('end', () => {
                                resolve();
                            });
                        }
                    } catch (err) {
                        request.log.error(err, 'Error while processing response');
                        if (!reply.sent) {
                            reply.status(500).send({ error: 'Proxy Error', message: err.message });
                        }
                        resolve();
                    }
                }
            });

            // Increase the timeout handling robustness
            req.setTimeout(timeoutMs, () => {
                req.destroy(new Error(`Request timeout after ${timeoutMs}ms`));
            });

            req.on('error', (error) => {
                request.log.error({
                    error: error.message,
                    stack: error.stack,
                    targetUrl,
                    method: reqMethod,
                    retryCount,
                    hasResponded,
                    replySent: reply.sent
                }, 'Proxy request error');

                // Retry logic for connection errors
                if (retryCount < maxRetries && !hasResponded && !reply.sent) {
                    request.log.info({
                        targetUrl,
                        method: reqMethod,
                        retryCount: retryCount + 1
                    }, 'Retrying proxy request after error');
                    
                    setTimeout(() => {
                        resolve(performRequest(targetUrl, reqMethod, reqBody, redirectCount, retryCount + 1, prevHeaders));
                    }, retryDelay);
                } else if (!hasResponded && !reply.sent) {
                    hasResponded = true;
                    reply.status(502).send({
                        error: 'Bad Gateway',
                        message: error.message
                    });
                    reject(error);
                } else {
                    // Already responded, just reject to end this request branch
                    reject(error);
                }
            });

            req.on('timeout', () => {
                req.destroy();
                request.log.error({
                    targetUrl,
                    method: reqMethod,
                    timeout: reqOptions.timeout,
                    retryCount,
                    hasResponded,
                    replySent: reply.sent
                }, 'Proxy request timeout');

                // Retry logic for timeouts
                if (retryCount < maxRetries && !hasResponded && !reply.sent) {
                    request.log.info({
                        targetUrl,
                        method: reqMethod,
                        retryCount: retryCount + 1
                    }, 'Retrying proxy request after timeout');
                    
                    setTimeout(() => {
                        resolve(performRequest(targetUrl, reqMethod, reqBody, redirectCount, retryCount + 1, prevHeaders));
                    }, retryDelay);
                } else if (!hasResponded && !reply.sent) {
                    hasResponded = true;
                    reply.status(504).send('Gateway Timeout');
                    reject(new Error('Gateway Timeout'));
                } else {
                    // Already responded, just reject to end this request branch
                    reject(new Error('Gateway Timeout'));
                }
            });

            // Handle body for request methods that support it
            if (reqBody && reqMethod !== 'GET' && reqMethod !== 'HEAD') {
                if (typeof reqBody.pipe === 'function') {
                    reqBody.pipe(req);
                    reqBody.on('end', () => {
                        req.end();
                    });
                } else if (reqBody) {
                    req.write(typeof reqBody === 'string' ? reqBody : JSON.stringify(reqBody));
                    req.end();
                } else {
                    req.end();
                }
            } else {
                // For GET, HEAD, and OPTIONS explicitly end the request
                req.end();
            }
        });
    };

    try {
        // Start the request chain
        return await performRequest(target, method, body, 0, 0);
    } catch (error) {
        request.log.error({
            error: error.message,
            stack: error.stack,
            target,
            hasResponded,
            replySent: reply.sent
        }, 'Proxy error');

        if (!hasResponded && !reply.sent) {
            reply.status(502).send({
                error: 'Bad Gateway',
                message: error.message || 'Unknown proxy error'
            });
        }
    }
}

module.exports = fp(fastifyHttpProxy, {
    fastify: '5.x',
    name: 'fastify-reverse-proxy',
    encapsulate: true
})
module.exports.default = fastifyHttpProxy
module.exports.fastifyHttpProxy = fastifyHttpProxy
