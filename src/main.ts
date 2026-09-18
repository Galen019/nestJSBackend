import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const port = (globalThis as { process?: { env?: { PORT?: string } } }).process?.env?.PORT ?? 3000;
  await app.listen(port);
}
bootstrap().catch((err) => {
  console.error(err);
  (globalThis as { process?: { exit?: (code: number) => void } }).process?.exit?.(1);
});
