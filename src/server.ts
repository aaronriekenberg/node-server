#!/usr/bin/env node

import * as agentkeepalive from 'agentkeepalive'
import * as child_process from 'child_process'
import * as fs from 'fs'
import * as git from 'simple-git/promise'
import * as gitResponseTypes from 'simple-git/typings/response';
import * as http from 'http'
import * as http2 from 'http2'
import * as mustache from 'mustache'
import * as net from 'net'
import * as util from 'util'
import * as v8 from 'v8'
import * as winston from 'winston'

const asyncExec = util.promisify(child_process.exec);

const {
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

const formatError = (err: Error, includeStack: boolean = true) => {
  return ((includeStack && err.stack) || err.message);
};

const stringify = JSON.stringify;
const stringifyPretty = (object: any) => stringify(object, null, 2);

const UTF8 = 'utf8';

const asyncReadFile = async (filePath: string, encoding?: string) => {
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
};

const cloneHeaders = (headers: http2.OutgoingHttpHeaders) => {
  return Object.assign({}, headers);
};

class RequestContext {
  private readonly startTime: [number, number];
  readonly streamIDString: string;
  readonly requestMethod: string | undefined;
  readonly requestPath: string | undefined;

  constructor(
    private readonly stream: http2.ServerHttp2Stream,
    readonly requestHeaders: http2.IncomingHttpHeaders) {
    this.startTime = process.hrtime();
    this.streamIDString = RequestContext.buildStreamIDString(stream);
    this.requestMethod = headerToString(this.requestHeaders[HTTP2_HEADER_METHOD]);
    this.requestPath = headerToString(this.requestHeaders[HTTP2_HEADER_PATH]);

    stream.on('error', (err: Error) => {
      logger.error(`${this.streamIDString} stream error event err = ${formatError(err)}`);
      this.destroyStream();
    });
  }

  static buildStreamIDString(stream: http2.ServerHttp2Stream): string {
    try {
      // XXX id is not part of ServerHttp2Stream
      return `${stream.session.socket.remoteAddress}:${stream.session.socket.remotePort}/${(stream as any).id}`;
    } catch (err) {
      return 'UNKNOWN';
    }
  }

  get deltaTimeSeconds(): number {
    const delta = process.hrtime(this.startTime);
    return delta[0] + (delta[1] / 1e9);
  }

  get streamDestroyed(): boolean {
    return this.stream.destroyed;
  }

  destroyStream(): void {
    try {
      if (!this.stream.destroyed) {
        this.stream.destroy();
      }
    } catch (err) {
      logger.error(`destroyStream error err = ${formatError(err)}`);
    }
  }

  writeResponse(responseHeaders: http2.OutgoingHttpHeaders, body?: string): void {
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

  respondWithFile(path: string, responseHeaders: http2.OutgoingHttpHeaders, options: http2.ServerStreamFileResponseOptionsWithError): void {
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

interface Environment {
  readonly gitCommit: gitResponseTypes.DefaultLogFields;
  readonly argv: string[],
  readonly env: NodeJS.ProcessEnv;
  readonly arch: string;
  readonly platform: NodeJS.Platform;
  readonly versions: NodeJS.ProcessVersions;
}

interface Command {
  readonly id: string;
  readonly command: string;
  readonly description: string;
}

interface Proxy {
  readonly id: string;
  readonly description: string;
  readonly options: http.RequestOptions;
}

interface StaticFile {
  readonly httpPath: string;
  readonly filePath: string;
  readonly headers: http2.OutgoingHttpHeaders;
  readonly includeInMainPage: boolean;
}

interface Configuration {
  readonly tlsKeyFile: string;
  readonly tlsCertFile: string;
  readonly listenAddress: string;
  readonly listenPort: number;
  readonly mainPageTitle: string;
  readonly templatePageHeaders: http2.OutgoingHttpHeaders;
  readonly commandList?: Command[];
  readonly proxyList?: Proxy[];
  readonly staticFileList?: StaticFile[];
}

interface Templates {
  readonly indexTemplate: string;
  readonly commandTemplate: string;
  readonly proxyTemplate: string;
}

type RequestHandler = (requestContext: RequestContext) => void;

class Handlers {

  static buildNotFoundHander(): RequestHandler {

    const headers = {
      [HTTP2_HEADER_STATUS]: HTTP_STATUS_NOT_FOUND,
      [HTTP2_HEADER_CONTENT_TYPE]: CONTENT_TYPE_TEXT_PLAIN
    };

    return (requestContext: RequestContext) => {
      requestContext.writeResponse(
        cloneHeaders(headers),
        'Unknown request');
    };
  }

  static buildIndexHandler(
    indexTemplate: string,
    configuration: Configuration,
    environment: Environment): RequestHandler {

    const staticFilesInMainPage = (configuration.staticFileList || []).filter((sf) => sf.includeInMainPage);

    const indexData = {
      now: formattedDateTime(),
      staticFilesInMainPage,
      configuration,
      environment
    };

    const indexHtml = mustache.render(indexTemplate, indexData);

    const headers = Object.assign({
      [HTTP2_HEADER_STATUS]: HTTP_STATUS_OK,
      [HTTP2_HEADER_LAST_MODIFIED]: new Date().toUTCString()
    },
      configuration.templatePageHeaders);

    return (requestContext: RequestContext) => {
      requestContext.writeResponse(
        cloneHeaders(headers),
        indexHtml);
    };
  }

  static buildCommandHTMLHandler(
    commandTemplate: string,
    configuration: Configuration,
    command: Command,
    apiPath: string): RequestHandler {

    const commandData = {
      apiPath,
      command
    };

    const commandHtml = mustache.render(commandTemplate, commandData);

    const headers = Object.assign({
      [HTTP2_HEADER_STATUS]: HTTP_STATUS_OK,
      [HTTP2_HEADER_LAST_MODIFIED]: new Date().toUTCString()
    },
      configuration.templatePageHeaders);

    return (requestContext: RequestContext) => {
      requestContext.writeResponse(
        cloneHeaders(headers),
        commandHtml);
    };
  }

  static buildCommandAPIHandler(command: Command): RequestHandler {
    return async (requestContext: RequestContext) => {

      let childProcess: { stdout: string, stderr: string } | undefined;
      let commandErr: Error | undefined;
      try {
        childProcess = await asyncExec(command.command, { 'timeout': 2000 });
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

  static buildProxyHTMLHandler(
    proxyTemplate: string,
    configuration: Configuration,
    proxy: Proxy,
    apiPath: string): RequestHandler {

    const proxyData = {
      apiPath,
      proxy
    };

    const proxyHtml = mustache.render(proxyTemplate, proxyData);

    const headers = Object.assign({
      [HTTP2_HEADER_STATUS]: HTTP_STATUS_OK,
      [HTTP2_HEADER_LAST_MODIFIED]: new Date().toUTCString()
    },
      configuration.templatePageHeaders);

    return (requestContext: RequestContext) => {
      requestContext.writeResponse(
        cloneHeaders(headers),
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
            if (stat.mtime.getTime() <= ifModifiedSinceDate.getTime()) {
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

    const headers = {
      [HTTP2_HEADER_STATUS]: HTTP_STATUS_OK,
      [HTTP2_HEADER_CONTENT_TYPE]: CONTENT_TYPE_TEXT_PLAIN
    };

    return (requestContext: RequestContext) => {

      const statusJson = stringifyPretty(httpAgentInstance().getCurrentStatus());

      requestContext.writeResponse(
        cloneHeaders(headers),
        statusJson);
    };
  }

  static buildConfigurationHandler(configuration: Configuration): RequestHandler {

    const configurationJson = stringifyPretty(configuration);

    const headers = {
      [HTTP2_HEADER_STATUS]: HTTP_STATUS_OK,
      [HTTP2_HEADER_CONTENT_TYPE]: CONTENT_TYPE_TEXT_PLAIN
    };

    return (requestContext: RequestContext) => {

      requestContext.writeResponse(
        cloneHeaders(headers),
        configurationJson);
    };
  }

  static buildEnvironmentHandler(environment: Environment): RequestHandler {

    const environmentJson = stringifyPretty(environment);

    const headers = {
      [HTTP2_HEADER_STATUS]: HTTP_STATUS_OK,
      [HTTP2_HEADER_CONTENT_TYPE]: CONTENT_TYPE_TEXT_PLAIN
    };

    return (requestContext: RequestContext) => {

      requestContext.writeResponse(
        cloneHeaders(headers),
        environmentJson);
    };
  }

  static buildV8StatsHander(): RequestHandler {

    const headers = {
      [HTTP2_HEADER_STATUS]: HTTP_STATUS_OK,
      [HTTP2_HEADER_CONTENT_TYPE]: CONTENT_TYPE_TEXT_PLAIN
    };

    return (requestContext: RequestContext) => {
      const v8Stats = {
        heapStatistics: v8.getHeapStatistics(),
        heapSpaceStatistics: v8.getHeapSpaceStatistics(),
      };
      const statusText = stringifyPretty(v8Stats);

      requestContext.writeResponse(
        cloneHeaders(headers),
        statusText);
    };
  }
}

class AsyncServer {
  private readonly notFoundHandler: RequestHandler;
  private readonly pathToHandler: Map<string | undefined, RequestHandler>;

  constructor(
    private readonly configuration: Configuration,
    environment: Environment,
    templates: Templates) {

    this.notFoundHandler = Handlers.buildNotFoundHander();

    this.pathToHandler = new Map();

    const setOrThrow = (key: string | undefined, value: RequestHandler) => {
      if (this.pathToHandler.has(key)) {
        throw new Error(`duplicate path key ${key}`);
      }
      this.pathToHandler.set(key, value);
    };

    setOrThrow('/', Handlers.buildIndexHandler(
      templates.indexTemplate, configuration, environment));

    (this.configuration.commandList || []).forEach((command) => {
      const apiPath = `/api/commands/${command.id}`;
      const htmlPath = `/commands/${command.id}.html`;
      setOrThrow(htmlPath, Handlers.buildCommandHTMLHandler(
        templates.commandTemplate, configuration, command, apiPath));
      setOrThrow(apiPath, Handlers.buildCommandAPIHandler(command));
    });

    (this.configuration.proxyList || []).forEach((proxy) => {
      const apiPath = `/api/proxies/${proxy.id}`;
      const htmlPath = `/proxies/${proxy.id}.html`;
      setOrThrow(htmlPath, Handlers.buildProxyHTMLHandler(
        templates.proxyTemplate, configuration, proxy, apiPath));
      setOrThrow(apiPath, Handlers.buildProxyAPIHandler(proxy));
    });

    if (this.configuration.proxyList) {
      setOrThrow('/http_agent_status', Handlers.buildHttpAgentStatusHandler());
    }

    (this.configuration.staticFileList || []).forEach(
      (staticFile) => setOrThrow(staticFile.httpPath, Handlers.buildStaticFileHandler(staticFile)));

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
    const httpServerConfig: http2.SecureServerOptions = {
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

      const handler =
        (((requestContext.requestMethod === HTTP2_METHOD_GET) &&
          (this.pathToHandler.get(requestContext.requestPath))) ||
          this.notFoundHandler);

      handler(requestContext);

    });

    const listenOptions: net.ListenOptions = {
      host: this.configuration.listenAddress,
      port: this.configuration.listenPort
    };
    httpServer.listen(listenOptions);
  }

}

const readConfiguration = async (configFilePath: string) => {
  logger.info(`readConfiguration '${configFilePath}'`);

  const fileContent = await asyncReadFile(configFilePath, UTF8);

  const configuration = JSON.parse(fileContent.toString()) as Configuration;
  return configuration;
};

const getGitCommit = async () => {
  logger.info('getGitCommit');

  const gitLog = await git('.').log(['-1']);

  return gitLog.latest;
};

const getEnvironment = async () => {
  logger.info('getEnvironment');

  const gitCommit = await getGitCommit();

  const environment: Environment = {
    gitCommit,
    argv: process.argv,
    env: process.env,
    arch: process.arch,
    platform: process.platform,
    versions: process.versions
  };
  return environment;
}

const readTemplates = async () => {
  logger.info('readTemplates');

  const [indexTemplate, commandTemplate, proxyTemplate] = await Promise.all([
    asyncReadFile('templates/index.mustache', UTF8),
    asyncReadFile('templates/command.mustache', UTF8),
    asyncReadFile('templates/proxy.mustache', UTF8)
  ]);

  const templates: Templates = {
    indexTemplate: indexTemplate.toString(),
    commandTemplate: commandTemplate.toString(),
    proxyTemplate: proxyTemplate.toString()
  };

  Object.values(templates).forEach((t) => mustache.parse(t))
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
