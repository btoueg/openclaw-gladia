import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { gladiaMediaUnderstandingProvider } from "./media-understanding-provider.js";

export default definePluginEntry({
  id: "gladia",
  name: "Gladia",
  description: "Gladia batch speech-to-text provider for OpenClaw",
  register(api) {
    api.registerMediaUnderstandingProvider(gladiaMediaUnderstandingProvider);
  },
});
