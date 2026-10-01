// Runs one keeper tick against the live registry and VI history.
//
//   npm run bm:keeper:dry            dry: nothing sent, nothing written
//   npm run bm:keeper:dry -- --live  a real tick, as the cron would run it
import { runKeeper } from '../lib/bm/keeper-run';

const live = process.argv.includes('--live');
runKeeper({ dry: !live })
  .then((rep) => {
    console.log(JSON.stringify({ ...rep, notes: undefined }, null, 2));
    for (const n of rep.notes) console.log('  ' + n);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
