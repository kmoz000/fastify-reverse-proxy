# Fastify HTTP Proxy Plugin

A Fastify plugin to proxy HTTP and WebSocket requests to an upstream server.

## Table of Contents

- [Fastify HTTP Proxy Plugin](#fastify-http-proxy-plugin)
  - [Table of Contents](#table-of-contents)
  - [Features](#features)
  - [Installation](#installation)
  - [Usage](#usage)
    - [Basic HTTP Proxy](#basic-http-proxy)
    - [WebSocket Proxy](#websocket-proxy)
    - [Options](#options)
  - [Advanced Usage](#advanced-usage)
    - [Rewriting the request](#rewriting-the-request)
    - [Upstream selection](#upstream-selection)
    - [Rewriting the response body](#rewriting-the-response-body)
  - [License](#license)

## Features

-   HTTP proxying with support for various HTTP methods (GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS).
-   WebSocket proxying.
-   Customizable request and response transformations.
-   Support for upstream selection based on request context.
-   Automatic handling of WebSocket upgrades.

## Installation

```bash
npm install fastify-http-proxy
```

## Usage

### Basic HTTP Proxy

```javascript
const Fastify = require('fastify')
const fastifyHttpProxy = require('fastify-http-proxy')

const fastify = Fastify({ logger: true })

fastify.register(fastifyHttpProxy, {
  upstream: 'http://localhost:3001',
  httpMethods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'] // Optional: Define the allowed HTTP methods
})

fastify.get('/', async (request, reply) => {
  reply.send({ hello: 'world' })
})

fastify.listen({ port: 3000 }, err => {
  if (err) {
    fastify.log.error(err)
    process.exit(1)
  }
})
```

This example proxies all requests to `/` and `/*` to the upstream server running on `http://localhost:3001`.

### WebSocket Proxy

To enable WebSocket proxying, set the `websocket` option to `true`.

```javascript
const Fastify = require('fastify')
const fastifyHttpProxy = require('fastify-http-proxy')

const fastify = Fastify({ logger: true })

fastify.register(fastifyHttpProxy, {
  upstream: 'http://localhost:3001',
  websocket: true
})

fastify.get('/', async (request, reply) => {
  reply.send({ hello: 'world' })
})

fastify.listen({ port: 3000 }, err => {
  if (err) {
    fastify.log.error(err)
    process.exit(1)
  }
})
```

This example proxies all WebSocket connections to the upstream server.  Make sure the upstream server is configured to handle WebSocket connections.

### Options

*   `upstream`: (required) The URL of the upstream server.
*   `wsUpstream`: (optional) The URL of the upstream WebSocket server. If not provided, `upstream` will be used for WebSocket connections.
*   `websocket`: (optional) Enable WebSocket proxying. Default: `false`.
*   `httpMethods`: (optional) An array of HTTP methods to proxy. Default: `['DELETE', 'GET', 'HEAD', 'PATCH', 'POST', 'PUT', 'OPTIONS']`.
*   `preHandler`: (optional) A function or an array of functions that will be executed before the request is proxied.  It works the same way as Fastify's `preHandler` hook.
*   `beforeHandler`: (optional) Alias for `preHandler`.
*   `config`: (optional) An object containing custom configuration options.
*   `constraints`: (optional) An object containing constraints for the route.
*   `rewritePrefix`: (optional) A string to rewrite the prefix of the incoming request URL. Default: `/`.
*   `internalRewriteLocationHeader`: (optional) A boolean to rewrite the Location header of internal redirects. Default: `true`.
*   `replyOptions`: (optional) An object containing options for the reply.
    *   `rewriteHeaders`: (optional) A function that allows you to rewrite the headers of the response.
    *   `rewriteBody`: (optional) A function that allows you to rewrite the body of the response.
    *   `getUpstream`: (optional) A function that allows you to dynamically determine the upstream URL based on the request.
    *   `contentType`: (optional) A string to set the content type of the reply.
    *   `timeout`: (optional) A number representing the timeout in milliseconds for the proxy request. Default: `30000`.
*   `proxyPayloads`: (optional) A boolean to determine whether or not to parse the body. Default: `true`.  If set to false, you must handle body parsing in a `preHandler` hook.
*   `wsServerOptions`: (optional) An object containing options for the WebSocket server. See [ws](https://github.com/websockets/ws/blob/HEAD/doc/ws.md#new-websocketserveroptions) for available options.
*   `wsClientOptions`: (optional) An object containing options for the WebSocket client. See [ws](https://github.com/websockets/ws/blob/HEAD/doc/ws.md#new-websocketaddress-protocols-options) for available options.
    *   `rewriteRequestHeaders`: (optional) A function that allows you to rewrite the headers of the WebSocket client request.
    *   `headers`: (optional) An object containing headers to be added to the WebSocket client request.
*   `queryString`: (optional) Options for querystring parsing. It can be an object to be stringified or a function.

## Advanced Usage

### Rewriting the request

You can use the `rewritePrefix` option to rewrite the prefix of the incoming request URL.

For example, if you want to proxy requests to `/api/users` to `http://localhost:3001/users`, you can use the following configuration:

```javascript
fastify.register(fastifyHttpProxy, {
  upstream: 'http://localhost:3001',
  prefix: '/api/users',
  rewritePrefix: '/users'
})
```

### Upstream selection

You can use the `replyOptions.getUpstream` option to dynamically determine the upstream URL based on the request.

```javascript
fastify.register(fastifyHttpProxy, {
  upstream: 'http://localhost:3001',
  replyOptions: {
    getUpstream: (req, base) => {
      if (req.headers['x-version'] === 'v2') {
        return 'http://localhost:3002'
      }
      return base
    }
  }
})
```

### Rewriting the response body

You can use the `replyOptions.rewriteBody` option to rewrite the body of the response.

```javascript
fastify.register(fastifyHttpProxy, {
  upstream: 'http://localhost:3001',
  replyOptions: {
    rewriteBody: async (body, req, reply) => {
      const json = JSON.parse(body)
      json.message = 'Hello from the proxy!'
      return JSON.stringify(json)
    }
  }
})
```

## License

MIT
