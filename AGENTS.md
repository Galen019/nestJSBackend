# AGENTS.md — productionBackend

NestJS 12 + TypeScript + Node 22 (Express). HTTP + WS gateway + Redis + DynamoDB + Prometheus + OTel + Jaeger.

## Layout (real entrypoints)

- `src/main.ts` bootstraps dotenv, global validation, WebSocket support, and the HTTP listener. `AppModule` wires auth, Redis, Dynamo, WebSocket, and metrics; `GET /` requires JWT, while `GET /health` is the sole public route.
- `src/redis/` owns shared client construction and graceful shutdown. `RedisService` retries connection up to 10 times; `POST /redis` defaults to a 3600-second TTL.
- `src/auth/` applies a global RS256 JWT guard to HTTP routes. The verifier checks signature, issuer, audience, and expiry, then sets `request.user`; configuration is read lazily and missing values never disable auth.
- `src/ws/` keeps sessions in a single-instance in-memory registry. Gateway identity requires `userId`, `clientId`, and a token whose `sub` matches `userId`; invalid connections and duplicate new client IDs close with 1008. Session trackers receive events through the registry's shared fan-out path.
- `src/user-topics/` subscribes to `user:{userId}` while that user has local sessions, using a dedicated Redis subscriber.
- `src/metrics/` records HTTP request counts and durations in a dedicated Prometheus registry. Labels use route templates (never raw paths); `/health` and `/metrics` are excluded. A separate server exposes `/metrics` on port 9464; `METRICS_ENABLED` controls that server, not recording.
- `scripts/test-ws.ts` and `scripts/test-redis.ts` are manual probes that sign test JWTs; `--no-auth` verifies rejection.
- E2E tests mirror `main.ts`, use shared auth/test fakes and the committed test-only keypair. Reuse helpers in `test/`; never hand-roll tokens or duplicate fakes.

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
- Every `*.ts` needs top-level `/** ... */` file overview; every function/method needs `/** ... */` with `@param`/`@return` (no type annotations in JSDoc — TS covers that). Every spec file starts with a `/** ... */` suite comment. Match existing bullet style. Keep comments brief, do not put bullet points for every single behavior case and code path.
- Unit specs colocate (`src/**/*.spec.ts`, `Test.createTestingModule(...).compile()`); new routes need e2e coverage. Keep `GET / → 'Hello World!'` green (it now requires a Bearer token — see e2e helper).
- Smallest diff; don't touch `dist/`, `coverage/`, `node_modules/`, `*.tsbuildinfo`; don't upgrade Nest/Node/Vitest unasked. After code changes verify with `npm run build` (plus `npm test`/`test:e2e` when behavior changed). Docker: keep non-root `USER node`, `npm ci --omit=dev`, `EXPOSE 3000`, `CMD ["node", "dist/main"]`.
- Windows-only shell: PowerShell, `;` to chain, `\` paths, quoted paths.
- Do not use linux commands like head, tail.
- Do not use emdash
- Make no mistakes