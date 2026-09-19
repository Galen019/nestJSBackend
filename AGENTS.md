# AGENTS.md — productionBackend

## What this codebase is

Minimal **NestJS 12 + TypeScript + Node 22** backend starter (Express platform).
Currently just a Hello World API: `GET / -> "Hello World!"`.

Stack:
- Runtime: Node 22 Alpine, TypeScript 5.7, `target ES2023`, `module commonjs`
- Framework: `@nestjs/common`, `@nestjs/core`, `@nestjs/platform-express`, `rxjs`, `reflect-metadata`
- Tests: **Vitest 5** (not Jest) + `supertest` for e2e, `@nestjs/testing` for DI
- Lint/format: ESLint 9 flat config + `typescript-eslint` + Prettier
- Build/run: `@nestjs/cli`, `nest build`, `node dist/main`
- Deploy: Multi-stage `Dockerfile` (build → production, non-root `node` user) + `docker-compose.yml`

Source layout:
```
src/
  main.ts               # bootstrap: NestFactory.create(AppModule), listen PORT ?? 3000
  app.module.ts         # root module, wires controllers/providers
  app.controller.ts     # HTTP layer, thin, delegates to service
  app.service.ts        # business logic (@Injectable)
  app.controller.spec.ts# unit test (vitest)
test/
  app.e2e-spec.ts       # e2e test via supertest
dist/                   # build output (generated, don't edit)
```

Entry flow: `src/main.ts:4 bootstrap()` → `AppModule` → `AppController (@Controller())` → `AppService.getHello()`.

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

### 2. TypeScript style
- `strict` is on (full strict mode). Handle `null/undefined` explicitly. No `any` (`no-explicit-any` is error — prefer `unknown` + narrowing).
- `forceConsistentCasingInFileNames: true` — imports must match exact file casing.
- Prettier: default `.prettierrc`. Run `npm run format` on touched files. ESLint `sourceType: commonjs` — use `import` syntax (compiled to CJS), not `require`.
- Avoid unsafe args: `no-unsafe-argument` is error — validate external input at boundaries before passing to typed services.

### 3. Testing requirements
- Unit tests live next to source: `src/**/*.spec.ts`, run with `npm test`. Use pattern from `src/app.controller.spec.ts:6`: `Test.createTestingModule({ controllers, providers }).compile()`.
- E2E tests live in `test/*.e2e-spec.ts`, run with `npm run test:e2e`. Use pattern from `test/app.e2e-spec.ts:7`: `createNestApplication()` + `app.init()` + `supertest(app.getHttpServer())`, always `await app.close()` in `afterEach`.
- Every new controller/service must ship with a unit spec; every new route must have e2e coverage. Do not break existing `GET /` assertion (`expect('Hello World!')`).

### 4. Safe edit rules for agents
- Read `src/app.module.ts`, `package.json`, and relevant spec before editing.
- Smallest diff: don't reformat untouched files, don't upgrade Nest 12 / Node 22 / Vitest 5 unless asked.
- Don't edit `dist/`, `coverage/`, `node_modules/`, `*.tsbuildinfo`.
- Do not run `npm test`, `npm run test:e2e`, or `npm run lint` unless specifically directed to by the user.
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
