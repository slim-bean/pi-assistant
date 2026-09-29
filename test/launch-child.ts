// Separate process used by live.ts to exercise cross-process startup locks.
import { launchChrome, probe } from "../../pi-devtools/src/launch.ts";
import { ensureGateway } from "../src/gateway.ts";

if (process.argv[2] === "gateway") {
  const { identity } = await ensureGateway(JSON.parse(process.env.TEST_ASSISTANT_CONFIG!));
  console.log(JSON.stringify(identity));
} else {
  await launchChrome();
  console.log(JSON.stringify(await probe()));
}
