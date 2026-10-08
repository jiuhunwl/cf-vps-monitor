import { fileURLToPath } from 'node:url';

export default {
  plugins: {
    '@tailwindcss/postcss': {
      base: fileURLToPath(new URL('.', import.meta.url)),
      // Keep custom CSS unchanged; Vite performs production minification.
      optimize: false,
    },
    autoprefixer: {},
  },
};
