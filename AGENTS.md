# AGENTS.md — productionBackend

## What this codebase is

**NestJS 12 + TypeScript + Node 22** backend starter (Express platform).

Stack:
- Runtime: Node 22 Alpine, TypeScript 5.7, `target ES2023`, `module commonjs`
- Framework: `@nestjs/common`, `@nestjs/core`, `@nestjs/platform-express`, `rxjs`, `reflect-metadata`
- Cache/store: `redis` v6 client (`RedisClientType`) + `redis:7-alpine` service in `docker-compose.yml`
- Redis wiring: `src/redis/redis.module.ts` provides `REDIS_CLIENT` via `createClient({ socket: { host, port }, password, disableOfflineQueue: true })`; `src/redis/redis.service.ts` connects on `onModuleInit` with 10 attempts of exponential backoff (500ms → 5000ms cap), logs `error` events, quits on `onModuleDestroy` if `isOpen`; `GET /health` pings Redis (`ok/up`, else 503 `degraded/down`)
- Env: `REDIS_HOST` (default `localhost`, `redis` in compose), `REDIS_PORT` (default `6379`, validated 1–65535), `REDIS_PASSWORD` (optional; compose passes it to both `app` and `redis-server --requirepass`)
- Tests: **Vitest 5** (not Jest) + `supertest` for e2e, `@nestjs/testing` for DI
- Lint/format: ESLint 9 flat config + `typescript-eslint` + Prettier
- Build/run: `@nestjs/cli`, `nest build`, `node dist/main`
- Deploy: Multi-stage `Dockerfile` (build → production, non-root `node` user) + `docker-compose.yml` (`app` `depends_on: redis` `service_healthy`)

Source layout:
```
src/main.ts                    # bootstrap (global ValidationPipe, PORT)
src/app.module.ts              # root module (imports RedisModule; App + Health controllers)
src/app.controller.ts[.spec]   # GET / -> AppService.getHello()
src/app.service.ts             # Hello World provider
src/app.pipes.ts               # createGlobalValidationPipe factory
src/health/health.controller.ts[.spec]  # GET /health readiness probe via RedisService
src/redis/redis.module.ts      # REDIS_CLIENT factory + RedisService wiring
src/redis/redis.constants.ts   # REDIS_CLIENT token + getRedisConfig()
src/redis/redis.controller.ts[.spec]    # GET/POST /redis (thin HTTP adapter)
src/redis/redis.service.ts[.spec]       # Redis client lifecycle + get/set/ping
src/redis/dto/redis.dto.ts     # SetRedisDto / GetRedisDto / SetOptionsDto / ExpirationDto
test/app.e2e-spec.ts           # e2e specs via supertest
dist/                          # build output (generated, don't edit)
```

Entry flow: `src/main.ts:4 bootstrap()` → `AppModule` (+ `RedisModule`) → `AppController (@Controller())` → `AppService.getHello()`; `HealthController (@Controller('health'))` → `RedisService.ping()`.

Configs:
- `nest-cli.json`: `sourceRoot: src`, `deleteOutDir: true`
- `tsconfig.json`: `rootDir ./src`, `outDir ./dist`, `experimentalDecorators`, `emitDecoratorMetadata` (required for Nest DI — do not remove), `strict` (full strict mode, not just `strictNullChecks`), `skipLibCheck`
- `vitest.config.mts`: unit glob `src/**/*.spec.ts`
- `vitest.e2e.config.mts`: e2e glob `test/**/*.e2e-spec.ts`, `pool: forks`
- `eslint.config.mjs`: `recommendedTypeChecked` with `projectService`, `no-explicit-any/no-floating-promises/no-unsafe-argument: error`; type-checking disabled for `*.spec.ts` and `test/**`
- `docker-compose.yml`: `app` service, `${PORT:-3000}:${PORT:-3000}`, `NODE_ENV=production`

## Commands (use these, don't invent others)

```powershell
npm ci                  # install (prefer over npm install)
npm run start:dev       # dev with watch
npm run start:debug     # dev with debug + watch
npm run build           # nest build -> dist/
npm run start:prod      # node dist/main (after build)
npm test                # vitest run (unit: src/**/*.spec.ts)
npm run test:watch      # vitest watch mode
npm run test:cov        # vitest with v8 coverage
npm run test:e2e        # vitest e2e config
npm run lint            # eslint "{src,apps,libs,test}/**/*.ts" --fix
npm run format          # prettier --write
docker compose up --build
```

No test script uses Jest. Do not add Jest. Do not run `nest start` directly — use npm scripts.

## How to guide an AI coding agent here

### 1. NestJS conventions (mandatory)
- **Thin controllers, fat services:** `*.controller.ts` only handles routing, params, status codes. All logic goes in `*.service.ts` (`@Injectable()`).
- **DI first:** Register new providers in the `@Module({ controllers, providers })` in `app.module.ts` or a feature module. Never `new Service()` manually in production code.
- **Feature structure:** For a new domain `foo`, create `src/foo/foo.module.ts`, `foo.controller.ts`, `foo.service.ts`, `foo.service.spec.ts` (and DTOs under `src/foo/dto/`). Import `FooModule` into `AppModule.imports`. Use Nest CLI schematics naming: `*.module.ts`, `*.controller.ts`, `*.service.ts`, `*.spec.ts`.
- **Decorators required:** Keep `experimentalDecorators` + `emitDecoratorMetadata` semantics. Constructor injection must use TypeScript types (interfaces alone break DI — use classes/abstracts or `@Inject()` tokens).
- **Async:** Prefer `async/await`. Never leave floating promises — ESLint errors on `no-floating-promises`; always `await` or `return` or `void` explicitly.
- **Config/env:** Read port via `process.env.PORT ?? 3000` pattern in `main.ts`. For new env vars, use `??` defaults and add to `docker-compose.yml` + `Dockerfile` if needed at runtime.

### 2. TypeScript style (follow Google TypeScript Style Guide)

- Authoritative reference: https://google.github.io/styleguide/tsguide.html. Follow it for all TS code unless it conflicts with a rule below or a NestJS requirement (Nest DI/decorators win on conflict).
- Enforceable subset from Google guide:
  - **Imports/exports:** Use `import {X} from '...'` / `import * as ns from '...'`; `import type` for type-only imports. Named exports only — no `export default`, no `export let`, no `namespace Foo {}`, no `require()`. Minimize exported API surface.
  - **Variables:** `const` by default, `let` if reassigned, never `var`. One variable per declaration. No use-before-declare.
  - **Arrays/objects:** No `new Array()` / `new Object()`. No non-numeric props on arrays. Spread value must match target kind (iterables into arrays, objects into objects; never spread possibly-`null/undefined` without narrowing). Object iteration via `Object.keys/entries` + `for...of`, not unfiltered `for...in`.
  - **Destructuring:** Prefer object destructuring for multi-value params/returns. Destructured optional array params default to `[]`, optional object params to `{}`; keep param destructuring to one level of shorthand props.
  - **Classes:** No semicolon after class declaration; methods separated by one blank line. `readonly` for never-reassigned props; prefer parameter properties and field initializers over plumbing in constructor. No `#private` fields — use TS `private`/`protected`; never `public` modifier except on non-`readonly` constructor parameter properties. No container classes with only statics (export functions/consts instead); no direct `prototype` manipulation. Getters must be pure (no observable side effects). Constructor calls always use parens (`new Foo()`).
  - **Functions:** Prefer `function foo()` declarations for named functions; arrow functions for callbacks/nested closures needing `this`. No function expressions (except generators or intentional `this` rebinding, which is discouraged). Arrow concise bodies only when return value is used (else block body or `void`). Never pass bare named callbacks with mismatched arity (e.g. `.map(parseInt)` — wrap: `.map((n) => parseInt(n))`). Use rest params over `arguments`; never name a variable `arguments`. No blank lines at start/end of function body.
  - **`this`:** Only in class ctors/methods, functions with explicit `this:` type, or arrows in a valid `this` scope. Never to reach globals or bypass visibility (`obj['priv']` banned).
  - **Strings/numbers/coercion:** Single quotes; no `\`-line-continuations (use `+` concat); template literals over complex concat. `0x`/`0o`/`0b` lowercase, no stray leading zeros. Coerce via `String()`/`Boolean()`/template/`!!`; `Number()` + explicit `NaN`/`isFinite` check (never unary `+`, `parseInt/parseFloat` except validated non-base-10 radix). No `!!`/implicit truthiness for enums — compare explicitly.
  - **Control flow/typed code:** Braces required for `if/for/while`; `for...of` over `for...in` on arrays; `===`/`!==` only. No non-null assertion (`!`) or `as` casts to silence types without validation at the boundary.
- Existing repo rules (take precedence on conflict):
  - `strict` is on (full strict mode). Handle `null/undefined` explicitly. No `any` (`no-explicit-any` is error — prefer `unknown` + narrowing).
- `forceConsistentCasingInFileNames: true` — imports must match exact file casing.
- Prettier: default `.prettierrc`. Run `npm run format` on touched files. ESLint `sourceType: commonjs` — use `import` syntax (compiled to CJS), not `require`.
- Avoid unsafe args: `no-unsafe-argument` is error — validate external input at boundaries before passing to typed services.
- Every `*.ts` file must have a top-level `/** ... */` @fileoverview JSDoc explaining high-level functionality. Use bullet-point style, not conversational English. See pattern in `src\redis\redis.service.spec.ts:7`.
- Every function and method must have a function-level `/** ... */` JSDoc with @param and @return. Use bullet-point style, not conversational English. Document purpose, key steps/branches, and success vs. failure outcomes. See pattern in `src\redis\redis.service.ts:39` (`onModuleInit`) and `src\redis\redis.service.spec.ts:14` (`createClientFake`).
- JSDoc type annotations are redundant in TypeScript source code. Do not declare types in @param or @return blocks, do not write @implements, @enum, @private, @override etc. on code that uses the implements, enum, private, override etc. keywords.
- Decorators are syntax with an @ prefix, like @MyDecorator. Do not define new decorators. Only use the decorators defined by frameworks. JSDoc comments go before decorator

### 3. Testing requirements
- Unit tests live next to source: `src/**/*.spec.ts`, run with `npm test`. Use pattern from `src/app.controller.spec.ts:6`: `Test.createTestingModule({ controllers, providers }).compile()`.
- E2E tests live in `test/*.e2e-spec.ts`, run with `npm run test:e2e`. Use pattern from `test/app.e2e-spec.ts:7`: `createNestApplication()` + `app.init()` + `supertest(app.getHttpServer())`, always `await app.close()` in `afterEach`.
- Every new controller/service must ship with a unit spec; every new route must have e2e coverage. Do not break existing `GET /` assertion (`expect('Hello World!')`).
- Every `*.spec.ts` and `*.e2e-spec.ts` must start with a top-level `/** ... */` comment describing what the test suite covers (mocks used, lifecycle/behavior under test, success vs. failure cases). Use bullet-point style, not conversational English. See pattern in `src\redis\redis.service.spec.ts:7`.

### 4. Safe edit rules for agents
- Read `src/app.module.ts`, `package.json`, and relevant spec before editing.
- Smallest diff: don't reformat untouched files, don't upgrade Nest 12 / Node 22 / Vitest 5 unless asked.
- Don't edit `dist/`, `coverage/`, `node_modules/`, `*.tsbuildinfo`.
- Do not run `npm run build` for comments only changes
- After code changes, verify with `npm run build` only (unless the user explicitly requests lint/tests). Fix type errors before claiming done.
- Docker changes: keep non-root `USER node`, `npm ci --omit=dev`, `EXPOSE 3000`, `CMD ["node", "dist/main"]`.

### 5. When adding dependencies
- Check `package.json` first. Prefer Nest ecosystem packages. Use `npm install -S <pkg>` and import in a feature module, not in `main.ts` unless it's global middleware/config.
- If adding validation, use `class-validator` + `class-transformer` with a global `ValidationPipe`. If adding config, use `@nestjs/config`.

### 6. Environment / Shell (Windows-only)
- Running on Windows machine — use PowerShell (`powershell.exe`) only.
- Do not use Linux bash commands (`ls`, `cat`, `grep`, `sed`, `awk`, `rm -rf`, `&&`, `||`, `/` paths, etc.).
- Use PowerShell equivalents: `Get-ChildItem`, `Get-Content`, `Select-String`, `Remove-Item`, `;` to chain commands.
- Use `\` path separators and quote paths with spaces.
