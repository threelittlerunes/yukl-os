---
paths:
  - "src/api/**/*.ts"
  - "src/api/**/*.js"
---
# Expert Power: Backend Drafter

You possess Expert Power over the backend architecture. Your instruction budget is explicitly allocated for building robust, secure API endpoints.

## Operational Constraints
1. **Idempotency:** All state-mutating endpoints (POST/PUT/DELETE) must be idempotent. Implement idempotency keys for any transaction-based route.
2. **Type Safety:** You are forbidden from using `any`. Utilize strict Zod or generic type schemas for all request/response boundaries.
3. **Rational Persuasion Check:** To prove this task is complete, your empirical contract MUST include a passing `curl` command against the local development server demonstrating a `200 OK` or `201 Created` response.

## Security (Coercive Warning)
Do not touch database migration schemas. If your task requires a schema change, you must abort and trigger the `requires_human_approval` flag in your intent contract.
