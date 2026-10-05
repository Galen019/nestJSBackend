/**
 * Application bootstrap.
 */
import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { WsServerAdapter } from './ws/ws.adapter';
import { createGlobalValidationPipe } from './app.pipes';
import { initTracing } from './tracing';

// Tracing starts before the Nest application is created so HTTP
// auto-instrumentation wraps the server created in `bootstrap`.
initTracing();

/**
 * Boots the Nest application.
 *
 * - creates the app from AppModule
 * - applies the shared validation pipe
 * - registers the ws adapter for the `/ws` gateway with the payload limit
 * - listens on the configured port.
 *
 * @return Resolves when the server is listening.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app.useGlobalPipes(createGlobalValidationPipe());
  app.useWebSocketAdapter(new WsServerAdapter(app));
  await app.listen(process.env.PORT ?? 3000);
}
bootstrap().catch((err) => {
  console.error(err);
  process.exit(1);
});
