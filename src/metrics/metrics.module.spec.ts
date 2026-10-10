/**
 * Unit suite for MetricsModule wiring.
 *
 * - compiles the real module with the global Meter provider
 * - asserts the recorder resolves and records without an SDK.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { MetricsModule } from './metrics.module';
import { MetricsService } from './metrics.service';

describe('MetricsModule', () => {
  let module: TestingModule | undefined;

  afterEach(async () => {
    await module?.close();
    module = undefined;
  });

  it('provides a working MetricsService from the global meter', async () => {
    module = await Test.createTestingModule({
      imports: [MetricsModule],
    }).compile();
    const service = module.get<MetricsService>(MetricsService);

    expect(service).toBeInstanceOf(MetricsService);
    expect(() =>
      service.recordRequest({
        route: '/redis',
        method: 'GET',
        statusCode: 200,
        durationSec: 0.01,
      }),
    ).not.toThrow();
  });
});
