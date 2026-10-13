/**
 * Logger port (abstract). Business/infrastructure depend only on this interface and are not bound to a specific logging library.
 * Replacing the implementation (console / pino / reporting to a log platform) only requires changing the adapter + container,
 * see docs/architecture/06-logging.md.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Structured fields, output together with a log entry. */
export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  /**
   * Derive a child logger with fixed fields (such as reqId / userId),
   * after which every log written by that logger automatically carries these fields, making it easy to correlate one request.
   */
  child(bindings: LogFields): Logger;
}
