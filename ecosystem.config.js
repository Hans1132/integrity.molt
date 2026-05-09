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
    // V4: Bitquery-based pipeline (replaces V3 Helius poller logic)
    // Start only after BITQUERY_API_KEY is set in .env
    {
      name: 'solrpds-poller-v4',
      script: '/root/x402-server/scripts/start-bitquery-cron.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '500M',
      error_file: '/var/log/pm2/solrpds-poller-v4-error.log',
      out_file: '/var/log/pm2/solrpds-poller-v4-out.log',
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
