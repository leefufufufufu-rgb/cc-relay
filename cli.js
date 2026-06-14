#!/usr/bin/env node
'use strict';
// cc-relay entry point.
// Used both as the `cc-relay` command and, via the claude/cc shims, as `node cli.js <args>`.
// Routing: reserved subcommands (enroll/status/switch/install/uninstall/_hook) take priority;
// everything else is passed through to the target CLI.
const sub = process.argv[2] || '';

(async () => {
  try {
    switch (sub) {
      case '_hook':
        return await require('./lib/hook').runHook();
      case 'enroll':
        return await require('./lib/relay').enrollCmd(process.argv[3]);
      case 'status':
        return await require('./lib/relay').statusCmd();
      case 'switch':
        return await require('./lib/relay').switchCmd();
      case 'set-upstream-proxy':
        return require('./lib/relay').setProxyCmd(process.argv[3]);
      case 'install':
        return await require('./lib/install').install(process.argv.slice(3));
      case 'uninstall':
        return require('./lib/install').uninstall();
      default:
        return await require('./lib/run').run(process.argv.slice(2));
    }
  } catch (e) {
    console.error('[cc-relay] ' + (e && e.message ? e.message : e));
    process.exit(1);
  }
})();
