/**
 * HTTP interface for Redis get/set operations.
 *
 * - GET /redis?key=<key> reads via RedisService.getEntry, 404 on miss
 * - POST /redis writes via RedisService.set, options validated as an object
 * - Thin layer: routing, option mapping, status codes only, no storage logic
 */
import {
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Post,
  Query,
} from '@nestjs/common';
import type { SetOptions } from 'redis';
import { GetRedisDto, SetOptionsDto, SetRedisDto } from './dto/redis.dto';
import { DEFAULT_SET_TTL_SECONDS } from './redis.constants';
import { RedisService } from './redis.service';

export interface GetRedisResponse {
  key: string;
  value: string;
  expiresIn: number | null;
}

export interface SetRedisResponse {
  key: string;
  value: string;
  result: string | null;
}

/**
 * Thin HTTP adapter over RedisService get/set.
 *
 * - delegates storage to RedisService
 * - validates input via DTOs and the global pipe
 * - maps misses to 404 and applies the edge default TTL
 * - exposes the key TTL in seconds, null when persistent, on GET hits.
 */
@Controller('redis')
export class RedisController {
  constructor(private readonly redisService: RedisService) {}

  /**
   * Reads a value by query key with its TTL.
   *
   * - relies on the global pipe to reject missing or blank keys with 400
   * - returns 404 when Redis resolves null, including expiry races
   * - otherwise resolves with key, stored value, and TTL seconds or null.
   *
   * @param query Validated query holding the key to read.
   * @return The key with its stored value and TTL seconds or null.
   */
  @Get()
  async getValue(@Query() query: GetRedisDto): Promise<GetRedisResponse> {
    const entry = await this.redisService.getEntry(query.key);
    if (entry === null) {
      throw new NotFoundException(`Key "${query.key}" not found`);
    }
    return { key: query.key, value: entry.value, expiresIn: entry.expiresIn };
  }

  /**
   * Creates a key:value entry from the validated request body.
   *
   * - relies on the global pipe for key/value/options shape checks
   * - maps the options DTO to client set options with edge default TTL
   * - delegates to RedisService.set and resolves with the SET reply.
   *
   * @param body Validated body with key, value, and optional set options.
   * @return The written key, value, and Redis SET reply.
   */
  @Post()
  @HttpCode(201)
  async setValue(@Body() body: SetRedisDto): Promise<SetRedisResponse> {
    const result = await this.redisService.set(
      body.key,
      body.value,
      this.toSetOptions(body.options),
    );
    return { key: body.key, value: body.value, result };
  }

  /**
   * Maps the options DTO to client set options.
   *
   * - always resolves with an expiration, defaulting to the edge TTL
   * - copies the single NX/XX condition when present
   * - never throws, conflicts are unrepresentable in the DTO.
   *
   * @param dto Validated options DTO from the request body.
   * @return The client set options with expiration guaranteed.
   */
  private toSetOptions(dto: SetOptionsDto | undefined): SetOptions {
    const options: SetOptions = {};
    if (dto?.expiration !== undefined) {
      options.expiration = {
        type: dto.expiration.type,
        value: dto.expiration.value,
      };
    } else {
      options.expiration = {
        type: 'EX',
        value: DEFAULT_SET_TTL_SECONDS,
      };
    }
    if (dto?.condition !== undefined) {
      options.condition = dto.condition;
    }
    return options;
  }
}
