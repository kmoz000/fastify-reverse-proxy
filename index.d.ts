import { FastifyPlugin, FastifyRequest, FastifyReply } from 'fastify';
import { ServerOptions, ClientOptions } from 'ws';

export interface FastifyHttpProxyOptions {
    upstream?: string;
    wsUpstream?: string;
    httpMethods?: string[];
    preHandler?: (request: FastifyRequest, reply: FastifyReply, done: (err?: Error) => void) => void;
    beforeHandler?: (request: FastifyRequest, reply: FastifyReply, done: (err?: Error) => void) => void;
    config?: any;
    constraints?: any;
    websocket?: boolean;
    wsServerOptions?: ServerOptions;
    wsClientOptions?: ClientOptions;
    replyOptions?: {
        rewriteHeaders?: (headers: any, req: FastifyRequest) => any;
        getUpstream?: (request: FastifyRequest, defaultUpstream: string) => string;
        contentType?: string;
        rewriteBody?: (body: string, request: FastifyRequest, reply: FastifyReply) => Promise<string> | string;
        timeout?: number;
    };
    rewritePrefix?: string;
    internalRewriteLocationHeader?: boolean;
    preValidation?: (request: FastifyRequest, reply: FastifyReply, done: (err?: Error) => void) => void;
    proxyPayloads?: boolean;
    queryString?:
    | string
    | { [key: string]: string | number | boolean }
    | ((search: string, reqUrl: string, request: FastifyRequest) => string);
}

declare const fastifyHttpProxy: FastifyPlugin<FastifyHttpProxyOptions>;

export { fastifyHttpProxy };

export default fastifyHttpProxy;
