// PM2 process definition for the ZTA-Equix (ZTA-Claude) dev server.
// Runs Vite's JS entry directly to avoid npm.cmd shell-wrapper issues on Windows.
const path = require('path');

module.exports = {
  apps: [
    {
      name: 'zta-equix',
      script: path.join(__dirname, 'node_modules', 'vite', 'bin', 'vite.js'),
      cwd: __dirname,
      interpreter: 'node',
      autorestart: true,
      time: true,
    },
  ],
};
