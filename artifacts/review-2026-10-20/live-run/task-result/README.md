# Slugifier

A tiny dependency-free Node.js slugifier.

## API

`slugify(value)` accepts a string and returns a lowercase ASCII slug. It normalizes Unicode, removes combining marks, changes non-alphanumeric separator runs to one hyphen, and trims surrounding hyphens. Passing a non-string throws `TypeError`.

```js
import { slugify } from './slugify.mjs';

slugify('Hello, World!'); // 'hello-world'
slugify('Café déjà vu'); // 'cafe-deja-vu'
slugify('  A__B  '); // 'a-b'
```

## CLI

Pass words as command-line arguments; they are joined with spaces before slugification.

```sh
node cli.mjs Café déjà vu
# cafe-deja-vu
```

With no arguments, the CLI prints a usage message to standard error and exits with status 1.

## Tests

Run the automated tests with:

```sh
npm test
```
