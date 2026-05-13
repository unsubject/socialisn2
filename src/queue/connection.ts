// Shared ioredis connection for BullMQ. BullMQ requires `maxRetriesPerRequest:
// null` on the client used for blocking commands (Worker, QueueEvents).

import { Redis } from 'ioredis';

import { env } from '../config/env.js';

export function createRedis(url: string = env.redisUrl()): Redis {
  return new Redis(url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  });
}
