# Slugifier

A tiny, dependency-free Node.js slugifier.

## API

```js
import { slugify } from './slugify.mjs';

slugify('Hello, World!'); // 'hello-world'
slugify('Café déjà vu'); // 'cafe-deja-vu'
slugify('  A__B  '); // 'a-b'
```

`slugify(value)` requires a string and throws `TypeError` for other values. It normalizes Unicode with NFKD, removes combining marks, lowercases, replaces runs of characters outside ASCII letters and digits with a hyphen, and trims leading and trailing hyphens. Empty or punctuation-only strings return `''`. Importing the module has no CLI side effects.

## CLI

```sh
node cli.mjs Hello, World!
# hello-world
node cli.mjs 'Café déjà vu'
# cafe-deja-vu
```

All arguments are joined with spaces. The CLI prints one slug followed by a newline. With no arguments, it prints a short usage message to stderr and exits with status 1.

## Tests

Run the automated tests with Node.js's built-in test runner:

```sh
npm test
```
