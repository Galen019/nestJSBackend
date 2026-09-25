/**
 * JWT authentication feature module.
 *
 * - Provides the verifier plus the global guard (fail-closed HTTP auth)
 * - Imported once by AppModule, and by Ws/Push modules for direct verifies.
 */
import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtAuthGuard } from './jwt-auth.guard';
import { JwtVerifierService } from './jwt-verifier.service';

/**
 * Feature module wiring JWT verification across transports.
 *
 * - registers `JwtAuthGuard` as the global `APP_GUARD` for HTTP
 * - exports `JwtVerifierService` so WS/gRPC enforce the same claims.
 */
@Module({
  providers: [
    JwtVerifierService,
    JwtAuthGuard,
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
  exports: [JwtVerifierService],
})
export class AuthModule {}
