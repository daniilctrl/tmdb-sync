import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  HealthCheck,
  HealthCheckService,
  PrismaHealthIndicator,
} from '@nestjs/terminus';
import { Redis } from 'ioredis';
import { PrismaService } from '../prisma/prisma.service';
import type { Env } from '../config/env.schema';

@Controller('health')
export class HealthController {
  private readonly redis: Redis;

  constructor(
    private readonly health: HealthCheckService,
    private readonly prismaIndicator: PrismaHealthIndicator,
    private readonly prisma: PrismaService,
    config: ConfigService<Env, true>,
  ) {
    this.redis = new Redis({
      host: config.get('REDIS_HOST', { infer: true }),
      port: config.get('REDIS_PORT', { infer: true }),
      lazyConnect: true,
      maxRetriesPerRequest: 1,
    });
  }

  @Get()
  @HealthCheck()
  check() {
    return this.health.check([
      () => this.prismaIndicator.pingCheck('postgres', this.prisma),
      async () => {
        try {
          const pong = await this.redis.ping();
          return { redis: { status: pong === 'PONG' ? 'up' : 'down' } };
        } catch (err) {
          return { redis: { status: 'down', message: (err as Error).message } };
        }
      },
    ]);
  }
}
