// Which build is running (filled in by vite.config.js at build time)
export const BUILD = {
  commit: typeof __BUILD_COMMIT__ !== 'undefined' ? __BUILD_COMMIT__ : 'dev',
  time: typeof __BUILD_TIME__ !== 'undefined' ? __BUILD_TIME__ : 'dev server',
};
