#!/usr/bin/env node

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

const formattedDateTime = () => new Date().toString();

const LOG_DATE_TIME_FORMAT = 'YYYY-MM-DD[T]HH:mm:ss.SSSZZ';

const logger = winston.createLogger({
  format: winston.format.combine(
    winston.format.timestamp({
      format: LOG_DATE_TIME_FORMAT
    }),
    winston.format.printf((info) => `${info.timestamp} ${info.level}: ${info.message}`)
  ),
  transports: [new winston.transports.Console()]
});

const formatError = (err: Error) => (err.stack || err.message);

const stringify = JSON.stringify;
const stringifyPretty = (object: any) => stringify(object, null, 2);

const readFileAsync = async (filePath: string, encoding?: string) => {
  let fileHandle: fs.promises.FileHandle | undefined;
  try {
    fileHandle = await fs.promises.open(filePath, 'r');
    return await fileHandle.readFile({
      encoding
    });
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

const headerToString = (header: string | string[] | undefined) => {
  let retVal: string | undefined;
  if (typeof header === 'string') {
    retVal = header;
  } else if ((Array.isArray(header)) && (header.length > 0)) {
    retVal = header[0];
  }
  return retVal;
}

class RequestContext {
  private readonly startTime: [number, number];
  readonly streamIDString: string;

  constructor(
    private readonly stream: http2.ServerHttp2Stream,
    readonly requestHeaders: http2.IncomingHttpHeaders) {
    this.startTime = process.hrtime();
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
    return headerToString(this.requestHeaders[HTTP2_HEADER_METHOD]);
  }

  get requestPath() {
    return headerToString(this.requestHeaders[HTTP2_HEADER_PATH]);
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

interface Proxy {
  httpPath: string;
  description: string;
  options: http.RequestOptions;
}

interface StaticFile {
  httpPath: string;
  filePath: string;
  headers: http2.OutgoingHttpHeaders;
  includeInMainPage: boolean;
}

interface Configuration {
  tlsKeyFile: string;
  tlsCertFile: string;
  listenAddress: string;
  listenPort: string;
  mainPageTitle: string;
  commandList?: Command[];
  proxyList?: Proxy[];
  staticFileList?: StaticFile[];
  gitHash: string;
  NODE_ENV?: string;
}

class Templates {
  constructor(
    readonly indexTemplate: string,
    readonly commandTemplate: string,
    readonly proxyTemplate: string) {

  }

  get allTemplates() {
    return [this.indexTemplate, this.commandTemplate, this.proxyTemplate];
  }
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

    const staticFilesInMainPage = (configuration.staticFileList || []).filter((sf) => sf.includeInMainPage);

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

      let childProcess: { stdout: string, stderr: string } | undefined;
      let commandErr: Error | undefined;
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

      let commandOutput: string = '';
      if (commandErr) {
        commandOutput = commandErr.toString();
      } else if (childProcess) {
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

      const proxyResponseChunks: any[] = [];
      let proxyResponseStatusCode: number | undefined;
      let proxyResponseVersion: string | undefined;
      let proxyResponseHeaders: http.IncomingHttpHeaders | undefined;
      let proxyError: Error | undefined;

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

      proxyRequest.on('error', (err: Error) => {
        logger.error(`proxy err = ${formatError(err)}`);
        proxyError = err;
        writeProxyResponse();
      });

      proxyRequest.end();
    };
  }

  static buildStaticFileHandler(staticFile: StaticFile): RequestHandler {
    return (requestContext: RequestContext) => {

      const statCheck = (stat: fs.Stats, statResponseHeaders: http2.OutgoingHttpHeaders) => {
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
        } catch (err) {
          logger.error(`statCheck error err = ${formatError(err)}`);
        }
        return true;
      };

      const onError = (err: NodeJS.ErrnoException) => {
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
  private readonly notFoundHandler: RequestHandler;
  private readonly pathToHandler: Map<string | undefined, RequestHandler>;

  constructor(private readonly configuration: Configuration, templates: Templates) {
    this.notFoundHandler = Handlers.buildNotFoundHander();

    this.pathToHandler = new Map();

    const setOrThrow = (key: string | undefined, value: RequestHandler) => {
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
    const [key, cert] = await Promise.all([
      readFileAsync(this.configuration.tlsKeyFile),
      readFileAsync(this.configuration.tlsCertFile)
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
  const [indexTemplate, commandTemplate, proxyTemplate] = await Promise.all([
    readFileAsync('templates/index.mustache', 'utf8'),
    readFileAsync('templates/command.mustache', 'utf8'),
    readFileAsync('templates/proxy.mustache', 'utf8')
  ]);
  const templates = new Templates(
    indexTemplate.toString(),
    commandTemplate.toString(),
    proxyTemplate.toString()
  )
  templates.allTemplates.forEach((t) => mustache.parse(t))
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
