# Syntax preferences

## Naming
- All functions are verbs: `createCard`, `createFooterBlocks`, `createField`
- No abbreviations: `button` not `b`, `scores` not `s`, `researchFacets` not `f`
- Options objects for optional params: `createButton(text, actionId, value, { style: 'primary' })`

## Types
- Use package type definitions, like `@slack/types`, never `object` or `object[]`
- Never use any.
- Never blindly cast. Perform a proper and robust type guard.
- Extract inline types to named types: `type ScoreCandidate = [string, string | undefined]`
- Function overloads over conditional return types when the return differs by argument shape

## Arrays
- Use `.at(n)` for index access — never `[n]`

## Switch cases
- Each `case` on its own line — never `case 'a': case 'b': return x` on one line

## Conditionals
- Never write one line conditionals, `if (condition) return`. Always multiline block

## Style
- No one-liner `if` bodies — always use braces
- No inline type assertions in array literals — extract to a named variable first
- `satisfies` for inline object literals that must match a known type
- No trailing semicolons on type declarations (`type Foo = { ... }` not `};`)

## Exports
- No re-exports of types from other modules — import directly from the source
- 

## Responses
- Use `createResponseInit('json' | 'html', status?)` from `#/headers` for all `new Response(body, ...)` calls — never inline `{ headers: JSON_H }` or `{ headers: HTML_H }`
- Plain-text error responses with no content-type (e.g. `new Response('not found', { status: 404 })`) are fine as-is

## Token scopes
- When adding or changing any Cloudflare binding (R2, D1, KV, Vectorize, AI, Secrets Store) or any GitHub Actions secret/variable, update `../token_scopes.yml` to reflect the required scopes for each token
- `service.sh` reads `token_scopes.yml` and will warn if a token in `.env` is missing a required scope entry

## File structure
- Named exports unless default is neccesary
- Never index barrel files


- `src/build/blocks/primitives.ts` — atomic Block Kit builders
- `src/build/blocks/components.ts` — reusable compositions
- `src/build/create*.ts` — one file per view/surface, named exports only, no barrel index
- `src/handlers/html.ts` — `escapeHtml`, `createPage`, `createConfirmPage`, `createEditPage`
- `src/headers.ts` — `createResponseInit`, `headers.json`, `headers.html`
- If a helper is only used in one view file, it lives in that file
