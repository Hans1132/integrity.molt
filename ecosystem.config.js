'use strict';

module.exports = {
  apps: [
    {
      name: 'solrpds-poller',
      script: '/root/x402-server/scripts/start-poller-cron.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '500M',
      error_file: '/var/log/pm2/solrpds-poller-error.log',
      out_file: '/var/log/pm2/solrpds-poller-out.log',
      env: {
        NODE_ENV: 'production',
      },
    },
    // V4: Bitquery removal poller (hybrid architecture complement to V3 Helius poller)
    // Helius V3 → SWAP events; Bitquery V4 → REMOVAL events; together = SolRPDS methodology
    {
      name: 'solrpds-poller-v4-bitquery',
      script: '/root/x402-server/scripts/start-bitquery-cron.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '200M',
      error_file: '/var/log/pm2/solrpds-poller-v4-bitquery-error.log',
      out_file: '/var/log/pm2/solrpds-poller-v4-bitquery-out.log',
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
