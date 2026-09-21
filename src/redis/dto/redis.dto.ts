/**
 * DTOs for /redis request validation.
 *
 * - ExpirationDto: single expiration concept with EX/PX type and value
 * - SetOptionsDto: single expiration plus single NX/XX condition
 * - SetRedisDto: POST body with key, value, and nested options
 * - GetRedisDto: GET query with key
 * - enforced by the global ValidationPipe with whitelist
 */
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsPositive,
  IsString,
  Matches,
  ValidateNested,
} from 'class-validator';

/**
 * Wire shape for a single Redis expiration.
 *
 * - holds one of EX/PX with a positive integer value
 * - replaces the old EX/PX pair so conflicts are unrepresentable.
 */
export class ExpirationDto {
  @IsIn(['EX', 'PX'])
  type!: 'EX' | 'PX';

  @IsInt()
  @IsPositive()
  value!: number;
}

/**
 * Wire shape for Redis SET modifiers.
 *
 * - holds at most one expiration and one condition
 * - empty object means absent and gets the edge default TTL.
 */
export class SetOptionsDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => ExpirationDto)
  expiration?: ExpirationDto;

  @IsOptional()
  @IsIn(['NX', 'XX'])
  condition?: 'NX' | 'XX';
}

/**
 * Outer request body for POST /redis.
 *
 * - requires a key with at least one non-whitespace character
 * - requires a string value
 * - accepts optional nested set options
 * - extra fields are rejected by the global pipe.
 */
export class SetRedisDto {
  @IsString()
  @IsNotEmpty()
  @Matches(/\S/)
  key!: string;

  @IsString()
  value!: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => SetOptionsDto)
  options?: SetOptionsDto;
}

/**
 * Query shape for GET /redis.
 *
 * - requires a key with at least one non-whitespace character
 * - missing or blank keys are rejected by the global pipe with 400.
 */
export class GetRedisDto {
  @IsString()
  @IsNotEmpty()
  @Matches(/\S/)
  key!: string;
}
