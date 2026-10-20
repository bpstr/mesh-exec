# Slugifier sample

Build a tiny dependency-free Node.js slugifier with automated tests and usage documentation.

Deliver exactly these new files (package.json and this roadmap are already supplied):
- `slugify.mjs`: export `slugify(value)`. Require a string (otherwise throw TypeError), normalize Unicode with NFKD, remove combining marks, lowercase, replace runs of non-ASCII-alphanumeric characters with one hyphen, and trim leading/trailing hyphens. Empty or punctuation-only input returns an empty string. Examples: `Hello, World!` -> `hello-world`, `Café déjà vu` -> `cafe-deja-vu`, `  A__B  ` -> `a-b`.
- `cli.mjs`: import the function; join all command-line arguments with spaces and print one slug followed by a newline. With no argument, write a short usage message to stderr and exit 1. Importing slugify.mjs must have no CLI side effects.
- `slugify.test.mjs`: Node's built-in test/assert tests for the examples, empty input, repeated separators, type errors, and CLI success and no-argument failure (spawn the CLI).
- `README.md`: describe the API, examples, CLI, and `npm test`.
