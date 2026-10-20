# Slugifier sample

A tiny, dependency-free Node.js utility that turns text into URL-friendly slugs.

## API

`slugify(value)` accepts a string and returns a lowercase ASCII slug. It normalizes Unicode, removes combining marks, collapses separators to a single hyphen, and removes leading and trailing hyphens. Passing a non-string throws `TypeError`.

```js
import { slugify } from './slugify.mjs';

slugify('Hello, World!'); // 'hello-world'
slugify('Café déjà vu'); // 'cafe-deja-vu'
slugify('  A__B  '); // 'a-b'
```

Empty or punctuation-only input produces an empty string.

## CLI

Pass text as command-line arguments. Arguments are joined with spaces before slugifying.

```sh
node cli.mjs Café déjà vu
# cafe-deja-vu
```

Run `node cli.mjs` with no arguments to see usage information. It exits with status 1.

## Tests

Run the automated tests with:

```sh
npm test
```
