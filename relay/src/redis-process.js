// Starts redis-server as a child process, in RAM only (or with RDB snapshots on /data
// when PERSIST=true). The configuration goes through stdin so that the password never
// shows up in the process list.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { totalmem } from 'node:os';
import { Redis } from 'ioredis';

/** Memory limit of the container (cgroup v2, then v1), or null if none. */
function cgroupMemoryLimit() {
  for (const file of ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes']) {
    try {
      const raw = readFileSync(file, 'utf8').trim();
      if (raw === 'max') return null;
      const n = Number(raw);
      // cgroup v1 reports a huge number when unlimited
      if (Number.isFinite(n) && n > 0 && n < 2 ** 60) return n;
    } catch { /* not this cgroup version */ }
  }
  return null;
}

/**
 * Redis maxmemory: leaves room for Node and the snapshot fork, so that Redis refuses
 * new writes ("relay full") long before Docker kills the container.
 */
export function computeMaxMemory(env = process.env) {
  if (env.REDIS_MAXMEMORY) return Number(env.REDIS_MAXMEMORY);
  const limit = cgroupMemoryLimit() ?? totalmem() / 2;
  return Math.floor(limit * 0.8);
}

export async function startRedis({ persist, dataDir = '/data', port = 6379 }) {
  const password = randomBytes(32).toString('hex');
  const maxmemory = computeMaxMemory();
  const config = [
    `port ${port}`,
    'bind 127.0.0.1',
    'protected-mode yes',
    `requirepass ${password}`,
    `maxmemory ${maxmemory}`,
    'maxmemory-policy noeviction',
    'appendonly no',
    'loglevel warning',
    'daemonize no',
    ...(persist
      ? [`dir ${dataDir}`, 'dbfilename entrenous.rdb', 'save 3600 1']
      : ['dir /tmp', 'save ""']),
  ].join('\n');

  const child = spawn('redis-server', ['-'], { stdio: ['pipe', 'inherit', 'inherit'] });
  child.stdin.end(config + '\n');

  const client = new Redis({ host: '127.0.0.1', port, password, lazyConnect: true, maxRetriesPerRequest: 2 });
  let connected = false;
  client.on('error', (err) => connected && console.error('redis:', err.message));
  for (let attempt = 0; ; attempt++) {
    try {
      await client.connect();
      connected = true;
      break;
    } catch (err) {
      if (attempt > 50 || child.exitCode !== null) throw new Error(`redis did not start: ${err.message}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  return { client, child, maxmemory };
}
