# AGENTS.md — productionBackend

NestJS 12 + TypeScript + Node 22 (Express). HTTP + WS gateway + Redis.

## Layout (real entrypoints)

- `src/main.ts:23 bootstrap()` — `import 'dotenv/config'` first line (loads repo-root `.env`; real shell env wins, dotenv never overrides it), global `ValidationPipe` (`src/app.pipes.ts`), `WsAdapter`, `app.listen(process.env.PORT ?? 3000)`.
- `src/app.module.ts` — imports `AuthModule`, `RedisModule`, `WsModule`; controllers `AppController` (`GET /`, requires JWT), `HealthController` (`GET /health` → `RedisService.ping()`, 503 `degraded/down` on failure; sole `@Public()` route).
- `src/redis/` — `createRedisClient()` factory in `redis.constants.ts` (single owner of the construction policy, shared by command + subscriber clients), shared lifecycle helpers in `redis.lifecycle.ts` (`attachRedisErrorHandler`/`connectRedisClient`/`quitRedisClient`, used by every Redis-backed service), `RedisService` lifecycle (connect w/ 10-attempt backoff, `quit` on destroy), thin `RedisController` (`GET/POST /redis`). `POST` without options applies edge default TTL `DEFAULT_SET_TTL_SECONDS = 3600`.
- `src/auth/` — global `JwtAuthGuard` via `APP_GUARD` (all HTTP routes require `Authorization: Bearer` RS256 except `@Public()`; non-HTTP contexts pass through). `JwtVerifierService` enforces signature + `iss`/`aud`/`exp`, attaches payload to `request.user`, logs the reason server-side at debug on 401. Config in `auth.constants.ts: getJwtConfig()` (`JWT_PUBLIC_KEY_PATH`, `JWT_ISSUER`, `JWT_AUDIENCE`; read lazily per verify, throws when missing so misconfiguration surfaces as 401 + debug log, never an open route). `AuthModule` exports only the verifier (guard is consumed via `APP_GUARD`).
- `src/ws/` — in-memory `Map<ClientId, Session>` registry in `WsService`. Single-instance only, sessions lost on restart. Gateway at `path: '/ws'`; identity from `?userId=&clientId=&token=` parsed to branded ids + raw token (`session.interface.ts`: `parseUserId`/`parseClientId`/`parseToken`; tokens never reach the registry — `GatewayIdentity` stays gateway-local). Missing/invalid token, `sub`/`userId` mismatch, missing params → close 1008; duplicate `clientId` → close NEW socket 1008, keep old. Registry fans connects/disconnects out to `SESSION_TRACKERS` (`SessionTracker` in `session.interface.ts`); tracker N+1 is a `WsModule` wiring line, never a `WsService` edit. Per-user totals derive from the sessions map on demand — no second count map anywhere.
- `src/user-topics/` — `UserTopicsModule` (imported by `WsModule`, like `PresenceModule`) owns the dedicated `USER_TOPIC_SUBSCRIBER` connection plus `UserTopicService`, a `SessionTracker` that subscribes `user:{userId}` while local sessions exist (claim-set, no counts; background bounded-retry (un)subscribe, failures heal on next connect).
- `scripts/test-ws.ts`, `scripts/test-redis.ts` — manual live probes (`npx ts-node [--transpile-only] scripts/...`). Each signs its own RS256 JWT (script = issuer, no IdP); `--no-auth` asserts the rejection path (WS: explicit negative probe expecting 1008; redis: 401).
- `test/app.e2e-spec.ts` (HTTP, mocks `RedisService`), `test/ws.e2e-spec.ts` (real `ws` clients, `app.listen(0)`), `test/auth-test.helper.ts` (`signTestToken`/`bearerHeader`, test code = issuer) + `test/fixtures/` committed test-only keypair (never prod). Shared fakes live in `test/subscriber-test.helper.ts` (`createSubscriberFake`) and `test/ws-test.helper.ts` (`requireUserId`/`requireClientId`) — reuse them, never redefine locals.

## Gotchas (agent would miss)

- **Env:** `REDIS_HOST` (default `localhost`, `redis` in compose), `REDIS_PORT` (default 6379, throws on non-integer/out-of-range), `REDIS_PASSWORD` (empty → `undefined`); compose passes it to `redis-server --requirepass` and healthchecks with `redis-cli -a`. Redis factory sets `disableOfflineQueue: true`.
- **JWT env:** `JWT_PUBLIC_KEY_PATH` (file path to the PEM; relative paths resolve against the server cwd — use absolute when launch dir varies); `JWT_ISSUER`/`JWT_AUDIENCE` required. Compose mounts the key to the fixed container path `/run/secrets/jwt-public.pem` (host file defaults to `test/fixtures/test-public.pem` via `TEST_PUBLIC_KEY_PATH`); point it at the prod key for prod. Private key never touches the server: scripts sign via `TEST_PRIVATE_KEY_PATH` (defaults to the test fixture).
- **Validation:** global pipe is `whitelist + forbidNonWhitelisted + transform`. Extra fields and legacy flat Redis options (`{EX,NX}`) 400 by design.
- **E2E setup must mirror `main.ts`:** `app.useGlobalPipes(createGlobalValidationPipe())` + `app.useWebSocketAdapter(new WsAdapter(app))`, override `RedisService` with `useValue` fake, always `await app.close()` in `afterEach`. Set `JWT_PUBLIC_KEY_PATH`/`JWT_ISSUER`/`JWT_AUDIENCE` env before `compile()` (config is read lazily per verify); sign tokens with `test/auth-test.helper.ts`, never hand-roll JWTs.
- **CI (`.github/workflows/pr.yml`, Node 24):** `unit-test` runs `npm test` + `npm run test:e2e`, `linter` runs `npm run lint`.
- **CI `integration`:** `needs: [unit-test, linter]`, then `docker compose up -d --build` (JWT path/key default to the test fixture) + `scripts/test-redis.ts probe-2 hello` (`test-issuer`/`test-audience`; logs on failure, `down -v` always). It never runs `npm run build` — run that locally before claiming done.

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

## Required Workflow

**Before considering any task complete**, you MUST verify:

1. Run `npm run format` to auto-format code
2. Run `npm run lint` and fix all issues
3. Run `npm test` and `npm run test:e2e` and ensure all tests pass

These checks are mandatory for the entire repository, not just files you modified.

Do not skip, disable, or bypass these checks (e.g. `--no-verify`, commenting out linters, adding broad `//nolint` directives) to make CI pass. Fix the underlying issue.

## Tests

- All new functionality must include tests.
- Bug fixes must include a regression test that fails without the fix.
- Do not delete existing tests to make a build green. If a test is genuinely wrong, explain why in the PR description.
- Do not weaken assertions (e.g. replacing exact checks with `expect(data).not.toBeNull()`) just to make a flaky test pass.
- Every .ts file must have at least one `*spec.ts` file If no tests are possible (e.g. a package that only defines types), do nothing.

## Scope Discipline

- Do not reformat, rename, or restructure code outside the scope of the requested change.
- Do not bump dependencies unless the task requires it.
- Do not change CI workflows or release tooling unless explicitly asked.
- Before adding a flag or field that controls behavior, find the mechanism that already owns that decision and extend it. Expressing one decision in two places is worse than either place alone, and replacing an established mechanism is a maintainer's call.

## When in Doubt

Stop and ask rather than guessing. It is better to surface a question in the PR description than to invent behavior, fabricate API names, or silence failing checks.

Ask as well when you are *not* in doubt but are about to depart from a documented convention, because that is where confidence is least informative.

## Conventions (repo-specific, enforced)

- Thin controllers / fat services. New domain `foo` → `src/foo/foo.module.ts`, `foo.controller.ts`, `foo.service.ts`, `foo.service.spec.ts` (+ `dto/`), import into `AppModule`. Never `new Service()` in prod code; constructor injection needs real types or `@Inject()` tokens (interfaces break DI — `emitDecoratorMetadata` must stay on).
- `strict` is on; no `any` (use `unknown` + narrowing); always `await`/`return`/`void` promises; validate at boundaries (DTOs + `parseUserId`/`parseClientId` + `assertValidKey`). `import` syntax only (compiled to CJS, `sourceType: commonjs`); match file casing (`forceConsistentCasingInFileNames`).
- Every `*.ts` needs top-level `/** ... */` file overview; every function/method needs `/** ... */` with `@param`/`@return` (no type annotations in JSDoc — TS covers that). Every spec file starts with a `/** ... */` suite comment (mocks, behavior, success/failure). Match existing bullet style.
- Unit specs colocate (`src/**/*.spec.ts`, `Test.createTestingModule(...).compile()`); new routes need e2e coverage. Keep `GET / → 'Hello World!'` green (it now requires a Bearer token — see e2e helper).
- Smallest diff; don't touch `dist/`, `coverage/`, `node_modules/`, `*.tsbuildinfo`; don't upgrade Nest/Node/Vitest unasked. After code changes verify with `npm run build` (plus `npm test`/`test:e2e` when behavior changed). Docker: keep non-root `USER node`, `npm ci --omit=dev`, `EXPOSE 3000`, `CMD ["node", "dist/main"]`.
- Windows-only shell: PowerShell, `;` to chain, `\` paths, quoted paths.
- Do not use linux commands like head, tail.
