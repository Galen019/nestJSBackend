/**
 * Application bootstrap.
 */
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { createGlobalValidationPipe } from './app.pipes';

/**
 * Boots the Nest application.
 *
 * - creates the app from AppModule
 * - applies the shared validation pipe
 * - listens on the configured port.
 *
 * @return Resolves when the server is listening.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app.useGlobalPipes(createGlobalValidationPipe());
  await app.listen(process.env.PORT ?? 3000);
}
bootstrap().catch((err) => {
  console.error(err);
  process.exit(1);
});
