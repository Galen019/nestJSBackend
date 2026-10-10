/**
 * Unit suite for MetricsService.
 *
 * - fakes the Meter so no SDK or exporter is needed
 * - covers counter+histogram recording and the health skip.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import type { Meter } from '@opentelemetry/api';
import { METRICS_METER_TOKEN } from './metrics.constants';
import { MetricsService } from './metrics.service';

/**
 * Captured instrument calls for assertions.
 */
interface MeterCalls {
  added: { value: number; attributes: unknown }[];
  recorded: { value: number; attributes: unknown }[];
}

/**
 * Builds a fake Meter capturing counter and histogram calls.
 *
 * @return The fake meter plus its captured calls.
 */
function createMeterFake(): { meter: Meter; calls: MeterCalls } {
  const calls: MeterCalls = { added: [], recorded: [] };
  const counter = {
    add: (value: number, attributes: unknown): void => {
      calls.added.push({ value, attributes });
    },
  };
  const histogram = {
    record: (value: number, attributes: unknown): void => {
      calls.recorded.push({ value, attributes });
    },
  };
  const meter = {
    createCounter: () => counter,
    createHistogram: () => histogram,
  } as unknown as Meter;
  return { meter, calls };
}

describe('MetricsService', () => {
  let module: TestingModule | undefined;
  let service: MetricsService;
  let calls: MeterCalls;

  beforeEach(async () => {
    const fake = createMeterFake();
    calls = fake.calls;
    module = await Test.createTestingModule({
      providers: [
        MetricsService,
        { provide: METRICS_METER_TOKEN, useValue: fake.meter },
      ],
    }).compile();
    service = module.get<MetricsService>(MetricsService);
  });

  it('increments the counter and records duration with labels', () => {
    service.recordRequest({
      route: '/redis',
      method: 'GET',
      statusCode: 200,
      durationSec: 0.05,
    });

    expect(calls.added).toEqual([
      {
        value: 1,
        attributes: {
          'http.route': '/redis',
          'http.method': 'GET',
          'http.status_code': '200',
        },
      },
    ]);
    expect(calls.recorded).toHaveLength(1);
    expect(calls.recorded[0]?.value).toBe(0.05);
    expect(calls.recorded[0]?.attributes).toEqual(calls.added[0]?.attributes);
  });

  it('stores the status code as a string', () => {
    service.recordRequest({
      route: '/redis',
      method: 'POST',
      statusCode: 201,
      durationSec: 0.01,
    });

    expect(calls.added[0]?.attributes).toMatchObject({
      'http.status_code': '201',
    });
  });

  it('skips health probes on both instruments', () => {
    service.recordRequest({
      route: '/health',
      method: 'GET',
      statusCode: 200,
      durationSec: 0.01,
    });

    expect(calls.added).toHaveLength(0);
    expect(calls.recorded).toHaveLength(0);
  });
});
