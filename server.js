#!/usr/bin/env node

const child_process = require('child_process')
const escapeHtml = require('escape-html')
const fs = require('fs')
const http = require('http')
const util = require('util')
const winston = require('winston')
const asyncExec = util.promisify(child_process.exec)
const asyncReadFile = util.promisify(fs.readFile)

const port = 8081

const logger = new winston.Logger({
  transports: [
    new winston.transports.Console({
      timestamp: function() {
        return new Date().toISOString()
      },
      formatter: function(options) {
        // - Return string will be passed to logger.
        // - Optionally, use options.colorize(options.level, <string>) to
        //   colorize output based on the log level.
        return options.timestamp() + ' ' +
          winston.config.colorize(options.level, options.level.toUpperCase()) + ' ' +
          (options.message ? options.message : '') +
          (options.meta && Object.keys(options.meta).length ? '\n\t'+ JSON.stringify(options.meta) : '')
      }
    })
  ]
});

const commandList = [
  {
    httpPath: '/ifconfig',
    command: '/sbin/ifconfig',
    description: 'ifconfig'
  },
  {
    httpPath: '/iwconfig',
    command: '/sbin/iwconfig',
    description: 'iwconfig'
  },
  {
    httpPath: '/ncal',
    command: 'ncal -h -y',
    description: 'ncal'
  },
  {
    httpPath: '/netstat',
    command: 'netstat -an',
    description: 'netstat'
  },
  {
    httpPath: '/ntpq',
    command: 'ntpq -p',
    description: 'ntpq'
  },
  {
    httpPath: '/pitemp',
    command: '/home/pi/bin/pitemp.sh',
    description: 'pitemp'
  },
  {
    httpPath: '/top',
    command: 'top -b -n1',
    description: 'top'
  },
  {
    httpPath: '/unbound_infra',
    command: 'sudo unbound-control dump_infra',
    description: 'unbound infra'
  },
  {
    httpPath: '/unbound_stats',
    command: 'sudo unbound-control stats_noreset',
    description: 'unbound stats'
  },
  {
    httpPath: '/uptime',
    command: 'uptime',
    description: 'uptime'
  },
  {
    httpPath: '/vmstat',
    command: 'vmstat',
    description: 'vmstat'
  },
  {
    httpPath: '/w',
    command: 'w',
    description: 'w'
  }
]

const commandMap = new Map()
commandList.forEach(command => commandMap.set(command.httpPath, command))

const staticFileList = [
  {
    httpPath: '/style.css',
    filePath: 'style.css',
    contentType: 'text/css'
  },
  {
    httpPath: '/favicon.ico',
    filePath: 'raspberrypi-favicon.ico',
    contentType: 'image/x-icon'
  }
]

const staticFileMap = new Map()
staticFileList.forEach(staticFile => staticFileMap.set(staticFile.httpPath, staticFile))

const indexHtml = `<!DOCTYPE html>
<html>
<head>
  <title>Aaron\'s Raspberry Pi</title>
  <meta name="viewport" content="width=device, initial-scale=1" />
  <link rel="stylesheet" type="text/css" href="style.css" />
</head>
<body>
  <h2>Aaron\'s Raspberry Pi</h2>
  <h3>Commands:</h3>
  <ul>
    ${commandList.map(command => `<li><a href="${command.httpPath}">${command.description}</a></li>`).join('')}
  </ul>
</body>
</html>
`

function serveIndex(response) {
  response.writeHead(200, {'Content-Type': 'text/html'})
  response.end(indexHtml)
}

async function serveCommand(command, response) {
  let preString
  try {
    const { stdout, stderr } = await asyncExec(command.command)
    preString = `Now: ${new Date().toISOString()}\n\n`
    preString += `$ ${command.command}\n\n`
    preString += escapeHtml(stderr + stdout)
  } catch (err) {
    preString = err
  }

  const commandHtml = `<!DOCTYPE html>
  <html>
  <head>
    <title>${command.description}</title>
    <meta name="viewport" content="width=device, initial-scale=1" />
    <link rel="stylesheet" type="text/css" href="style.css" />
  </head>
  <body>
    <a href="..">..</a>
    <pre>${preString}</pre>
  </body>
  </html>
  `

  response.writeHead(200, {'Content-Type': 'text/html'})
  response.end(commandHtml)
}

async function serveFile(staticFile, response) {
  try {
    const data = await asyncReadFile(staticFile.filePath)
    response.writeHead(200, {'Content-Type': staticFile.contentType})
    response.end(data)
  } catch (err) {
    logger.error('serveFile err = ' + err)
    response.writeHead(404)
    response.end()
  }
}

async function requestHandler(request, response) {
  response.on('finish', function() {
    logger.info(`${request.socket.remoteAddress}:${request.socket.remotePort} ${request.method} ${request.url} ${response.statusCode}`)
  })

  if (request.url == '/') {
    serveIndex(response)
  } else if (commandMap.has(request.url)) {
    const command = commandMap.get(request.url)
    await serveCommand(command, response)
  } else if (staticFileMap.has(request.url)) {
    const staticFile = staticFileMap.get(request.url)
    await serveFile(staticFile, response)
  } else {
    response.writeHead(404, {'Content-Type': 'text/plain'})
    response.end('Unknown path')
  }
}

function main() {
  const server = http.createServer(requestHandler)
  server.listen(port, (err) => {
    if (err) {
      logger.error('something bad happened', err)
      return
    }
    logger.info(`server is listening on ${port}`)
  })
}

main()
