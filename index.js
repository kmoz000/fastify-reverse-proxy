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
    delete proxyHeaders['host'];

    // Inject parameters into the path
    let path = url.pathname;
    for (const [name, value] of Object.entries(params)) {
        path = path.replace(`:${name}`, value);
    }

    // Append query parameters
    let queryString = url.search;
    if (query && Object.keys(query).length > 0) {
        const newQueryString = qs.stringify(query);
        queryString = queryString ? `${queryString}&${newQueryString}` : `?${newQueryString}`;
    }

    const options = {
        method: method,
        headers: proxyHeaders,
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: path + queryString, // Use the modified path and query string
        timeout: replyOpts.timeout || 30000,
    };

    // Special handling for OPTIONS requests
    if (method === 'OPTIONS' && replyOpts.preflightHandler) {
        return replyOpts.preflightHandler(request, reply);
    }

    return new Promise((resolve, reject) => {
        const req = (isHttps ? https : http).request(options, (res) => {
            const statusCode = res.statusCode || 500;
            const resHeaders = rewriteHeaders({ ...res.headers }, request);

            reply.status(statusCode);
            Object.keys(resHeaders).forEach(header => {
                reply.header(header, resHeaders[header]);
            });

            if (replyOpts.contentType) {
                reply.type(replyOpts.contentType);
            }

            if (replyOpts.rewriteBody) {
                const chunks = [];
                res.on('data', chunk => chunks.push(chunk));
                res.on('end', async () => {
                    const buffer = Buffer.concat(chunks);
                    const stringifiedBody = buffer.toString('utf8');
                    try {
                        const rewrittenBody = await replyOpts.rewriteBody(stringifiedBody, request, reply);
                        reply.send(rewrittenBody);
                    } catch (error) {
                        reply.status(500).send(error);
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
        });

        req.on('error', (error) => {
            console.error('Proxy request error:', error);
            if (!reply.sent) {
                reply.status(500).send(error.message || 'Proxy error');
            }
            reject(error);
        });

        req.on('timeout', () => {
            req.destroy();
            if (!reply.sent) {
                reply.status(504).send('Gateway Timeout');
            }
            reject(new Error('Gateway Timeout'));
        });

        // Handle body for request methods that support it
        if (body && method !== 'GET' && method !== 'HEAD') {
            if (typeof body.pipe === 'function') {
                body.pipe(req);
                body.on('end', () => {
                    req.end();
                });
            } else if (body) {
                req.write(typeof body === 'string' ? body : JSON.stringify(body));
                req.end();
            } else {
                req.end();
            }
        } else {
            // For GET, HEAD, and OPTIONS explicitly end the request
            req.end();
        }
    });
}

module.exports = fp(fastifyHttpProxy, {
    fastify: '5.x',
    name: '@fastify/http-proxy',
    encapsulate: true
})
module.exports.default = fastifyHttpProxy
module.exports.fastifyHttpProxy = fastifyHttpProxy
