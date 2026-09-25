/**
 * Application bootstrap.
 */
import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { WsAdapter } from '@nestjs/platform-ws';
import { AppModule } from './app.module';
import { createGlobalValidationPipe } from './app.pipes';
import { getGrpcUrl, getProtoPath, PUSH_PACKAGE } from './push/push.constants';

/**
 * Boots the Nest application.
 *
 * - creates the app from AppModule
 * - applies the shared validation pipe
 * - registers the ws adapter for the `/ws` gateway
 * - connects the gRPC push microservice sharing the in-memory sessions
 * - listens on the configured port.
 *
 * @return Resolves when the server is listening.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app.useGlobalPipes(createGlobalValidationPipe());
  app.useWebSocketAdapter(new WsAdapter(app));
  // Default proto-loader options camelCase wire `client_ids` to `clientIds`,
  // which `normalizeChunk` relies on. Setting `keepCase: true` here would
  // silently turn every chunk into a no-op.
  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.GRPC,
    options: {
      package: PUSH_PACKAGE,
      protoPath: getProtoPath(),
      url: getGrpcUrl(),
    },
  });
  await app.startAllMicroservices();
  await app.listen(process.env.PORT ?? 3000);
}
bootstrap().catch((err) => {
  console.error(err);
  process.exit(1);
});
