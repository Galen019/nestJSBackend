/**
 * Prometheus registry, HTTP observation, and scrape server.
 *
 * - Owns a dedicated prom-client Registry (never the global register)
 * - Exposes http_requests_total, http_request_duration_seconds,
 *   http_request_size_bytes, and http_response_size_bytes with
 *   method/route/status_code labels for the middleware
 * - Tracks in-flight requests as http_in_flight_requests via an idempotent
 *   release callback
 * - Registers prom-client default Node.js/process metrics (nodejs_*, process_*)
 *   on the same registry for the runtime dashboard
 * - Starts the standalone scrape server onModuleInit when enabled; the
 *   server is best-effort, bind failures are logged and the API keeps serving
 * - Closes the scrape server onModuleDestroy.
 */
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  Summary,
  collectDefaultMetrics,
} from 'prom-client';
import {
  HISTOGRAM_BUCKETS,
  HTTP_IN_FLIGHT_REQUESTS,
  HTTP_REQUESTS_TOTAL,
  HTTP_REQUEST_DURATION_SECONDS,
  HTTP_REQUEST_SIZE_BYTES,
  HTTP_RESPONSE_SIZE_BYTES,
  METRICS_PATH,
  METRICS_PORT,
  getMetricsConfig,
} from './metrics.constants';

/** Label names shared by the HTTP counter, histogram, and size summaries. */
const HTTP_LABELS = ['method', 'route', 'status_code'] as const;

/** Single HTTP observation recorded by the middleware. */
export interface HttpObservation {
  method: string;
  route: string;
  statusCode: number;
  durationSeconds: number;
  requestBytes: number;
  responseBytes: number;
}

/**
 * In-process Prometheus metrics for HTTP traffic plus the scrape server.
 *
 * - HTTP counter, histogram, size summaries, and default runtime collectors
 *   are created once per instance
 * - trackInFlight returns an idempotent release for the in-flight gauge
 * - observeHttp is safe to call for every request including rejections.
 */
@Injectable()
export class MetricsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MetricsService.name);
  private readonly registry = new Registry();
  private readonly requestsTotal: Counter<string>;
  private readonly requestDuration: Histogram<string>;
  private readonly requestSizeBytes: Summary<string>;
  private readonly responseSizeBytes: Summary<string>;
  private readonly inFlightRequests: Gauge<string>;
  private server: Server | undefined;

  /** Creates the registry with HTTP, size, and default runtime metrics once. */
  constructor() {
    this.requestsTotal = new Counter({
      name: HTTP_REQUESTS_TOTAL,
      help: 'Total HTTP requests by method, route template, and status code.',
      labelNames: [...HTTP_LABELS],
      registers: [this.registry],
    });
    this.requestDuration = new Histogram({
      name: HTTP_REQUEST_DURATION_SECONDS,
      help: 'HTTP request duration in seconds by method, route, and status.',
      labelNames: [...HTTP_LABELS],
      buckets: [...HISTOGRAM_BUCKETS],
      registers: [this.registry],
    });
    this.requestSizeBytes = this.createSizeSummary(
      HTTP_REQUEST_SIZE_BYTES,
      'HTTP request body size in bytes by method, route, and status.',
    );
    this.responseSizeBytes = this.createSizeSummary(
      HTTP_RESPONSE_SIZE_BYTES,
      'HTTP response body size in bytes by method, route, and status.',
    );
    this.inFlightRequests = new Gauge({
      name: HTTP_IN_FLIGHT_REQUESTS,
      help: 'Application requests currently being handled (health probes excluded).',
      registers: [this.registry],
    });
    collectDefaultMetrics({ register: this.registry });
  }

  /**
   * Starts the scrape server unless METRICS_ENABLED disables it.
   *
   * @return Resolves once the server is listening or skipped.
   */
  async onModuleInit(): Promise<void> {
    if (!getMetricsConfig().enabled) {
      return;
    }
    try {
      this.server = await this.listen();
      this.logger.log(`Metrics scraping on :${METRICS_PORT}/metrics`);
    } catch (error) {
      this.server = undefined;
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to start scrape server: ${detail}`);
    }
  }

  /**
   * Closes the scrape server when it was started.
   *
   * @return Resolves once the server is closed or when never started.
   */
  async onModuleDestroy(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (server === undefined) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      server.close((error?: Error) => {
        if (error !== undefined) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  /**
   * Records one completed HTTP request.
   *
   * @param observation Method, route template, status code, duration, and sizes.
   */
  observeHttp(observation: HttpObservation): void {
    if (
      !Number.isFinite(observation.durationSeconds) ||
      observation.durationSeconds < 0
    ) {
      throw new Error(
        `Invalid durationSeconds: ${String(observation.durationSeconds)}`,
      );
    }
    if (
      !Number.isFinite(observation.requestBytes) ||
      observation.requestBytes < 0 ||
      !Number.isFinite(observation.responseBytes) ||
      observation.responseBytes < 0
    ) {
      throw new Error(
        `Invalid byte sizes: ${String(observation.requestBytes)}, ${String(observation.responseBytes)}`,
      );
    }
    const labels = {
      method: observation.method,
      route: observation.route,
      status_code: String(observation.statusCode),
    };
    this.requestsTotal.inc(labels);
    this.requestDuration.observe(labels, observation.durationSeconds);
    this.requestSizeBytes.observe(labels, observation.requestBytes);
    this.responseSizeBytes.observe(labels, observation.responseBytes);
  }

  /**
   * Marks one request as in flight until the returned callback runs.
   *
   * @return Idempotent release callback, safe to call on finish and close.
   */
  trackInFlight(): () => void {
    this.inFlightRequests.inc();
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      this.inFlightRequests.dec();
    };
  }

  /**
   * Resolves the Content-Type for the scrape response.
   *
   * @return The registry exposition content type.
   */
  getContentType(): string {
    return this.registry.contentType;
  }

  /**
   * Renders the registry in the Prometheus exposition format.
   *
   * @return The scrape body served on the metrics port.
   */
  getMetrics(): Promise<string> {
    return this.registry.metrics();
  }

  /**
   * Builds a byte-size summary without quantiles to keep cardinality low.
   *
   * @param name Metric name, exposed with the _sum and _count suffixes.
   * @param help Human-readable metric help.
   * @return The registered summary.
   */
  private createSizeSummary(name: string, help: string): Summary<string> {
    return new Summary({
      name,
      help,
      labelNames: [...HTTP_LABELS],
      percentiles: [],
      registers: [this.registry],
    });
  }

  /**
   * Binds the standalone scrape server on the fixed metrics port.
   *
   * @return The listening server.
   */
  private listen(): Promise<Server> {
    const server = createServer(
      (request: IncomingMessage, response: ServerResponse) => {
        void this.handleScrape(request, response);
      },
    );
    return new Promise<Server>((resolve, reject) => {
      server.once('error', reject);
      server.listen(METRICS_PORT, () => {
        server.removeListener('error', reject);
        resolve(server);
      });
    });
  }

  /**
   * Handles one scrape-server request against the metrics registry.
   *
   * @param request Incoming HTTP request.
   * @param response Outgoing HTTP response, completed by this handler.
   */
  private async handleScrape(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (request.method !== 'GET' || pathname !== METRICS_PATH) {
      response.writeHead(404, { 'Content-Type': 'text/plain' });
      response.end('not found');
      return;
    }
    try {
      const body = await this.getMetrics();
      response.writeHead(200, { 'Content-Type': this.getContentType() });
      response.end(body);
    } catch {
      response.writeHead(500, { 'Content-Type': 'text/plain' });
      response.end('metrics unavailable');
    }
  }
}
