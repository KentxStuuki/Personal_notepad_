'use strict';

// Packaging configuration. Every user-facing name comes from app.config.json.
const cfg = require('./app.config.json');

module.exports = {
  appId: cfg.appId,
  productName: cfg.productName,
  copyright: cfg.copyright,
  directories: { output: 'dist' },
  extraMetadata: { description: cfg.description, author: cfg.author },
  files: [
    'main.js',
    'preload.js',
    'index.html',
    'renderer.js',
    'styles.css',
    'theme-init.js',
    'app.config.json',
    'js/**/*',
    'assets/**/*',
    'package.json'
  ],
  win: {
    target: ['nsis', 'portable'],
    icon: cfg.icon,
    executableName: cfg.executableName
  },
  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    artifactName: `${cfg.installerName}-\${version}.\${ext}`,
    shortcutName: cfg.productName,
    uninstallDisplayName: cfg.productName
  },
  portable: {
    artifactName: `${cfg.portableName}-\${version}.\${ext}`
  }
};
