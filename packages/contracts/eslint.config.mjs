import base from '@repo/config/eslint';

export default [...base, { ignores: ['dist/**', 'vitest.config.mts'] }];
