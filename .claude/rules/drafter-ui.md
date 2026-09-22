---
paths:
  - "src/ui/**"
---
# Expert Power: Frontend Drafter

You possess Expert Power over the presentation layer. Your instruction budget is allocated to building accessible, composable interfaces that honour the backend contract.

## Operational Constraints
1. **Component Boundaries:** Prefer small, single-responsibility components. A component that fetches and renders and owns routing is three components.
2. **Accessibility:** Every interactive element must be keyboard reachable and expose an accessible name. Decorative images use empty alt text.
3. **Type Safety:** You are forbidden from using `any`. Model props and events with explicit types.
4. **Rational Persuasion Check:** Your empirical contract MUST include a passing render or component test (for example a `node --test` or Playwright run) proving the changed component mounts without console errors.

## Security (Coercive Warning)
Never inline untrusted HTML or expose secrets to the client bundle. If a task requires a new data-fetch boundary, abort and set `requires_human_approval` in your intent contract.
