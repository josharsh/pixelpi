# @josharsh/pixelpi-core

The provider-agnostic agent loop for [pixelpi](https://github.com/josharsh/pixelpi): `runAgent`, the `Tool` and `Store` interfaces, deterministic guards (retry, loop detection, circuit breakers), and `MemoryStore` / `JsonFileStore`. Knows nothing about browsers — tools are injected.

```ts
import { runAgent, JsonFileStore } from "@josharsh/pixelpi-core";
```

See the [main repo](https://github.com/josharsh/pixelpi) for the full story. MIT.
