import { slugify } from './slugify.mjs';

const args = process.argv.slice(2);

if (args.length === 0) {
  console.error('Usage: node cli.mjs <text>');
  process.exitCode = 1;
} else {
  console.log(slugify(args.join(' ')));
}
