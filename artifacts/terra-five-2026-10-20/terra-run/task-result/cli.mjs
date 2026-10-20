import { slugify } from './slugify.mjs';

const args = process.argv.slice(2);

if (args.length === 0) {
  process.stderr.write('Usage: node cli.mjs <text>\n');
  process.exitCode = 1;
} else {
  process.stdout.write(`${slugify(args.join(' '))}\n`);
}
