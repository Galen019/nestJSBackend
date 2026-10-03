/**
 * Test-only in-memory OpenTelemetry setup (no collector).
 *
 * - Registers a `BasicTracerProvider` with an `InMemorySpanExporter`
 * - Tests read finished spans from the returned exporter
 * - `shutdown` disables the global provider so tests never leak state.
 */
import { trace } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import type { SpanProcessor } from '@opentelemetry/sdk-trace-base';

/**
 * In-memory tracing handle for one test.
 *
 * - `exporter` collects finished spans for assertions
 * - `shutdown` flushes the provider and unregisters it globally.
 */
export interface InMemoryTracing {
  exporter: InMemorySpanExporter;
  shutdown: () => Promise<void>;
}

/**
 * Registers an in-memory tracer provider for the current test.
 *
 * - provider first so services under test delegate their tracers to it
 * - fresh exporter per call so finished spans never leak across tests
 * - `processors` overrides the default sink (throwing-exporter tests).
 *
 * @param processors Optional span processors, defaults to the in-memory sink.
 * @return The exporter plus a shutdown handle.
 */
export async function startInMemoryTracing(
  processors?: SpanProcessor[],
): Promise<InMemoryTracing> {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: processors ?? [new SimpleSpanProcessor(exporter)],
  });
  trace.setGlobalTracerProvider(provider);
  return {
    exporter,
    shutdown: async (): Promise<void> => {
      await provider.shutdown();
      trace.disable();
    },
  };
}
