# Slugifier

A tiny, dependency-free Node.js utility for converting text into URL-friendly slugs.

## API

```js
import { slugify } from './slugify.mjs';

slugify('Café déjà vu'); // 'cafe-deja-vu'
```

`slugify(value)` accepts a string and returns a lowercase slug. It removes Unicode combining marks, turns runs of non-ASCII letters, digits, and separators into a single hyphen, and trims outer hyphens. It throws `TypeError` for non-string values.

Examples:

```js
slugify('Hello, World!'); // 'hello-world'
slugify('  A__B  ');      // 'a-b'
slugify('!!!');           // ''
```

## CLI

Pass text after the command; all arguments are joined with spaces:

```sh
node cli.mjs Café déjà vu
# cafe-deja-vu
```

Run it without arguments to see usage information.

## Tests

```sh
npm test
```
