/**
 * Global JWT authentication guard.
 *
 * - Protects all HTTP routes by default, `@Public()` opts out
 * - Verifies `Authorization: Bearer <jwt>` via JwtVerifierService
 * - Non-HTTP contexts (WS, gRPC) pass through; they enforce auth themselves.
 */
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtVerifierService, type JwtPayload } from './jwt-verifier.service';
import { IS_PUBLIC_KEY } from './public.decorator';

/**
 * Request shape the guard attaches the verified payload to.
 *
 * - minimal structural type so no `any` cast is needed
 * - `user` carries the verified JWT claims for downstream handlers.
 */
interface AuthenticatedRequest {
  headers: Record<string, string | string[] | undefined>;
  user?: JwtPayload;
}

/**
 * Checks that a value looks like an HTTP request with headers.
 *
 * - narrows `unknown` from `switchToHttp().getRequest()`.
 *
 * @param value Candidate request value.
 * @return True when the value has a headers object.
 */
function isHttpRequest(value: unknown): value is AuthenticatedRequest {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  return 'headers' in value && typeof value.headers === 'object';
}

/**
 * Reads the Authorization header as a single string.
 *
 * - joins array values per Node behavior, returns undefined when absent.
 *
 * @param headers Request headers map.
 * @return The header value, or undefined when missing.
 */
function readAuthHeader(
  headers: Record<string, string | string[] | undefined>,
): string | undefined {
  const raw = headers['authorization'];
  if (raw === undefined) {
    return undefined;
  }
  return Array.isArray(raw) ? raw.join(', ') : raw;
}

/**
 * Global guard enforcing JWT authentication on HTTP routes.
 *
 * - returns true for `@Public()` routes and non-HTTP contexts
 * - attaches the verified payload to `request.user` on success
 * - throws 401 on missing, malformed, expired, or wrong-claim tokens.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  private readonly logger = new Logger(JwtAuthGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly verifier: JwtVerifierService,
  ) {}

  /**
   * Decides whether the current request may proceed.
   *
   * - bypasses `@Public()` handlers/classes and WS/gRPC contexts
   * - verifies the Bearer token and stores claims on the request.
   *
   * @param context Execution context for the incoming request.
   * @return True when the request is authorized.
   */
  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic === true) {
      return true;
    }
    if (context.getType<string>() !== 'http') {
      return true;
    }
    const request: unknown = context.switchToHttp().getRequest();
    if (!isHttpRequest(request)) {
      throw new UnauthorizedException('Missing request');
    }
    try {
      request.user = this.verifier.verifyHeader(
        readAuthHeader(request.headers),
      );
    } catch (error) {
      this.logger.debug(
        `JWT verification failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw new UnauthorizedException('Invalid or expired token');
    }
    return true;
  }
}
