import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_GLADIA_AUDIO_MODEL,
  gladiaMediaUnderstandingProvider,
  transcribeGladiaAudio,
} from "../media-understanding-provider.js";

test("provider metadata exposes audio transcription", () => {
  assert.equal(gladiaMediaUnderstandingProvider.id, "gladia");
  assert.deepEqual(gladiaMediaUnderstandingProvider.capabilities, ["audio"]);
  assert.equal(gladiaMediaUnderstandingProvider.defaultModels.audio, DEFAULT_GLADIA_AUDIO_MODEL);
  assert.equal(typeof gladiaMediaUnderstandingProvider.transcribeAudio, "function");
});

test("transcribeGladiaAudio uploads, creates a job, polls, and returns transcript", async () => {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, init });
    if (url === "https://api.gladia.io/v2/upload") {
      assert.equal(init.method, "POST");
      assert.equal(init.headers["x-gladia-key"], "test-key");
      assert.equal(init.body.constructor.name, "FormData");
      return jsonResponse({ audio_url: "https://api.gladia.io/file/test-audio" });
    }
    if (url === "https://api.gladia.io/v2/pre-recorded" && init.method === "POST") {
      const body = JSON.parse(init.body);
      assert.equal(body.audio_url, "https://api.gladia.io/file/test-audio");
      assert.deepEqual(body.language_config, {
        languages: ["fr", "en"],
        code_switching: true,
      });
      assert.equal(body.diarization, true);
      return jsonResponse({ id: "job-1" }, 201);
    }
    if (url === "https://api.gladia.io/v2/pre-recorded/job-1") {
      return jsonResponse({
        status: "done",
        result: {
          transcription: {
            full_transcript: "bonjour le monde",
          },
        },
      });
    }
    throw new Error(`Unexpected URL ${url}`);
  };

  const result = await transcribeGladiaAudio({
    buffer: Buffer.from("fake-audio"),
    fileName: "memo.wav",
    mime: "audio/wav",
    apiKey: "test-key",
    language: "fr",
    query: {
      languages: "fr,en",
      code_switching: true,
      diarization: true,
      poll_interval_ms: 1,
    },
    timeoutMs: 1000,
    fetchFn,
  });

  assert.equal(result.text, "bonjour le monde");
  assert.equal(result.model, DEFAULT_GLADIA_AUDIO_MODEL);
  assert.equal(calls.length, 3);
});

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
