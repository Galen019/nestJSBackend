/**
 * Unit suite for JwtAuthGuard.
 *
 * - mocks JwtVerifierService, checks @Public() bypass and 401 mapping
 * - covers public routes, valid Bearer, missing/invalid, and non-HTTP passthrough.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { UnauthorizedException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtAuthGuard } from './jwt-auth.guard';
import { JwtVerifierService } from './jwt-verifier.service';

/**
 * Request stub the guard attaches the payload to.
 */
interface GuardRequest {
  headers: Record<string, string | undefined>;
  user?: { iss: string };
}

/**
 * Builds an HTTP execution context stub.
 *
 * @param authorization Authorization header value, if any.
 * @return The stubbed context plus its request object.
 */
function httpContext(authorization: string | undefined): {
  context: ExecutionContext;
  request: GuardRequest;
} {
  const request: GuardRequest = { headers: {} };
  if (authorization !== undefined) {
    request.headers['authorization'] = authorization;
  }
  const context = {
    getHandler: () => ({}),
    getClass: () => ({}),
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  return { context, request };
}

describe('JwtAuthGuard', () => {
  let guard: JwtAuthGuard;
  let module: TestingModule | undefined;
  let verifyHeader: ReturnType<typeof vi.fn>;
  let reflectorGet: ReturnType<typeof vi.fn>;

  /**
   * Compiles the guard with a stubbed verifier and reflector.
   *
   * @param isPublic Whether the reflector reports the route public.
   */
  async function compile(isPublic: boolean): Promise<void> {
    verifyHeader = vi.fn((header: unknown) => {
      if (header === 'Bearer good') {
        return { iss: 'test-issuer', aud: 'test-audience', exp: 9999999999 };
      }
      throw new Error('bad token');
    });
    reflectorGet = vi.fn(() => isPublic);
    module = await Test.createTestingModule({
      providers: [
        JwtAuthGuard,
        { provide: JwtVerifierService, useValue: { verifyHeader } },
        { provide: Reflector, useValue: { getAllAndOverride: reflectorGet } },
      ],
    }).compile();
    guard = module.get<JwtAuthGuard>(JwtAuthGuard);
  }

  afterEach(async () => {
    await module?.close();
    module = undefined;
    vi.restoreAllMocks();
  });

  it('allows public routes without calling the verifier', async () => {
    await compile(true);
    const { context } = httpContext(undefined);

    expect(guard.canActivate(context)).toBe(true);
    expect(verifyHeader).not.toHaveBeenCalled();
  });

  it('attaches the payload and allows valid Bearer tokens', async () => {
    await compile(false);
    const { context, request } = httpContext('Bearer good');

    expect(guard.canActivate(context)).toBe(true);
    expect(verifyHeader).toHaveBeenCalledWith('Bearer good');
    expect(request.user?.iss).toBe('test-issuer');
  });

  it('throws 401 when the header is missing or invalid', async () => {
    await compile(false);
    const missing = httpContext(undefined);
    const invalid = httpContext('Bearer bad');

    expect(() => guard.canActivate(missing.context)).toThrow(
      UnauthorizedException,
    );
    expect(() => guard.canActivate(invalid.context)).toThrow(
      UnauthorizedException,
    );
  });

  it('passes non-HTTP contexts through for WS/gRPC self-auth', async () => {
    await compile(false);
    const context = {
      getHandler: () => ({}),
      getClass: () => ({}),
      getType: () => 'ws',
      switchToHttp: (): unknown => {
        throw new Error('should not be called');
      },
    } as unknown as ExecutionContext;

    expect(guard.canActivate(context)).toBe(true);
    expect(verifyHeader).not.toHaveBeenCalled();
  });
});
