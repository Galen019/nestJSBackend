# AGENTS.md — productionBackend

NestJS 12 + TypeScript + Node 22 (Express). HTTP + WS gateway + gRPC microservice + Redis.

## Layout (real entrypoints)

- `src/main.ts:23 bootstrap()` — `import 'dotenv/config'` first line (loads repo-root `.env`; real shell env wins, dotenv never overrides it), global `ValidationPipe` (`src/app.pipes.ts`), `WsAdapter`, gRPC microservice (`push` package, `proto/push.proto`), `app.listen(process.env.PORT ?? 3000)`.
- `src/app.module.ts` — imports `AuthModule`, `RedisModule`, `WsModule`, `PushModule`; controllers `AppController` (`GET /`, requires JWT), `HealthController` (`GET /health` → `RedisService.ping()`, 503 `degraded/down` on failure; sole `@Public()` route).
- `src/redis/` — `REDIS_CLIENT` factory (`redis.constants.ts: getRedisConfig()`), `RedisService` lifecycle (connect w/ 10-attempt backoff, `quit` on destroy), thin `RedisController` (`GET/POST /redis`). `POST` without options applies edge default TTL `DEFAULT_SET_TTL_SECONDS = 3600`.
- `src/auth/` — global `JwtAuthGuard` via `APP_GUARD` (all HTTP routes require `Authorization: Bearer` RS256 except `@Public()`; non-HTTP contexts pass through). `JwtVerifierService` enforces signature + `iss`/`aud`/`exp`, attaches payload to `request.user`, logs the reason server-side at debug on 401. Config in `auth.constants.ts: getJwtConfig()` (`JWT_PUBLIC_KEY[_PATH]`, `JWT_ISSUER`, `JWT_AUDIENCE`; read lazily per verify, throws when missing so misconfiguration surfaces as 401 + debug log, never an open route). `AuthModule` exports only the verifier (guard is consumed via `APP_GUARD`).
- `src/ws/` — in-memory `Map<ClientId, Session>` registry in `WsService`. No Redis pub/sub: single-instance only, sessions lost on restart. Gateway at `path: '/ws'`; identity from `?userId=&clientId=&token=` parsed to branded ids + raw token (`session.interface.ts`: `parseUserId`/`parseClientId`/`parseToken`; tokens never reach the registry — `GatewayIdentity` stays gateway-local). Missing/invalid token, `sub`/`userId` mismatch, missing params → close 1008; duplicate `clientId` → close NEW socket 1008, keep old.
- `src/push/` — gRPC client-streaming `PushService.Publish` (`push.proto`): many `PublishRequest` chunks in, one `{ received }` summary out (counts chunks, not deliveries). `PushController` wires `StreamBudget.consume` → `PushService.publishNormalized` → `WsService.sendToClients`. Fire-and-forget per id; quotas in `push.constants.ts` (1000 ids/chunk, 1000 chunks/stream, 10k ids/stream, 256KB/chunk, 1MB/stream, 60s/stream, 100 concurrent streams via `beginStream()` slot).
- `src/push/push.controller.ts:publish()` — verifies `authorization: Bearer` gRPC metadata first (`UNAUTHENTICATED` on failure, before `beginStream()` so unauth calls never consume slots). Param is typed `Metadata`; unit specs fake it with `{ getMap: () => ({ authorization }) }` (grpc-js lowercase-normalizes keys — no other shapes needed).
- `proto/push.proto` — copied into Docker image (`Dockerfile` copies `proto/`); resolved at runtime via `getProtoPath()` = `process.cwd()/proto/push.proto`, override `GRPC_PROTO_PATH`. `GRPC_URL` default `0.0.0.0:50051` (compose: `GRPC_URL=0.0.0.0:${GRPC_PORT:-50051}`).
- `scripts/test-ws.ts`, `scripts/test-push.ts`, `scripts/test-redis.ts` — manual live probes (`npx ts-node [--transpile-only] scripts/...`). Each signs its own RS256 JWT (script = issuer, no IdP); `--no-auth` asserts the rejection path (WS: explicit negative probe expecting 1008; push: `UNAUTHENTICATED`; redis: 401).
- `test/app.e2e-spec.ts` (HTTP, mocks `RedisService`), `test/ws.e2e-spec.ts` (real `ws` clients, `app.listen(0)`), `test/auth-test.helper.ts` (`signTestToken`/`bearerHeader`, test code = issuer) + `test/fixtures/` committed test-only keypair (never prod).

## Gotchas (agent would miss)

- **proto-loader `keepCase: false` is load-bearing.** Server (`main.ts`) relies on camelCased `clientIds` in `normalizeChunk`. Do not set `keepCase: true` server-side. The CLI script uses `keepCase: true` + wire `client_ids` — that asymmetry is intentional.
- **Env:** `REDIS_HOST` (default `localhost`, `redis` in compose), `REDIS_PORT` (default 6379, throws on non-integer/out-of-range), `REDIS_PASSWORD` (empty → `undefined`); compose passes it to `redis-server --requirepass` and healthchecks with `redis-cli -a`. Redis factory sets `disableOfflineQueue: true`.
- **JWT env:** `JWT_PUBLIC_KEY_PATH` (preferred; relative paths resolve against the server cwd — use absolute when launch dir varies) or inline `JWT_PUBLIC_KEY` (`\n` sequences unescaped, for containers); `JWT_ISSUER`/`JWT_AUDIENCE` required. `dotenv` never overrides real shell env; compose auto-loads the project `.env`, so a local Windows path leaks into the container — use the inline key for container runs. Private key never touches the server: scripts sign via `TEST_PRIVATE_KEY_PATH` (defaults to the test fixture).
- **Validation:** global pipe is `whitelist + forbidNonWhitelisted + transform`. Extra fields and legacy flat Redis options (`{EX,NX}`) 400 by design.
- **E2E setup must mirror `main.ts`:** `app.useGlobalPipes(createGlobalValidationPipe())` + `app.useWebSocketAdapter(new WsAdapter(app))`, override `RedisService` with `useValue` fake, always `await app.close()` in `afterEach`. Set `JWT_PUBLIC_KEY_PATH`/`JWT_ISSUER`/`JWT_AUDIENCE` env before `compile()` (config is read lazily per verify); sign tokens with `test/auth-test.helper.ts`, never hand-roll JWTs.
- **CI (`.github/workflows/pr.yml`, Node 24) runs only `npm test` + `npm run lint`.** It does not build or run e2e — run those locally before claiming done.

## Commands (use these)

```powershell
npm ci                  # install, prefer over npm install
npm run start:dev       # watch
npm run build           # nest build -> dist/
npm run start:prod      # node dist/main (after build)
npm test                # vitest unit (src/**/*.spec.ts); single file: npx vitest run src/ws/ws.service.spec.ts
npm run test:e2e        # vitest e2e (test/**/*.e2e-spec.ts)
npm run lint            # eslint --fix (recommendedTypeChecked; no-explicit-any/no-floating-promises/no-unsafe-argument are errors)
npm run format          # prettier --write "src/**/*.ts" "test/**/*.ts"
docker compose up --build
```

No Jest. Don't run `nest start` directly.

## Conventions (repo-specific, enforced)

- Thin controllers / fat services. New domain `foo` → `src/foo/foo.module.ts`, `foo.controller.ts`, `foo.service.ts`, `foo.service.spec.ts` (+ `dto/`), import into `AppModule`. Never `new Service()` in prod code; constructor injection needs real types or `@Inject()` tokens (interfaces break DI — `emitDecoratorMetadata` must stay on).
- `strict` is on; no `any` (use `unknown` + narrowing); always `await`/`return`/`void` promises; validate at boundaries (DTOs + `parseUserId`/`parseClientId` + `assertValidKey`). `import` syntax only (compiled to CJS, `sourceType: commonjs`); match file casing (`forceConsistentCasingInFileNames`).
- Every `*.ts` needs top-level `/** ... */` file overview; every function/method needs `/** ... */` with `@param`/`@return` (no type annotations in JSDoc — TS covers that). Every spec file starts with a `/** ... */` suite comment (mocks, behavior, success/failure). Match existing bullet style.
- Unit specs colocate (`src/**/*.spec.ts`, `Test.createTestingModule(...).compile()`); new routes need e2e coverage. Keep `GET / → 'Hello World!'` green (it now requires a Bearer token — see e2e helper).
- Smallest diff; don't touch `dist/`, `coverage/`, `node_modules/`, `*.tsbuildinfo`; don't upgrade Nest/Node/Vitest unasked. After code changes verify with `npm run build` (plus `npm test`/`test:e2e` when behavior changed). Docker: keep non-root `USER node`, `npm ci --omit=dev`, `EXPOSE 3000 50051`, `CMD ["node", "dist/main"]`, copy `proto/` if touching the image.
- Windows-only shell: PowerShell, `;` to chain, `\` paths, quoted paths.
