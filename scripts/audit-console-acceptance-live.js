process.env.XACTIONS_ACCEPTANCE_REQUIRE_LIVE = 'true';
process.env.XACTIONS_LIVE_USE_EXISTING_ACCOUNTS ||= 'true';

await import('./audit-console-acceptance.js');
