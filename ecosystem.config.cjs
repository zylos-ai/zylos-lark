const path = require('path');
const os = require('os');

module.exports = {
  apps: [{
    name: 'zylos-lark',
    script: 'src/index.js',
    cwd: path.join(os.homedir(), 'zylos/.claude/skills/lark'),
    env: {
      NODE_ENV: 'production'
    },
    // autorestart also covers the WS half-open watchdog, which exits with code
    // 75 so PM2 starts a fresh process (src/lib/transport/websocket.js). Those
    // exits happen only after >= one full pong timeout (>= 30s, 360s by
    // default) of uptime, far above PM2's default min_uptime (1s), so they are
    // never counted as unstable restarts against max_restarts. The watchdog
    // also rate-limits itself (3 per 30 min, persisted in
    // ~/zylos/components/lark/ws-restart-state.json under a lock file).
    autorestart: true,
    max_restarts: 10,
    restart_delay: 5000,
    kill_timeout: 5000,
    error_file: path.join(os.homedir(), 'zylos/components/lark/logs/error.log'),
    out_file: path.join(os.homedir(), 'zylos/components/lark/logs/out.log'),
    log_date_format: 'YYYY-MM-DD HH:mm:ss'
  }]
};
