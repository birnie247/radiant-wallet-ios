// Probe: try raw WebSocket connects from inside the app's page context, the
// way the app does, and report exactly how each one fails (close code, error)
// or succeeds. Self-contained: starts its own server + browser.
import { CDP, launchBrowser, sleep, startServer } from "./lib/browser-harness.mjs";

const PORT = 4193;
const DEBUG_PORT = 9224;
const urls = process.argv.slice(2);
if (urls.length === 0) {
  urls.push(
    "wss://electrumx.radiant4people.com:50022",
    "wss://electrumx2.radiant4people.com:50022",
    "wss://radiant2.bladenet.online:50022",
  );
}

const server = await startServer(PORT);
const chrome = launchBrowser({ debugPort: DEBUG_PORT });

try {
  const cdp = await CDP.attach(DEBUG_PORT);
  await cdp.send("Page.navigate", { url: `http://localhost:${PORT}/` });
  await cdp.waitForSelector("#root .app", 20_000);
  await sleep(300);

  for (const url of urls) {
    const result = await cdp.eval(
      `(() => new Promise((resolve) => {
         const out = { url: ${JSON.stringify(url)}, events: [] };
         let settled = false;
         const done = (why) => {
           if (settled) return;
           settled = true;
           out.final = why;
           try { ws.close(); } catch {}
           resolve(out);
         };
         let ws;
         try {
           ws = new WebSocket(${JSON.stringify(url)});
         } catch (e) {
           out.final = "ctor: " + e.message;
           return resolve(out);
         }
         const timer = setTimeout(() => done("timeout (8s)"), 8000);
         ws.onopen = () => {
           out.events.push("open");
           ws.send(JSON.stringify({ id: 1, method: "server.version", params: ["probe", "1.4"] }));
         };
         ws.onmessage = (e) => {
           out.events.push("message:" + String(e.data).slice(0, 80));
           clearTimeout(timer);
           done("ok");
         };
         ws.onerror = () => out.events.push("error");
         ws.onclose = (ev) => {
           out.events.push("close code=" + ev.code + " reason=" + (ev.reason || "-"));
           clearTimeout(timer);
           done("closed");
         };
       }))()`,
    );
    console.log(JSON.stringify(result, null, 2));
  }
} finally {
  chrome.kill();
  server.close();
}
process.exit(0);
