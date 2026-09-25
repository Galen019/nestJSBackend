/**
 * Public-route marker for the global JWT guard.
 *
 * - Routes decorated with `@Public()` skip authentication
 * - Everything else is protected by default (fail-closed).
 */
import { SetMetadata } from '@nestjs/common';

/** Metadata key the JWT guard checks via `Reflector`. */
export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Marks a route or controller as public (no JWT required).
 *
 * - intended for readiness probes such as `GET /health`.
 *
 * @return The metadata decorator.
 */
export function Public(): ReturnType<typeof SetMetadata> {
  return SetMetadata(IS_PUBLIC_KEY, true);
}
