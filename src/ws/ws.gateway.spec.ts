/**
 * Unit suite for WsGateway with mocked WsService and JWT verifier.
 *
 * - connection: parses userId/clientId/token and delegates on valid token
 * - auth: closes 1008 on missing/invalid token or sub mismatch, no delegation
 * - missing URL: delegates undefined ids path still requires token first.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WebSocket } from 'ws';
import { JwtVerifierService } from '../auth/jwt-verifier.service';
import type { SessionSocket } from './session.interface';
import { WsGateway } from './ws.gateway';
import { WsService } from './ws.service';

/**
 * Creates a structural socket stub for gateway tests.
 *
 * - satisfies the narrow socket type structurally
 * - records close calls for auth-failure assertions.
 *
 * @return Stub socket plus its close mock.
 */
function createSocketStub(): {
  socket: SessionSocket;
  close: ReturnType<typeof vi.fn>;
} {
  const close = vi.fn(() => undefined);
  const socket: SessionSocket = {
    readyState: WebSocket.OPEN,
    on: (): void => undefined,
    send: (): void => undefined,
    close: (code?: number, reason?: string): void => {
      close(code, reason);
    },
  };
  return { socket, close };
}

describe('WsGateway', () => {
  let gateway: WsGateway;
  let module: TestingModule | undefined;
  let service: {
    handleConnection: ReturnType<typeof vi.fn>;
  };
  let verify: ReturnType<typeof vi.fn>;

  /**
   * Builds a testing module with WsService and verifier mocked.
   *
   * - verifier resolves `{ iss, aud, exp }` by default, no sub binding
   * - tracks the module so it can be closed after each test.
   */
  async function compile(): Promise<void> {
    service = {
      handleConnection: vi.fn(),
    };
    verify = vi.fn(() => ({
      iss: 'test-issuer',
      aud: 'test-audience',
      exp: 9999999999,
    }));
    module = await Test.createTestingModule({
      providers: [
        WsGateway,
        { provide: WsService, useValue: service },
        { provide: JwtVerifierService, useValue: { verify } },
      ],
    }).compile();
    gateway = module.get<WsGateway>(WsGateway);
  }

  beforeEach(async () => {
    await compile();
  });

  afterEach(async () => {
    await module?.close();
    module = undefined;
  });

  it('delegates parsed userId/clientId to the service on valid token', () => {
    const { socket } = createSocketStub();

    gateway.handleConnection(socket, {
      url: '/ws?userId=user-123&clientId=client-456&token=good',
    });

    expect(verify).toHaveBeenCalledWith('good');
    expect(service.handleConnection).toHaveBeenCalledWith({
      socket,
      userId: 'user-123',
      clientId: 'client-456',
    });
  });

  it('closes with 1008 and skips the service when the token is missing', () => {
    const { socket, close } = createSocketStub();

    gateway.handleConnection(socket, {
      url: '/ws?userId=user-123&clientId=client-456',
    });

    expect(close).toHaveBeenCalledWith(1008, expect.anything());
    expect(service.handleConnection).not.toHaveBeenCalled();
  });

  it('closes with 1008 when the token is invalid', () => {
    verify.mockImplementation(() => {
      throw new Error('bad token');
    });
    const { socket, close } = createSocketStub();

    gateway.handleConnection(socket, {
      url: '/ws?userId=user-123&clientId=client-456&token=bad',
    });

    expect(close).toHaveBeenCalledWith(1008, expect.anything());
    expect(service.handleConnection).not.toHaveBeenCalled();
  });

  it('closes with 1008 on sub/userId mismatch', () => {
    verify.mockReturnValue({
      iss: 'test-issuer',
      aud: 'test-audience',
      exp: 9999999999,
      sub: 'other-user',
    });
    const { socket, close } = createSocketStub();

    gateway.handleConnection(socket, {
      url: '/ws?userId=user-123&clientId=client-456&token=good',
    });

    expect(close).toHaveBeenCalledWith(1008, expect.anything());
    expect(service.handleConnection).not.toHaveBeenCalled();
  });

  it('delegates undefined ids when the URL has no query params (auth passes first)', () => {
    const { socket } = createSocketStub();
    verify.mockReturnValue({
      iss: 'test-issuer',
      aud: 'test-audience',
      exp: 9999999999,
    });

    gateway.handleConnection(socket, {
      url: '/ws?token=good',
    });

    expect(service.handleConnection).toHaveBeenCalledWith({
      socket,
      userId: undefined,
      clientId: undefined,
    });
  });

  it('closes when no upgrade URL is present', () => {
    const { socket, close } = createSocketStub();

    gateway.handleConnection(socket);

    expect(close).toHaveBeenCalledWith(1008, expect.anything());
    expect(service.handleConnection).not.toHaveBeenCalled();
  });
});
