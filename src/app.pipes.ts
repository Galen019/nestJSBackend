/**
 * Shared global pipe factory.
 *
 * - Single source of truth for ValidationPipe options
 */
import { ValidationPipe } from '@nestjs/common';

/**
 * Creates the global validation pipe.
 *
 * - strips non-whitelisted fields and rejects them with 400
 * - transforms plain payloads into DTO instances.
 *
 * @return The configured validation pipe.
 */
export function createGlobalValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  });
}
