import { slugify } from './slugify.mjs';

const arguments_ = process.argv.slice(2);

if (arguments_.length === 0) {
  console.error('Usage: node cli.mjs <text>');
  process.exitCode = 1;
} else {
  console.log(slugify(arguments_.join(' ')));
}
