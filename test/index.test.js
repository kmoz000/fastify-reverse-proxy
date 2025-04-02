'use strict'

const Fastify = require('fastify')
const fastifyHttpProxy = require('../index')
const http = require('http');
const https = require('https');

describe('fastify-http-proxy', () => {
    let targetServer

    beforeAll(async () => {
        targetServer = http.createServer((req, res) => {
            
            if (req.method === 'OPTIONS') {
                // Handle OPTIONS request
                res.writeHead(200, {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
                    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
                })
                res.end()
                return
            }
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ method: req.method, url: req.url, headers: req.headers }))
        })

        await new Promise((resolve) => {
            targetServer.listen(3000, () => {
                resolve()
            })
        })
    })

    afterAll(async () => {
        await new Promise((resolve, reject) => {
            targetServer.close((err) => {
                if (err) {
                    reject(err)
                    return
                }
                resolve()
            })
        })
    })

    it('should proxy requests to the target server', async () => {
        const fastify = Fastify()
        fastify.register(fastifyHttpProxy, {
            upstream: 'http://localhost:3000'
        })

        const response = await fastify.inject({
            method: 'GET',
            url: '/'
        })

        expect(response.statusCode).toBe(200)
        expect(JSON.parse(response.payload).method).toBe('GET')
    })

    it('should proxy requests with custom headers', async () => {
        const fastify = Fastify()
        fastify.register(fastifyHttpProxy, {
            upstream: 'http://localhost:3000'
        })

        const response = await fastify.inject({
            method: 'GET',
            url: '/',
            headers: {
                'x-custom-header': 'test'
            }
        })

        expect(response.statusCode).toBe(200)
        expect(JSON.parse(response.payload).headers['x-custom-header']).toBe('test')
    })

    it('should proxy requests with query parameters', async () => {
        const fastify = Fastify()
        fastify.register(fastifyHttpProxy, {
            upstream: 'http://localhost:3000'
        })

        const response = await fastify.inject({
            method: 'GET',
            url: '/?param1=value1&param2=value2'
        })

        expect(response.statusCode).toBe(200)
        expect(JSON.parse(response.payload).url).toBe('/?param1=value1&param2=value2')
    })

    it('should proxy POST requests with a body', async () => {
        const fastify = Fastify()
        fastify.register(fastifyHttpProxy, {
            upstream: 'http://localhost:3000'
        })

        const response = await fastify.inject({
            method: 'POST',
            url: '/',
            payload: {
                key: 'value'
            }
        })

        expect(response.statusCode).toBe(200)
        // Depending on how the target server handles the body, you might need to adjust this expectation
        expect(JSON.parse(response.payload).method).toBe('POST')
    })
    const methods = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']

    for (const method of methods) {
        it(`should handle ${method} method`, async () => {
            const fastify = Fastify()
            fastify.register(fastifyHttpProxy, {
                upstream: 'http://localhost:3000'
            })

            const response = await fastify.inject({
                method: method,
                url: '/'
            })
            
            expect(response.statusCode).toBe(200)
            if(method != 'OPTIONS') expect(JSON.parse(response.payload).method).toBe(method)
        })
    }
})
