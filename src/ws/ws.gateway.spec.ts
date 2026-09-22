/**
 * Unit suite for WsGateway with a mocked WsService.
 *
 * - connection: parses userId/clientId from the upgrade URL and delegates
 * - missing URL: delegates undefined ids so the service closes with 1008.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WebSocket } from 'ws';
import type { SessionSocket } from './session.interface';
import { WsGateway } from './ws.gateway';
import { WsService } from './ws.service';

/**
 * Creates a structural socket stub for gateway tests.
 *
 * - satisfies the narrow socket type without casts
 * - the gateway never calls socket methods, it only forwards the instance.
 *
 * @return Stub socket.
 */
function createSocketStub(): SessionSocket {
  return {
    readyState: WebSocket.OPEN,
    on: (): void => undefined,
    send: (): void => undefined,
    close: (): void => undefined,
  };
}

describe('WsGateway', () => {
  let gateway: WsGateway;
  let module: TestingModule | undefined;
  let service: {
    handleConnection: ReturnType<typeof vi.fn>;
  };

  /**
   * Builds a testing module with WsService mocked.
   *
   * - provides a stub `handleConnection` fn
   * - tracks the module so it can be closed after each test.
   */
  async function compile(): Promise<void> {
    service = {
      handleConnection: vi.fn(),
    };
    module = await Test.createTestingModule({
      providers: [WsGateway, { provide: WsService, useValue: service }],
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

  it('delegates parsed userId/clientId to the service on connection', () => {
    const socket = createSocketStub();

    gateway.handleConnection(socket, {
      url: '/ws?userId=user-123&clientId=client-456',
    });

    expect(service.handleConnection).toHaveBeenCalledWith({
      socket,
      userId: 'user-123',
      clientId: 'client-456',
    });
  });

  it('delegates undefined ids when no upgrade URL is present', () => {
    const socket = createSocketStub();

    gateway.handleConnection(socket);

    expect(service.handleConnection).toHaveBeenCalledWith({
      socket,
      userId: undefined,
      clientId: undefined,
    });
  });

  it('delegates undefined ids when the URL has no query params', () => {
    const socket = createSocketStub();

    gateway.handleConnection(socket, { url: '/ws' });

    expect(service.handleConnection).toHaveBeenCalledWith({
      socket,
      userId: undefined,
      clientId: undefined,
    });
  });
});
