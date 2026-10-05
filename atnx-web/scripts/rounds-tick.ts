// Runs one keeper tick, rounds step included when BM_ROUNDS_ENABLED=1 (set
// it on the command line to try rounds locally without turning them on
// for the cron). Handy for on-camera timing on a fast series.
//
//   npm run rounds:tick                                dry: nothing sent, nothing written
//   npm run rounds:tick -- --live                      a real tick
//   BM_ROUNDS_ENABLED=1 npm run rounds:tick -- --live
import { runKeeper } from '../lib/bm/keeper-run';

const live = process.argv.includes('--live');
if (process.env.BM_ROUNDS_ENABLED !== '1') console.warn('BM_ROUNDS_ENABLED is not 1: the rounds step will not run');
runKeeper({ dry: !live })
  .then((rep) => {
    console.log(JSON.stringify({ ...rep, notes: undefined }, null, 2));
    for (const n of rep.notes) console.log('  ' + n);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
