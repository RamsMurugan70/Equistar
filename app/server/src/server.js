// EquiStar — one participant's instance of the app.
//
// SINGLE-USER BY DESIGN, and that is the whole architecture. This process serves exactly one
// person and owns exactly one database file. Participants are kept apart by running a separate
// instance each, not by a user_id on every row — the app this was copied from has 33 tables and
// none of them carry one, so bolting tenancy on would have meant rewriting every query in 111
// files, where a single missed WHERE clause leaks one person's portfolio to another.
//
// The hub authenticates and routes each participant to their own instance. Nothing in here knows
// that other participants exist, which is exactly why it cannot leak to them.
//
// NOTHING RUNS ON A TIMER. The desktop app started five schedulers here — the universe scan,
// day-end broker capture, corporate actions, and two options jobs. All of them are gone:
//
//   * Broker capture happens when the participant presses Sync now on the Daily Sync page, and
//     at no other time. That is also the only moment it can work: neither broker session can be
//     renewed without a human, so an unattended attempt fails for anyone who has not logged in
//     to their broker that day.
//   * The universe scan and the corporate-actions refresh belong to the hub, not here. They
//     write shared market data that every instance reads, so running them per-instance would
//     mean 25 scans of the same 500 symbols in the same minute — enough to get the server's
//     address rate-limited by Yahoo, leaving everyone's Top 25 stale at once.
//
// The practical effect is that an idle instance does nothing at all: no wakeups, no upstream
// requests, no writes.
const app = require('./app');
const config = require('./config/env');

app.listen(config.port, () => {
  console.log(`EquiStar instance listening on http://localhost:${config.port}`);

  // Schema only. A write path that names a column the table lacks fails at INSERT time, and an
  // import that throws mid-save looks identical to one that found nothing new.
  try { require('./repositories/importsRepository').ensureOrderColumns(); }
  catch (e) { console.error('orders column migration failed:', e.message); }
});
