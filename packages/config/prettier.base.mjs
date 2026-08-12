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
    {
      files: '*.prisma',
      options: { parser: 'prisma' },
    },
  ],
};
