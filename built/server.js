#!/usr/bin/env node
"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    Object.defineProperty(o, k2, { enumerable: true, get: function() { return m[k]; } });
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const agentkeepalive_1 = __importDefault(require("agentkeepalive"));
const child_process = __importStar(require("child_process"));
const fs = __importStar(require("fs"));
const promise_1 = __importDefault(require("simple-git/promise"));
const http = __importStar(require("http"));
const http2 = __importStar(require("http2"));
const mustache_1 = __importDefault(require("mustache"));
const util = __importStar(require("util"));
const v8 = __importStar(require("v8"));
const winston = __importStar(require("winston"));
const asyncExec = util.promisify(child_process.exec);
const { HTTP2_HEADER_CONTENT_TYPE, HTTP2_HEADER_IF_MODIFIED_SINCE, HTTP2_HEADER_LAST_MODIFIED, HTTP2_HEADER_METHOD, HTTP2_HEADER_PATH, HTTP2_HEADER_STATUS, HTTP2_METHOD_GET, HTTP_STATUS_INTERNAL_SERVER_ERROR, HTTP_STATUS_NOT_FOUND, HTTP_STATUS_NOT_MODIFIED, HTTP_STATUS_OK } = http2.constants;
const CONTENT_TYPE_APPLICATION_JSON = 'application/json';
const CONTENT_TYPE_TEXT_PLAIN = 'text/plain';
const formattedDateTime = () => new Date().toString();
const LOG_DATE_TIME_FORMAT = 'YYYY-MM-DD[T]HH:mm:ss.SSSZZ';
const logger = winston.createLogger({
    format: winston.format.combine(winston.format.timestamp({
        format: LOG_DATE_TIME_FORMAT
    }), winston.format.printf((info) => `${info.timestamp} ${info.level}: ${info.message}`)),
    transports: [new winston.transports.Console()]
});
const formatError = (err, includeStack = true) => {
    return ((includeStack && err.stack) || err.message);
};
const stringify = JSON.stringify;
const stringifyPretty = (object) => stringify(object, null, 2);
const UTF8 = 'utf8';
const asyncReadFile = async (filePath, encoding) => {
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
    const instance = new agentkeepalive_1.default({
        keepAlive: true
    });
    httpAgentInstance = () => instance;
    return instance;
};
const headerToString = (header) => {
    let retVal;
    if (typeof header === 'string') {
        retVal = header;
    }
    else if ((Array.isArray(header)) && (header.length > 0)) {
        retVal = header[0];
    }
    return retVal;
};
const cloneHeaders = (headers) => {
    return Object.assign({}, headers);
};
class RequestContext {
    stream;
    requestHeaders;
    startTime;
    streamIDString;
    requestMethod;
    requestPath;
    constructor(stream, requestHeaders) {
        this.stream = stream;
        this.requestHeaders = requestHeaders;
        this.startTime = process.hrtime();
        this.streamIDString = RequestContext.buildStreamIDString(stream);
        this.requestMethod = headerToString(this.requestHeaders[HTTP2_HEADER_METHOD]);
        this.requestPath = headerToString(this.requestHeaders[HTTP2_HEADER_PATH]);
        stream.on('error', (err) => {
            logger.error(`${this.streamIDString} stream error event err = ${formatError(err)}`);
            this.destroyStream();
        });
    }
    static buildStreamIDString(stream) {
        try {
            return `${stream.session.socket.remoteAddress}:${stream.session.socket.remotePort}/${stream.id}`;
        }
        catch (err) {
            return 'UNKNOWN';
        }
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
        const headers = {
            [HTTP2_HEADER_STATUS]: HTTP_STATUS_NOT_FOUND,
            [HTTP2_HEADER_CONTENT_TYPE]: CONTENT_TYPE_TEXT_PLAIN
        };
        return (requestContext) => {
            requestContext.writeResponse(cloneHeaders(headers), 'Unknown request');
        };
    }
    static buildIndexHandler(indexTemplate, configuration, environment) {
        const staticFilesInMainPage = (configuration.staticFileList || []).filter((sf) => sf.includeInMainPage);
        const indexData = {
            now: formattedDateTime(),
            staticFilesInMainPage,
            configuration,
            environment
        };
        const indexHtml = mustache_1.default.render(indexTemplate, indexData);
        const headers = Object.assign({
            [HTTP2_HEADER_STATUS]: HTTP_STATUS_OK,
            [HTTP2_HEADER_LAST_MODIFIED]: new Date().toUTCString()
        }, configuration.templatePageHeaders);
        return (requestContext) => {
            requestContext.writeResponse(cloneHeaders(headers), indexHtml);
        };
    }
    static buildCommandHTMLHandler(commandTemplate, configuration, command, apiPath) {
        const commandData = {
            apiPath,
            command
        };
        const commandHtml = mustache_1.default.render(commandTemplate, commandData);
        const headers = Object.assign({
            [HTTP2_HEADER_STATUS]: HTTP_STATUS_OK,
            [HTTP2_HEADER_LAST_MODIFIED]: new Date().toUTCString()
        }, configuration.templatePageHeaders);
        return (requestContext) => {
            requestContext.writeResponse(cloneHeaders(headers), commandHtml);
        };
    }
    static buildCommandAPIHandler(command, commandConfiguration) {
        return async (requestContext) => {
            let childProcess;
            let commandErr;
            try {
                childProcess = await asyncExec(command.command, { timeout: commandConfiguration.timeoutMilliseconds });
            }
            catch (err) {
                logger.error(`command err = ${formatError(err)}`);
                commandErr = err;
            }
            if (requestContext.streamDestroyed) {
                logger.info(`${requestContext.streamIDString} stream destroyed after command`);
                return;
            }
            let commandOutput = '';
            if (commandErr) {
                commandOutput = commandErr.toString();
            }
            else if (childProcess) {
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
    static buildProxyHTMLHandler(proxyTemplate, configuration, proxy, apiPath) {
        const proxyData = {
            apiPath,
            proxy
        };
        const proxyHtml = mustache_1.default.render(proxyTemplate, proxyData);
        const headers = Object.assign({
            [HTTP2_HEADER_STATUS]: HTTP_STATUS_OK,
            [HTTP2_HEADER_LAST_MODIFIED]: new Date().toUTCString()
        }, configuration.templatePageHeaders);
        return (requestContext) => {
            requestContext.writeResponse(cloneHeaders(headers), proxyHtml);
        };
    }
    static buildProxyAPIHandler(proxy) {
        return (requestContext) => {
            const proxyResponseChunks = [];
            let proxyResponseStatusCode;
            let proxyResponseVersion;
            let proxyResponseHeaders;
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
                    const ifModifiedSinceString = headerToString(requestContext.requestHeaders[HTTP2_HEADER_IF_MODIFIED_SINCE]);
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
        const headers = {
            [HTTP2_HEADER_STATUS]: HTTP_STATUS_OK,
            [HTTP2_HEADER_CONTENT_TYPE]: CONTENT_TYPE_TEXT_PLAIN
        };
        return (requestContext) => {
            const statusJson = stringifyPretty(httpAgentInstance().getCurrentStatus());
            requestContext.writeResponse(cloneHeaders(headers), statusJson);
        };
    }
    static buildConfigurationHandler(configuration) {
        const configurationJson = stringifyPretty(configuration);
        const headers = {
            [HTTP2_HEADER_STATUS]: HTTP_STATUS_OK,
            [HTTP2_HEADER_CONTENT_TYPE]: CONTENT_TYPE_TEXT_PLAIN
        };
        return (requestContext) => {
            requestContext.writeResponse(cloneHeaders(headers), configurationJson);
        };
    }
    static buildEnvironmentHandler(environment) {
        const environmentJson = stringifyPretty(environment);
        const headers = {
            [HTTP2_HEADER_STATUS]: HTTP_STATUS_OK,
            [HTTP2_HEADER_CONTENT_TYPE]: CONTENT_TYPE_TEXT_PLAIN
        };
        return (requestContext) => {
            requestContext.writeResponse(cloneHeaders(headers), environmentJson);
        };
    }
    static buildV8StatsHander() {
        const headers = {
            [HTTP2_HEADER_STATUS]: HTTP_STATUS_OK,
            [HTTP2_HEADER_CONTENT_TYPE]: CONTENT_TYPE_TEXT_PLAIN
        };
        return (requestContext) => {
            const v8Stats = {
                heapStatistics: v8.getHeapStatistics(),
                heapSpaceStatistics: v8.getHeapSpaceStatistics(),
            };
            const statusText = stringifyPretty(v8Stats);
            requestContext.writeResponse(cloneHeaders(headers), statusText);
        };
    }
}
class AsyncServer {
    configuration;
    notFoundHandler;
    pathToHandler;
    constructor(configuration, environment, templates) {
        this.configuration = configuration;
        this.notFoundHandler = Handlers.buildNotFoundHander();
        this.pathToHandler = new Map();
        const setOrThrow = (key, value) => {
            if (this.pathToHandler.has(key)) {
                throw new Error(`duplicate path key ${key}`);
            }
            this.pathToHandler.set(key, value);
        };
        setOrThrow('/', Handlers.buildIndexHandler(templates.indexTemplate, configuration, environment));
        (this.configuration.commandList || []).forEach((command) => {
            const apiPath = `/api/commands/${command.id}`;
            const htmlPath = `/commands/${command.id}.html`;
            setOrThrow(htmlPath, Handlers.buildCommandHTMLHandler(templates.commandTemplate, configuration, command, apiPath));
            setOrThrow(apiPath, Handlers.buildCommandAPIHandler(command, this.configuration.commandConfiguration));
        });
        (this.configuration.proxyList || []).forEach((proxy) => {
            const apiPath = `/api/proxies/${proxy.id}`;
            const htmlPath = `/proxies/${proxy.id}.html`;
            setOrThrow(htmlPath, Handlers.buildProxyHTMLHandler(templates.proxyTemplate, configuration, proxy, apiPath));
            setOrThrow(apiPath, Handlers.buildProxyAPIHandler(proxy));
        });
        if (this.configuration.proxyList) {
            setOrThrow('/http_agent_status', Handlers.buildHttpAgentStatusHandler());
        }
        (this.configuration.staticFileList || []).forEach((staticFile) => setOrThrow(staticFile.httpPath, Handlers.buildStaticFileHandler(staticFile)));
        setOrThrow('/configuration', Handlers.buildConfigurationHandler(configuration));
        setOrThrow('/environment', Handlers.buildEnvironmentHandler(environment));
        setOrThrow('/v8_stats', Handlers.buildV8StatsHander());
        logger.info(`pathToHandler.size = ${this.pathToHandler.size}`);
    }
    async createHttpServer() {
        const [key, cert] = await Promise.all([
            asyncReadFile(this.configuration.tlsKeyFile),
            asyncReadFile(this.configuration.tlsCertFile)
        ]);
        const httpServerConfig = {
            key,
            cert
        };
        return http2.createSecureServer(httpServerConfig);
    }
    async start() {
        const httpServer = await this.createHttpServer();
        httpServer.on('error', (err) => logger.error(`httpServer error err = ${formatError(err)}`));
        httpServer.on('sessionError', (err) => logger.error(`httpServer session error err = ${formatError(err, false)}`));
        httpServer.on('listening', () => logger.info(`httpServer listening on ${stringify(httpServer.address())}`));
        httpServer.on('stream', (stream, headers) => {
            const requestContext = new RequestContext(stream, headers);
            const handler = (((requestContext.requestMethod === HTTP2_METHOD_GET) &&
                (this.pathToHandler.get(requestContext.requestPath))) ||
                this.notFoundHandler);
            handler(requestContext);
        });
        const listenOptions = {
            host: this.configuration.listenAddress,
            port: this.configuration.listenPort
        };
        httpServer.listen(listenOptions);
    }
}
const readConfiguration = async (configFilePath) => {
    logger.info(`readConfiguration '${configFilePath}'`);
    const fileContent = await asyncReadFile(configFilePath, UTF8);
    const configuration = JSON.parse(fileContent.toString());
    return configuration;
};
const getGitCommit = async () => {
    logger.info('getGitCommit');
    const gitLog = await promise_1.default('.').log(['-1']);
    return gitLog.latest;
};
const getEnvironment = async () => {
    logger.info('getEnvironment');
    const gitCommit = await getGitCommit();
    const environment = {
        gitCommit,
        argv: process.argv,
        env: process.env,
        arch: process.arch,
        platform: process.platform,
        versions: process.versions
    };
    return environment;
};
const readTemplates = async () => {
    logger.info('readTemplates');
    const [indexTemplate, commandTemplate, proxyTemplate] = await Promise.all([
        asyncReadFile('templates/index.mustache', UTF8),
        asyncReadFile('templates/command.mustache', UTF8),
        asyncReadFile('templates/proxy.mustache', UTF8)
    ]);
    const templates = {
        indexTemplate: indexTemplate.toString(),
        commandTemplate: commandTemplate.toString(),
        proxyTemplate: proxyTemplate.toString()
    };
    Object.values(templates).forEach((t) => mustache_1.default.parse(t));
    return templates;
};
const main = async () => {
    if (process.argv.length !== 3) {
        throw new Error('config json path required as command line argument');
    }
    const [configuration, environment, templates] = await Promise.all([
        readConfiguration(process.argv[2]),
        getEnvironment(),
        readTemplates()
    ]);
    const asyncServer = new AsyncServer(configuration, environment, templates);
    await asyncServer.start();
};
main().catch((err) => {
    logger.error(`main error err = ${formatError(err)}`);
    process.exit(1);
});
