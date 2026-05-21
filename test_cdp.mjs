import { getTargets } from './connectors/antigravity.mjs';
async function test() {
    const targets = await getTargets();
    console.log("Targets found:", targets.length);
    targets.forEach(t => console.log(`- ${t.projectName} | CDP: ${!!t.webSocketDebuggerUrl}`));
}
test();
