import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    testTimeout: 15000,
    // Não roda testes em paralelo por arquivo (o extrator compartilha caches)
    fileParallelism: false,
  },
});