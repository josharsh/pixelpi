# @josharsh/pixelpi-ai

The model layer for [pixelpi](https://github.com/josharsh/pixelpi): one thin `LLMProvider` interface over Anthropic and OpenAI, with friendly, actionable error mapping. Bring your own key.

```ts
import { createProvider } from "@josharsh/pixelpi-ai";

const provider = createProvider({ provider: "anthropic", model: "claude-sonnet-4-6" });
```

See the [main repo](https://github.com/josharsh/pixelpi) for the full story. MIT.
