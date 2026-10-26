const service = 'webhook-service';

function write(level, msg, fields = {}) {
  const line = { ts: new Date().toISOString(), level, service, msg, ...fields };
  (level === 'error' ? process.stderr : process.stdout).write(`${JSON.stringify(line)}\n`);
}

export const log = {
  info: (msg, fields) => write('info', msg, fields),
  warn: (msg, fields) => write('warn', msg, fields),
  error: (msg, fields) => write('error', msg, fields),
};
