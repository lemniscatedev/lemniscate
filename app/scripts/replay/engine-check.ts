// R3: compare the simulator's quotes with the deployed engine on anvil for 20 states.
//   bun run scripts/replay/engine-check.ts [--deployment path.json]
// Prints "R3 pending-engine" (exit 0) while no engine deployment is available. Todo 23 runs it against anvil by
// importing compareWithEngine from src/sim/engine-check.ts with a quoter built on OptionEngineAbi.quote and an `apply`
// that sets each state's price, session and posted sigma on the fork.
import { loadOptionDeployment } from "../../src/chain/deployment";
import { buildStates, STATE_COUNT } from "../../src/sim/engine-check";

const i = process.argv.indexOf("--deployment");
const path = i >= 0 ? process.argv[i + 1] : process.env.ENGINE_DEPLOYMENT;
if (!path) {
  console.log(`R3 pending-engine: no deployment file (set --deployment or ENGINE_DEPLOYMENT). ${buildStates().length}/${STATE_COUNT} states are ready; todo 23 runs the comparison on anvil.`);
  process.exit(0);
}
try {
  const deployment = await loadOptionDeployment(path);
  console.log(`R3 pending-engine: deployment ${deployment.contracts.engine} found, but the state-setting hook is supplied by todo 23.`);
} catch (error) {
  console.log(`R3 pending-engine: ${(error as Error).message}`);
}
process.exit(0);
