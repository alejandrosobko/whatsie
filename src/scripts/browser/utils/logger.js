import manifest from '../../../package.json';
import stripAnsi from 'strip-ansi';
import mkdirp from 'mkdirp';
import debug from 'debug';
import path from 'path';
import util from 'util';
import app from 'app';
import fs from 'fs';

let fileLogStream = null;
let fileLogInit = false;
let duringInit = false;
let consoleSilenced = false;

function isFileLogEnabled() {
  return global.options.debug && !process.mas;
}

function initFileLogging() {
  if (duringInit) {
    return;
  }
  duringInit = true;

  try {
    const fileLogsDir = path.join(app.getPath('userData'), 'logs');
    mkdirp.sync(fileLogsDir);

    const fileLogPath = path.join(fileLogsDir, Date.now() + '.log');
    fileLogStream = fs.createWriteStream(null, {fd: fs.openSync(fileLogPath, 'a')});

    process.on('exit', (code) => {
      fileLogStream.end('process exited with code ' + code + '\r\n');
      fileLogStream = null;
    });

    console.log(`saving logs to "${fileLogPath}"`);
    fileLogInit = true;
    duringInit = false;
  } catch(ex) {
    duringInit = false;
    throw ex;
  }
}

function namespaceOf(filename) {
  const name = path.basename(filename, '.js');
  return manifest.name + ':' + name;
}

function anonymizeException(ex) {
  // Replace username in C:\Users\<username>\AppData\
  const exMsgBits = ex.message.split('\\');
  const c1 = exMsgBits[0] === 'C:';
  const c2 = exMsgBits[1] === 'Users';
  const c3 = exMsgBits[3] === 'AppData';
  if (c1 && c2 && c3) {
    exMsgBits[2] = '<username>';
    ex.message = exMsgBits.join('\\');
  }
}

export function silence(isSilenced) {
  consoleSilenced = isSilenced;
}

export function debugLogger(filename) {
  const name = path.basename(filename, '.js');
  const namespace = manifest.name + ':' + name;
  const logger = debug(namespace);
  logger.log = function() {
    if (!consoleSilenced) {
      console.error.apply(console, arguments);
    }

    if (isFileLogEnabled() && !fileLogInit) {
      initFileLogging();
    }
    if (fileLogStream) {
      fileLogStream.write(stripAnsi(util.format.apply(util, arguments)) + '\r\n');
    }
  };
  return logger;
}

export function errorLogger(filename, fatal) {
  const fakePagePath = filename.replace(app.getAppPath(), '');
  const namespace = namespaceOf(filename);
  return function(ex) {
    const errorPrefix = `[${new Date().toUTCString()}] ${fakePagePath}:`;
    if (!consoleSilenced) {
      console.error(errorPrefix, ...arguments);
    }

    if (isFileLogEnabled() && !fileLogInit) {
      initFileLogging();
    }

    if (ex instanceof Error) {
      const analytics = require('./analytics').default;
      if (analytics) {
        analytics.trackEvent(
          'Exceptions',
          fatal ? 'FatalError' : 'Error',
          ex.name,
          `[${namespace}]: ${ex.message}`
        );
      }

      const airbrake = require('./airbrake').default;
      if (airbrake) {
        // Wrap the error for more stack trace data
        const err = new Error(ex);
        err.url = fakePagePath;
        err.component = namespace;
        err.distrib = manifest.distrib;
        err.params = manifest;
        anonymizeException(err);
        airbrake.notify(err);
      }
    }

    if (fileLogStream) {
      if (ex instanceof Error) {
        fileLogStream.write(errorPrefix + ' ' + ex.name + ' ' + ex.message + ' ' + ex.stack + '\r\n');
      } else {
        fileLogStream.write(errorPrefix + ' ' + arguments + '\r\n');
      }
    }
  };
}
