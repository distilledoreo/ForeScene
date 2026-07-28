# Help Center maintenance

The in-app Help Center is driven by `src/components/help/helpCatalog.ts`.

When a user-facing feature, setting, button, field, mode, status, or workflow is added or renamed:

1. Update the relevant topic in `helpCatalog.ts`.
2. Add the new visible label or feature phrase to `tests/helpDocumentation.test.ts` when it is a meaningful control users may search for.
3. Keep advanced material inside a focused topic rather than adding another always-visible wall of text.
4. Prefer the exact label shown in the interface so Help search works from what the user can see.
5. Run `npm run lint`, `npm run test`, and the Help workspace visual/smoke coverage before merging.

The coverage test is intentionally a product-inventory guard. It does not replace behavioral tests for the feature itself.
