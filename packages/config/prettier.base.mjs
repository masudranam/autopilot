/** @type {import('prettier').Config} */
export default {
  semi: true,
  singleQuote: true,
  jsxSingleQuote: false,
  trailingComma: 'all',
  printWidth: 100,
  tabWidth: 2,
  useTabs: false,
  arrowParens: 'always',
  bracketSpacing: true,
  endOfLine: 'lf',
  overrides: [
    {
      files: ['*.md', '*.mdx'],
      options: { proseWrap: 'always', printWidth: 100 },
    },
    {
      files: ['*.yml', '*.yaml'],
      options: { singleQuote: false },
    },
    // *.prisma is deliberately absent: `prisma format` is the canonical formatter for
    // schema files and Prettier has no built-in parser for them — an override here
    // pointed at a nonexistent parser and broke format:check the day the first
    // schema.prisma appeared. The files are excluded via .prettierignore instead.
  ],
};
