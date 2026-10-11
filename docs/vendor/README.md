# Vendored fuzzball provenance

The browser fuzzy matcher is an exact, self-hosted copy from `fuzzball@2.2.3` (MIT).

## Locked source

- npm package: `fuzzball@2.2.3`
- npm source path: `node_modules/fuzzball/dist/fuzzball.umd.min.js`
- upstream license path: `node_modules/fuzzball/LICENSE.md`
- package-lock integrity: `sha512-sQDb3kjI7auA4YyE1YgEW85MTparcSgRgcCweUK06Cn0niY5lN+uhFiRUZKN4MQVGGiHxlbrYCA4nL1QjOXBLQ==`

| Committed file | SHA-256 |
| --- | --- |
| `fuzzball-2.2.3.umd.min.js` | `9a37a5c3f40af42aa7ea2daabcdbaaba7bc3458790b41abaf0f6825817201da1` |
| `fuzzball.LICENSE` | `28d0000d8857280206c926237c256ae8fe190e121415f1f17991586b7fb7d9e7` |

## Repeatable update and verification

1. Set the exact version in `package.json`, then run `npm install --package-lock-only --ignore-scripts` and `npm ci --ignore-scripts`.
2. Copy `node_modules/fuzzball/dist/fuzzball.umd.min.js` to `docs/vendor/fuzzball-<version>.umd.min.js` without transforming it.
3. Copy `node_modules/fuzzball/LICENSE.md` to `docs/vendor/fuzzball.LICENSE` without transforming it.
4. Run `Get-FileHash -Algorithm SHA256` on both committed files and update the table only when the locked package changes.
5. Run `npm test`; the security contract compares both committed files byte-for-byte with the installed locked package and exercises the production fuzzball-backed `BibLib` path.
