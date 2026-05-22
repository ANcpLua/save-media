export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export function consoleLogger(scope: string): Logger {
  const prefix = `[savemedia:${scope}]`;
  return {
    debug: (m, f) => { if (f) console.debug(prefix, m, f); else console.debug(prefix, m); },
    info:  (m, f) => { if (f) console.info(prefix, m, f);  else console.info(prefix, m); },
    warn:  (m, f) => { if (f) console.warn(prefix, m, f);  else console.warn(prefix, m); },
    error: (m, f) => { if (f) console.error(prefix, m, f); else console.error(prefix, m); },
  };
}

export const noopLogger: Logger = {
  debug() {}, info() {}, warn() {}, error() {},
};
