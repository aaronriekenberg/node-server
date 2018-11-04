#!/usr/bin/env node

'use strict';

import * as agentkeepalive from 'agentkeepalive'
import * as child_process from 'child_process'
import * as fs from 'fs'
import * as git from 'simple-git/promise'
import * as http from 'http'
import * as http2 from 'http2'
import * as mustache from 'mustache'
import * as util from 'util'
import * as v8 from 'v8'
import * as winston from 'winston'

const asyncExec = util.promisify(child_process.exec);

const {
  HTTP2_HEADER_CACHE_CONTROL,
  HTTP2_HEADER_CONTENT_TYPE,
  HTTP2_HEADER_IF_MODIFIED_SINCE,
  HTTP2_HEADER_LAST_MODIFIED,
  HTTP2_HEADER_METHOD,
  HTTP2_HEADER_PATH,
  HTTP2_HEADER_STATUS,
  HTTP2_METHOD_GET,
  HTTP_STATUS_INTERNAL_SERVER_ERROR,
  HTTP_STATUS_NOT_FOUND,
  HTTP_STATUS_NOT_MODIFIED,
  HTTP_STATUS_OK
} = http2.constants;

const CONTENT_TYPE_APPLICATION_JSON = 'application/json';
const CONTENT_TYPE_TEXT_HTML = 'text/html';
const CONTENT_TYPE_TEXT_PLAIN = 'text/plain';

const DATE_TIME_FORMAT = 'YYYY-MM-DD[T]HH:mm:ss.SSSZZ';

const formattedDateTime = () => new Date().toString();

const logger = winston.createLogger({
  format: winston.format.combine(
    winston.format.timestamp({
      format: DATE_TIME_FORMAT
    }),
    winston.format.printf((info) => `${info.timestamp} ${info.level}: ${info.message}`)
  ),
  transports: [new winston.transports.Console()]
});

const formatError = (err) => (err.stack || err.message);

const stringify = JSON.stringify;
const stringifyPretty = (object) => stringify(object, null, 2);

const readFileAsync = async (filePath: string, encoding?: string) => {
  let fileHandle: fs.promises.FileHandle;
  try {
    fileHandle = await fs.promises.open(filePath, 'r');
    const fileContent = await fileHandle.readFile({
      encoding
    });
    return fileContent.toString();
  } finally {
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
  private readonly startTime: [number, number];
  private readonly stream: http2.ServerHttp2Stream;
  readonly requestHeaders: http2.IncomingHttpHeaders;
  readonly streamIDString: string;

  constructor(stream: http2.ServerHttp2Stream, requestHeaders: http2.IncomingHttpHeaders) {
    this.startTime = process.hrtime();
    this.stream = stream;
    this.requestHeaders = requestHeaders;
    this.streamIDString = RequestContext.buildStreamIDString(stream);
  }

  static buildStreamIDString(stream: http2.ServerHttp2Stream) {
    try {
      // XXX id is not part of ServerHttp2Stream
      return `${stream.session.socket.remoteAddress}:${stream.session.socket.remotePort}/${(stream as any).id}`;
    } catch (err) {
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
    } catch (err) {
      logger.error(`destroyStream error err = ${formatError(err)}`);
    }
  }

  writeResponse(responseHeaders: http2.OutgoingHttpHeaders, body?: string) {
    try {
      if (this.streamDestroyed) {
        logger.info(`${this.streamIDString} writeResponse stream destroyed`);
        return;
      }

      if (!body) {
        this.stream.respond(responseHeaders, {
          endStream: true
        });
      } else {
        this.stream.respond(responseHeaders);
        this.stream.end(body);
      }

      logger.info(
        `${this.streamIDString} ${this.requestMethod} ${this.requestPath} ` +
        `status=${responseHeaders[HTTP2_HEADER_STATUS]} ${this.deltaTimeSeconds}s`);
    } catch (err) {
      logger.error(`writeResponse error err = ${formatError(err)}`);
      this.destroyStream();
    }
  }

  respondWithFile(path: string, responseHeaders: http2.OutgoingHttpHeaders, options: http2.ServerStreamFileResponseOptionsWithError) {
    try {
      if (this.streamDestroyed) {
        logger.info(`${this.streamIDString} respondWithFile stream destroyed`);
        return;
      }

      this.stream.respondWithFile(path, responseHeaders, options);

      logger.info(
        `${this.streamIDString} ${this.requestMethod} ${this.requestPath} ` +
        `respondWithFile status=${responseHeaders[HTTP2_HEADER_STATUS]} ${this.deltaTimeSeconds}s`);
    } catch (err) {
      logger.error(`respondWithFile error err = ${formatError(err)}`);
      this.destroyStream();
    }
  }

}

interface Command {
  httpPath: string;
  command: string;
  description: string;
}

interface ProxyOptions {
  hostname: string;
  port: string;
  path: string;
  method: string;
}

interface Proxy {
  httpPath: string;
  description: string;
  options: ProxyOptions;
}

interface StaticFile {
  httpPath: string;
  filePath: string;
  headers: any;
  includeInMainPage: boolean;
}

interface Configuration {
  tlsKeyFile: string;
  tlsCertFile: string;
  listenAddress: string;
  listenPort: string;
  mainPageTitle: string;
  commandList: Command[];
  proxyList: Proxy[];
  staticFileList: StaticFile[];
  gitHash: string;
  NODE_ENV: string;
}

class Templates {
  constructor(
    readonly indexTemplate: string,
    readonly commandTemplate: string,
    readonly proxyTemplate: string) { }
}

type RequestHandler = (requestContext: RequestContext) => void;

class Handlers {

  static buildNotFoundHander(): RequestHandler {
    return (requestContext: RequestContext) => {
      requestContext.writeResponse({
        [HTTP2_HEADER_STATUS]: HTTP_STATUS_NOT_FOUND,
        [HTTP2_HEADER_CONTENT_TYPE]: CONTENT_TYPE_TEXT_PLAIN
      },
        'Unknown request');
    };
  }

  static buildIndexHandler(indexTemplate: string, configuration: Configuration): RequestHandler {

    const staticFilesInMainPage = configuration.staticFileList.filter((sf) => sf.includeInMainPage);

    const indexData = {
      now: formattedDateTime(),
      staticFilesInMainPage,
      configuration
    };

    const indexHtml = mustache.render(indexTemplate, indexData);

    const lastModifiedValue = new Date().toUTCString();
    const cacheControlValue = 'max-age=60';

    return (requestContext: RequestContext) => {
      requestContext.writeResponse({
        [HTTP2_HEADER_STATUS]: HTTP_STATUS_OK,
        [HTTP2_HEADER_CONTENT_TYPE]: CONTENT_TYPE_TEXT_HTML,
        [HTTP2_HEADER_LAST_MODIFIED]: lastModifiedValue,
        [HTTP2_HEADER_CACHE_CONTROL]: cacheControlValue
      },
        indexHtml);
    };
  }

  static buildCommandHTMLHandler(commandTemplate: string, command: Command, apiPath: string): RequestHandler {

    const commandData = {
      apiPath,
      command
    };

    const commandHtml = mustache.render(commandTemplate, commandData);

    const lastModifiedValue = new Date().toUTCString();
    const cacheControlValue = 'max-age=60';

    return (requestContext: RequestContext) => {
      requestContext.writeResponse({
        [HTTP2_HEADER_STATUS]: HTTP_STATUS_OK,
        [HTTP2_HEADER_CONTENT_TYPE]: CONTENT_TYPE_TEXT_HTML,
        [HTTP2_HEADER_LAST_MODIFIED]: lastModifiedValue,
        [HTTP2_HEADER_CACHE_CONTROL]: cacheControlValue
      },
        commandHtml);
    };
  }

  static buildCommandAPIHandler(command: Command): RequestHandler {
    return async (requestContext: RequestContext) => {

      let childProcess;
      let commandErr;
      try {
        childProcess = await asyncExec(command.command);
      } catch (err) {
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
      } else {
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
      },
        stringify(commandData));
    };
  }

  static buildProxyHTMLHandler(proxyTemplate: string, proxy: Proxy, apiPath: string): RequestHandler {

    const proxyData = {
      apiPath,
      proxy
    };

    const proxyHtml = mustache.render(proxyTemplate, proxyData);

    const lastModifiedValue = new Date().toUTCString();
    const cacheControlValue = 'max-age=60';

    return (requestContext: RequestContext) => {
      requestContext.writeResponse({
        [HTTP2_HEADER_STATUS]: HTTP_STATUS_OK,
        [HTTP2_HEADER_CONTENT_TYPE]: CONTENT_TYPE_TEXT_HTML,
        [HTTP2_HEADER_LAST_MODIFIED]: lastModifiedValue,
        [HTTP2_HEADER_CACHE_CONTROL]: cacheControlValue
      },
        proxyHtml);
    };
  }

  static buildProxyAPIHandler(proxy: Proxy): RequestHandler {
    return (requestContext: RequestContext) => {

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
        },
          stringify(proxyData));
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

  static buildStaticFileHandler(staticFile: StaticFile): RequestHandler {
    return (requestContext: RequestContext) => {

      const statCheck = (stat, statResponseHeaders) => {
        try {
          // resolution for http headers is 1 second
          stat.mtime.setMilliseconds(0);

          statResponseHeaders[HTTP2_HEADER_LAST_MODIFIED] = stat.mtime.toUTCString();

          const ifModifiedSinceString = requestContext.requestHeaders[HTTP2_HEADER_IF_MODIFIED_SINCE] as string;
          if (ifModifiedSinceString) {
            const ifModifiedSinceDate = new Date(ifModifiedSinceString);
            if (stat.mtime.getTime() === ifModifiedSinceDate.getTime()) {
              statResponseHeaders[HTTP2_HEADER_STATUS] = HTTP_STATUS_NOT_MODIFIED;
              requestContext.writeResponse(statResponseHeaders);
              return false;
            }
          }
        } catch (err) {
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
          },
            'File not found');
        } else {
          requestContext.writeResponse({
            [HTTP2_HEADER_STATUS]: HTTP_STATUS_INTERNAL_SERVER_ERROR,
            [HTTP2_HEADER_CONTENT_TYPE]: CONTENT_TYPE_TEXT_PLAIN
          },
            'Error reading file');
        }
      };

      const responseHeaders = Object.assign({
        [HTTP2_HEADER_STATUS]: HTTP_STATUS_OK
      },
        staticFile.headers);

      requestContext.respondWithFile(staticFile.filePath,
        responseHeaders, {
          statCheck,
          onError
        });
    }
  }

  static buildHttpAgentStatusHandler(): RequestHandler {
    return (requestContext: RequestContext) => {
      const statusJson = stringifyPretty(httpAgentInstance().getCurrentStatus());

      requestContext.writeResponse({
        [HTTP2_HEADER_STATUS]: HTTP_STATUS_OK,
        [HTTP2_HEADER_CONTENT_TYPE]: CONTENT_TYPE_TEXT_PLAIN
      },
        statusJson);
    };
  }

  static buildConfigurationHandler(configuration: Configuration): RequestHandler {
    const configurationJson = stringifyPretty(configuration);

    return (requestContext: RequestContext) => {

      requestContext.writeResponse({
        [HTTP2_HEADER_STATUS]: HTTP_STATUS_OK,
        [HTTP2_HEADER_CONTENT_TYPE]: CONTENT_TYPE_TEXT_PLAIN
      },
        configurationJson);
    };
  }

  static buildV8StatsHander(): RequestHandler {
    return (requestContext: RequestContext) => {
      const v8Stats = {
        heapStatistics: v8.getHeapStatistics(),
        heapSpaceStatistics: v8.getHeapSpaceStatistics(),
      };
      const statusText = stringifyPretty(v8Stats);

      requestContext.writeResponse({
        [HTTP2_HEADER_STATUS]: HTTP_STATUS_OK,
        [HTTP2_HEADER_CONTENT_TYPE]: CONTENT_TYPE_TEXT_PLAIN
      },
        statusText);
    };
  }
}

class AsyncServer {
  private readonly configuration: Configuration;
  private readonly notFoundHandler: RequestHandler;
  private readonly pathToHandler: Map<string, RequestHandler>;

  constructor(configuration: Configuration, templates: Templates) {
    this.configuration = configuration;

    this.notFoundHandler = Handlers.buildNotFoundHander();

    this.pathToHandler = new Map();

    const setOrThrow = (key, value) => {
      if (this.pathToHandler.has(key)) {
        throw new Error(`duplicate path key ${key}`);
      }
      this.pathToHandler.set(key, value);
    };

    setOrThrow('/', Handlers.buildIndexHandler(templates.indexTemplate, this.configuration));

    (this.configuration.commandList || []).forEach((command) => {
      const apiPath = `/api/commands${command.httpPath}`;
      setOrThrow(command.httpPath, Handlers.buildCommandHTMLHandler(templates.commandTemplate, command, apiPath));
      setOrThrow(apiPath, Handlers.buildCommandAPIHandler(command));
    });

    (this.configuration.proxyList || []).forEach((proxy) => {
      const apiPath = `/api/proxies${proxy.httpPath}`;
      setOrThrow(proxy.httpPath, Handlers.buildProxyHTMLHandler(templates.proxyTemplate, proxy, apiPath));
      setOrThrow(apiPath, Handlers.buildProxyAPIHandler(proxy));
    });

    if (this.configuration.proxyList) {
      setOrThrow('/http_agent_status', Handlers.buildHttpAgentStatusHandler());
    }

    (this.configuration.staticFileList || []).forEach(
      (staticFile) => setOrThrow(staticFile.httpPath, Handlers.buildStaticFileHandler(staticFile)));

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

      const handler =
        (((requestContext.requestMethod === HTTP2_METHOD_GET) &&
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

const readConfiguration = async (configFilePath: string) => {
  logger.info(`readConfiguration '${configFilePath}'`);
  const [fileContent, gitHash] = await Promise.all([
    readFileAsync(configFilePath, 'utf8'),
    getGitHash()
  ]);

  const configuration = JSON.parse(fileContent.toString()) as Configuration;
  configuration.gitHash = gitHash;
  configuration.NODE_ENV = process.env.NODE_ENV;

  return configuration;
};

const readTemplates = async () => {
  logger.info('readTemplates');
  let indexTemplate: string;
  let commandTemplate: string;
  let proxyTemplate: string;
  [indexTemplate, commandTemplate, proxyTemplate] = await Promise.all([
    readFileAsync('templates/index.mustache', 'utf8'),
    readFileAsync('templates/command.mustache', 'utf8'),
    readFileAsync('templates/proxy.mustache', 'utf8')
  ]);
  mustache.parse(indexTemplate);
  mustache.parse(commandTemplate);
  mustache.parse(proxyTemplate);
  return new Templates(indexTemplate, commandTemplate, proxyTemplate);
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
