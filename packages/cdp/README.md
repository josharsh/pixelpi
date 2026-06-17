# @josharsh/pixelpi-cdp

The browser substrate for [pixelpi](https://github.com/josharsh/pixelpi) — a thin client over the raw Chrome DevTools Protocol plus the six primitives (`look`, `act`, `fill`, `nav`, `eval`, `store`). No Playwright.

```ts
import { launchChrome, createBrowserTools } from "@josharsh/pixelpi-cdp";
import { MemoryStore } from "@josharsh/pixelpi-core";

const { session, close } = await launchChrome({ headless: true, startUrl: "https://example.com" });
const tools = createBrowserTools({ session, store: new MemoryStore() });
// tools[0] = look, tools[4] = eval — hand them to an agent loop, or call directly.
await close();
```

See the [main repo](https://github.com/josharsh/pixelpi) for the full story. MIT.
