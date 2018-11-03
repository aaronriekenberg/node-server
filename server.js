#!/usr/bin/env node
'use strict';
Object.defineProperty(exports, "__esModule", { value: true });
const agentkeepalive = require("agentkeepalive");
const child_process = require("child_process");
const fs = require("fs");
const git = require("simple-git/promise");
const http = require("http");
const http2 = require("http2");
const mustache = require("mustache");
const util = require("util");
const v8 = require("v8");
const winston = require("winston");
const asyncExec = util.promisify(child_process.exec);
const { HTTP2_HEADER_CACHE_CONTROL, HTTP2_HEADER_CONTENT_TYPE, HTTP2_HEADER_IF_MODIFIED_SINCE, HTTP2_HEADER_LAST_MODIFIED, HTTP2_HEADER_METHOD, HTTP2_HEADER_PATH, HTTP2_HEADER_STATUS, HTTP2_METHOD_GET, HTTP_STATUS_INTERNAL_SERVER_ERROR, HTTP_STATUS_NOT_FOUND, HTTP_STATUS_NOT_MODIFIED, HTTP_STATUS_OK } = http2.constants;
const CONTENT_TYPE_APPLICATION_JSON = 'application/json';
const CONTENT_TYPE_TEXT_HTML = 'text/html';
const CONTENT_TYPE_TEXT_PLAIN = 'text/plain';
const DATE_TIME_FORMAT = 'YYYY-MM-DD[T]HH:mm:ss.SSSZZ';
const formattedDateTime = () => new Date().toString();
const logger = winston.createLogger({
    format: winston.format.combine(winston.format.timestamp({
        format: DATE_TIME_FORMAT
    }), winston.format.printf((info) => `${info.timestamp} ${info.level}: ${info.message}`)),
    transports: [new winston.transports.Console()]
});
const formatError = (err) => (err.stack || err.message);
const stringify = JSON.stringify;
const stringifyPretty = (object) => stringify(object, null, 2);
const readFileAsync = async (filePath, encoding) => {
    let fileHandle;
    try {
        fileHandle = await fs.promises.open(filePath, 'r');
        return await fileHandle.readFile({
            encoding
        });
    }
    finally {
        if (fileHandle) {
            await fileHandle.close();
        }
    }
};
let httpAgentInstance = () => {
    const instance = new agentkeepalive({
        keepAlive: true
    });
    httpAgentInstance = () => instance;
    return instance;
};
class RequestContext {
    constructor(stream, requestHeaders) {
        this.startTime = process.hrtime();
        this.stream = stream;
        this.requestHeaders = requestHeaders;
        this.streamIDString = RequestContext.buildStreamIDString(stream);
    }
    static buildStreamIDString(stream) {
        try {
            return `${stream.session.socket.remoteAddress}:${stream.session.socket.remotePort}/${stream.id}`;
        }
        catch (err) {
            return 'UNKNOWN';
        }
    }
    get requestMethod() {
        return this.requestHeaders[HTTP2_HEADER_METHOD].toString();
    }
    get requestPath() {
        return this.requestHeaders[HTTP2_HEADER_PATH].toString();
    }
    get deltaTimeSeconds() {
        const delta = process.hrtime(this.startTime);
        return delta[0] + (delta[1] / 1e9);
    }
    get streamDestroyed() {
        return this.stream.destroyed;
    }
    destroyStream() {
        try {
            if (!this.stream.destroyed) {
                this.stream.destroy();
            }
        }
        catch (err) {
            logger.error(`destroyStream error err = ${formatError(err)}`);
        }
    }
    writeResponse(responseHeaders, body) {
        try {
            if (this.streamDestroyed) {
                logger.info(`${this.streamIDString} writeResponse stream destroyed`);
                return;
            }
            if (!body) {
                this.stream.respond(responseHeaders, {
                    endStream: true
                });
            }
            else {
                this.stream.respond(responseHeaders);
                this.stream.end(body);
            }
            logger.info(`${this.streamIDString} ${this.requestMethod} ${this.requestPath} ` +
                `status=${responseHeaders[HTTP2_HEADER_STATUS]} ${this.deltaTimeSeconds}s`);
        }
        catch (err) {
            logger.error(`writeResponse error err = ${formatError(err)}`);
            this.destroyStream();
        }
    }
    respondWithFile(path, responseHeaders, options) {
        try {
            if (this.streamDestroyed) {
                logger.info(`${this.streamIDString} respondWithFile stream destroyed`);
                return;
            }
            this.stream.respondWithFile(path, responseHeaders, options);
            logger.info(`${this.streamIDString} ${this.requestMethod} ${this.requestPath} ` +
                `respondWithFile status=${responseHeaders[HTTP2_HEADER_STATUS]} ${this.deltaTimeSeconds}s`);
        }
        catch (err) {
            logger.error(`respondWithFile error err = ${formatError(err)}`);
            this.destroyStream();
        }
    }
}
class Handlers {
    static buildNotFoundHander() {
        return (requestContext) => {
            requestContext.writeResponse({
                [HTTP2_HEADER_STATUS]: HTTP_STATUS_NOT_FOUND,
                [HTTP2_HEADER_CONTENT_TYPE]: CONTENT_TYPE_TEXT_PLAIN
            }, 'Unknown request');
        };
    }
    static buildIndexHandler(template, configuration) {
        const staticFilesInMainPage = configuration.staticFileList.filter((sf) => sf.includeInMainPage);
        const indexData = {
            now: formattedDateTime(),
            staticFilesInMainPage,
            configuration
        };
        const indexHtml = mustache.render(template, indexData);
        const lastModifiedValue = new Date().toUTCString();
        const cacheControlValue = 'max-age=60';
        return (requestContext) => {
            requestContext.writeResponse({
                [HTTP2_HEADER_STATUS]: HTTP_STATUS_OK,
                [HTTP2_HEADER_CONTENT_TYPE]: CONTENT_TYPE_TEXT_HTML,
                [HTTP2_HEADER_LAST_MODIFIED]: lastModifiedValue,
                [HTTP2_HEADER_CACHE_CONTROL]: cacheControlValue
            }, indexHtml);
        };
    }
    static buildCommandHTMLHandler(template, command, apiPath) {
        const commandData = {
            apiPath,
            command
        };
        const commandHtml = mustache.render(template, commandData);
        const lastModifiedValue = new Date().toUTCString();
        const cacheControlValue = 'max-age=60';
        return (requestContext) => {
            requestContext.writeResponse({
                [HTTP2_HEADER_STATUS]: HTTP_STATUS_OK,
                [HTTP2_HEADER_CONTENT_TYPE]: CONTENT_TYPE_TEXT_HTML,
                [HTTP2_HEADER_LAST_MODIFIED]: lastModifiedValue,
                [HTTP2_HEADER_CACHE_CONTROL]: cacheControlValue
            }, commandHtml);
        };
    }
    static buildCommandAPIHandler(command) {
        return async (requestContext) => {
            let childProcess;
            let commandErr;
            try {
                childProcess = await asyncExec(command.command);
            }
            catch (err) {
                logger.error(`command err = ${formatError(err)}`);
                commandErr = err;
            }
            if (requestContext.streamDestroyed) {
                logger.info(`${requestContext.streamIDString} stream destroyed after command`);
                return;
            }
            let commandOutput;
            if (commandErr) {
                commandOutput = commandErr;
            }
            else {
                commandOutput = childProcess.stderr + childProcess.stdout;
            }
            const commandData = {
                now: formattedDateTime(),
                command,
                commandOutput
            };
            requestContext.writeResponse({
                [HTTP2_HEADER_STATUS]: HTTP_STATUS_OK,
                [HTTP2_HEADER_CONTENT_TYPE]: CONTENT_TYPE_APPLICATION_JSON
            }, stringify(commandData));
        };
    }
    static buildProxyHTMLHandler(template, proxy, apiPath) {
        const proxyData = {
            apiPath,
            proxy
        };
        const proxyHtml = mustache.render(template, proxyData);
        const lastModifiedValue = new Date().toUTCString();
        const cacheControlValue = 'max-age=60';
        return (requestContext) => {
            requestContext.writeResponse({
                [HTTP2_HEADER_STATUS]: HTTP_STATUS_OK,
                [HTTP2_HEADER_CONTENT_TYPE]: CONTENT_TYPE_TEXT_HTML,
                [HTTP2_HEADER_LAST_MODIFIED]: lastModifiedValue,
                [HTTP2_HEADER_CACHE_CONTROL]: cacheControlValue
            }, proxyHtml);
        };
    }
    static buildProxyAPIHandler(proxy) {
        return (requestContext) => {
            const proxyResponseChunks = [];
            let proxyResponseStatusCode = null;
            let proxyResponseVersion = null;
            let proxyResponseHeaders = null;
            let proxyError;
            let writeProxyResponse = () => {
                writeProxyResponse = () => { };
                if (requestContext.streamDestroyed) {
                    logger.info(`${requestContext.streamIDString} stream destroyed after proxy`);
                    return;
                }
                const proxyData = {
                    now: formattedDateTime(),
                    proxy,
                    proxyResponse: {
                        version: proxyResponseVersion,
                        statusCode: proxyResponseStatusCode,
                        headers: proxyResponseHeaders,
                        data: (proxyError || Buffer.concat(proxyResponseChunks).toString())
                    }
                };
                requestContext.writeResponse({
                    [HTTP2_HEADER_STATUS]: HTTP_STATUS_OK,
                    [HTTP2_HEADER_CONTENT_TYPE]: CONTENT_TYPE_APPLICATION_JSON
                }, stringify(proxyData));
            };
            const requestOptions = Object.assign({
                agent: httpAgentInstance()
            }, proxy.options);
            const proxyRequest = http.request(requestOptions, (proxyResponse) => {
                proxyResponseStatusCode = proxyResponse.statusCode;
                proxyResponseVersion = proxyResponse.httpVersion;
                proxyResponseHeaders = proxyResponse.headers;
                proxyResponse.on('data', (chunk) => {
                    proxyResponseChunks.push(chunk);
                });
                proxyResponse.on('end', () => {
                    writeProxyResponse();
                });
            });
            proxyRequest.on('error', (err) => {
                logger.error(`proxy err = ${formatError(err)}`);
                proxyError = err;
                writeProxyResponse();
            });
            proxyRequest.end();
        };
    }
    static buildStaticFileHandler(staticFile) {
        return (requestContext) => {
            const statCheck = (stat, statResponseHeaders) => {
                try {
                    // resolution for http headers is 1 second
                    stat.mtime.setMilliseconds(0);
                    statResponseHeaders[HTTP2_HEADER_LAST_MODIFIED] = stat.mtime.toUTCString();
                    const ifModifiedSinceString = requestContext.requestHeaders[HTTP2_HEADER_IF_MODIFIED_SINCE];
                    if (ifModifiedSinceString) {
                        const ifModifiedSinceDate = new Date(ifModifiedSinceString);
                        if (stat.mtime.getTime() === ifModifiedSinceDate.getTime()) {
                            statResponseHeaders[HTTP2_HEADER_STATUS] = HTTP_STATUS_NOT_MODIFIED;
                            requestContext.writeResponse(statResponseHeaders);
                            return false;
                        }
                    }
                }
                catch (err) {
                    logger.error(`statCheck error err = ${formatError(err)}`);
                }
                return true;
            };
            const onError = (err) => {
                logger.error(`file onError err = ${formatError(err)}`);
                if (err.code === 'ENOENT') {
                    requestContext.writeResponse({
                        [HTTP2_HEADER_STATUS]: HTTP_STATUS_NOT_FOUND,
                        [HTTP2_HEADER_CONTENT_TYPE]: CONTENT_TYPE_TEXT_PLAIN
                    }, 'File not found');
                }
                else {
                    requestContext.writeResponse({
                        [HTTP2_HEADER_STATUS]: HTTP_STATUS_INTERNAL_SERVER_ERROR,
                        [HTTP2_HEADER_CONTENT_TYPE]: CONTENT_TYPE_TEXT_PLAIN
                    }, 'Error reading file');
                }
            };
            const responseHeaders = Object.assign({
                [HTTP2_HEADER_STATUS]: HTTP_STATUS_OK
            }, staticFile.headers);
            requestContext.respondWithFile(staticFile.filePath, responseHeaders, {
                statCheck,
                onError
            });
        };
    }
    static buildHttpAgentStatusHandler() {
        return (requestContext) => {
            const statusJson = stringifyPretty(httpAgentInstance().getCurrentStatus());
            requestContext.writeResponse({
                [HTTP2_HEADER_STATUS]: HTTP_STATUS_OK,
                [HTTP2_HEADER_CONTENT_TYPE]: CONTENT_TYPE_TEXT_PLAIN
            }, statusJson);
        };
    }
    static buildConfigurationHandler(configuration) {
        const configurationJson = stringifyPretty(configuration);
        return (requestContext) => {
            requestContext.writeResponse({
                [HTTP2_HEADER_STATUS]: HTTP_STATUS_OK,
                [HTTP2_HEADER_CONTENT_TYPE]: CONTENT_TYPE_TEXT_PLAIN
            }, configurationJson);
        };
    }
    static buildV8StatsHander() {
        return (requestContext) => {
            const v8Stats = {
                heapStatistics: v8.getHeapStatistics(),
                heapSpaceStatistics: v8.getHeapSpaceStatistics(),
            };
            const statusText = stringifyPretty(v8Stats);
            requestContext.writeResponse({
                [HTTP2_HEADER_STATUS]: HTTP_STATUS_OK,
                [HTTP2_HEADER_CONTENT_TYPE]: CONTENT_TYPE_TEXT_PLAIN
            }, statusText);
        };
    }
}
class AsyncServer {
    constructor(configuration, templates) {
        this.configuration = configuration;
        this.notFoundHandler = Handlers.buildNotFoundHander();
        this.pathToHandler = new Map();
        const setOrThrow = (key, value) => {
            if (this.pathToHandler.has(key)) {
                throw new Error(`duplicate path key ${key}`);
            }
            this.pathToHandler.set(key, value);
        };
        setOrThrow('/', Handlers.buildIndexHandler(templates.index, this.configuration));
        (this.configuration.commandList || []).forEach((command) => {
            const apiPath = `/api/commands${command.httpPath}`;
            setOrThrow(command.httpPath, Handlers.buildCommandHTMLHandler(templates.command, command, apiPath));
            setOrThrow(apiPath, Handlers.buildCommandAPIHandler(command));
        });
        (this.configuration.proxyList || []).forEach((proxy) => {
            const apiPath = `/api/proxies${proxy.httpPath}`;
            setOrThrow(proxy.httpPath, Handlers.buildProxyHTMLHandler(templates.proxy, proxy, apiPath));
            setOrThrow(apiPath, Handlers.buildProxyAPIHandler(proxy));
        });
        if (this.configuration.proxyList) {
            setOrThrow('/http_agent_status', Handlers.buildHttpAgentStatusHandler());
        }
        (this.configuration.staticFileList || []).forEach((staticFile) => setOrThrow(staticFile.httpPath, Handlers.buildStaticFileHandler(staticFile)));
        setOrThrow('/configuration', Handlers.buildConfigurationHandler(this.configuration));
        setOrThrow('/v8_stats', Handlers.buildV8StatsHander());
        logger.info(`pathToHandler.size = ${this.pathToHandler.size}`);
    }
    async createHttpServer() {
        const httpServerConfig = {
            key: null,
            cert: null
        };
        [httpServerConfig.key, httpServerConfig.cert] = await Promise.all([
            readFileAsync(this.configuration.tlsKeyFile),
            readFileAsync(this.configuration.tlsCertFile)
        ]);
        return http2.createSecureServer(httpServerConfig);
    }
    async start() {
        const httpServer = await this.createHttpServer();
        httpServer.on('error', (err) => logger.error(`httpServer error err = ${formatError(err)}`));
        httpServer.on('listening', () => logger.info(`httpServer listening on ${stringify(httpServer.address())}`));
        httpServer.on('stream', (stream, headers) => {
            const requestContext = new RequestContext(stream, headers);
            const handler = (((requestContext.requestMethod === HTTP2_METHOD_GET) &&
                (this.pathToHandler.get(requestContext.requestPath))) ||
                this.notFoundHandler);
            handler(requestContext);
        });
        httpServer.listen({
            host: this.configuration.listenAddress,
            port: this.configuration.listenPort
        });
    }
}
const getGitHash = async () => {
    logger.info('getGitHash');
    const gitLog = await git('.').log(['-1']);
    return gitLog.latest.hash;
};
const readConfiguration = async (configFilePath) => {
    logger.info(`readConfiguration '${configFilePath}'`);
    const [fileContent, gitHash] = await Promise.all([
        readFileAsync(configFilePath, 'utf8'),
        getGitHash()
    ]);
    const configuration = JSON.parse(fileContent.toString());
    configuration.gitHash = gitHash;
    configuration.NODE_ENV = process.env.NODE_ENV;
    return configuration;
};
const readTemplates = async () => {
    logger.info('readTemplates');
    const templates = {
        command: null,
        index: null,
        proxy: null
    };
    [templates.command, templates.index, templates.proxy] = await Promise.all([
        readFileAsync('templates/command.mustache', 'utf8'),
        readFileAsync('templates/index.mustache', 'utf8'),
        readFileAsync('templates/proxy.mustache', 'utf8')
    ]);
    Object.values(templates).forEach((v) => mustache.parse(v));
    return templates;
};
const main = async () => {
    if (process.argv.length !== 3) {
        throw new Error('config json path required as command line argument');
    }
    const [configuration, templates] = await Promise.all([
        readConfiguration(process.argv[2]),
        readTemplates()
    ]);
    logger.info(`configuration = ${stringifyPretty(configuration)}`);
    const asyncServer = new AsyncServer(configuration, templates);
    await asyncServer.start();
};
main().catch((err) => {
    logger.error(`main error err = ${formatError(err)}`);
    process.exit(1);
});
