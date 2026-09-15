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

test("retries a 429 on upload with backoff and succeeds", async () => {
  let uploadAttempts = 0;
  const fetchFn = async (url, init) => {
    if (url === "https://api.gladia.io/v2/upload") {
      uploadAttempts += 1;
      if (uploadAttempts === 1) return jsonResponse({ message: "rate limited" }, 429);
      return jsonResponse({ audio_url: "https://api.gladia.io/file/test-audio" });
    }
    if (url === "https://api.gladia.io/v2/pre-recorded" && init.method === "POST") {
      return jsonResponse({ id: "job-1" }, 201);
    }
    if (url === "https://api.gladia.io/v2/pre-recorded/job-1") {
      return jsonResponse({
        status: "done",
        result: { transcription: { full_transcript: "bonjour" } },
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
    query: { retry_backoff_ms: 1, poll_interval_ms: 1 },
    timeoutMs: 1000,
    fetchFn,
  });

  assert.equal(result.text, "bonjour");
  assert.equal(uploadAttempts, 2);
});

test("retries a 5xx on job creation and succeeds", async () => {
  let jobAttempts = 0;
  const fetchFn = async (url, init) => {
    if (url === "https://api.gladia.io/v2/upload") {
      return jsonResponse({ audio_url: "https://api.gladia.io/file/test-audio" });
    }
    if (url === "https://api.gladia.io/v2/pre-recorded" && init.method === "POST") {
      jobAttempts += 1;
      if (jobAttempts === 1) return jsonResponse({ message: "upstream error" }, 502);
      return jsonResponse({ id: "job-1" }, 201);
    }
    if (url === "https://api.gladia.io/v2/pre-recorded/job-1") {
      return jsonResponse({
        status: "done",
        result: { transcription: { full_transcript: "voila" } },
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
    query: { retry_backoff_ms: 1, poll_interval_ms: 1 },
    timeoutMs: 1000,
    fetchFn,
  });

  assert.equal(result.text, "voila");
  assert.equal(jobAttempts, 2);
});

test("exhausted 429 retries surface the full error message", async () => {
  const fetchFn = async (url) => {
    if (url === "https://api.gladia.io/v2/upload") {
      return jsonResponse({ message: "rate limited" }, 429);
    }
    throw new Error(`Unexpected URL ${url}`);
  };

  await assert.rejects(
    transcribeGladiaAudio({
      buffer: Buffer.from("fake-audio"),
      fileName: "memo.wav",
      mime: "audio/wav",
      apiKey: "test-key",
      language: "fr",
      query: { max_retries: 2, retry_backoff_ms: 1 },
      timeoutMs: 1000,
      fetchFn,
    }),
    /Gladia upload failed: 429/,
  );
});

test("retries a transient network failure", async () => {
  let uploadAttempts = 0;
  const fetchFn = async (url) => {
    if (url === "https://api.gladia.io/v2/upload") {
      uploadAttempts += 1;
      if (uploadAttempts === 1) throw new Error("connection reset");
      return jsonResponse({ audio_url: "https://api.gladia.io/file/test-audio" });
    }
    if (url === "https://api.gladia.io/v2/pre-recorded") {
      return jsonResponse({ id: "job-1" }, 201);
    }
    if (url === "https://api.gladia.io/v2/pre-recorded/job-1") {
      return jsonResponse({
        status: "done",
        result: { transcription: { full_transcript: "ok" } },
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
    query: { retry_backoff_ms: 1, poll_interval_ms: 1 },
    timeoutMs: 1000,
    fetchFn,
  });

  assert.equal(result.text, "ok");
  assert.equal(uploadAttempts, 2);
});

test("concurrent transcriptions are serialized by default", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const pollCounters = new Map();
  const fetchFn = async (url, init) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      await sleep(5);
      if (url === "https://api.gladia.io/v2/upload") {
        return jsonResponse({ audio_url: `https://api.gladia.io/file/${init.headers["x-gladia-key"]}` });
      }
      if (url === "https://api.gladia.io/v2/pre-recorded" && init.method === "POST") {
        return jsonResponse({ id: init.headers["x-gladia-key"] }, 201);
      }
      if (url.startsWith("https://api.gladia.io/v2/pre-recorded/")) {
        const jobId = url.split("/").pop();
        const count = (pollCounters.get(jobId) ?? 0) + 1;
        pollCounters.set(jobId, count);
        return count === 1
          ? jsonResponse({ status: "processing" })
          : jsonResponse({
              status: "done",
              result: { transcription: { full_transcript: jobId } },
            });
      }
      throw new Error(`Unexpected URL ${url}`);
    } finally {
      inFlight -= 1;
    }
  };

  const transcribe = (apiKey) => transcribeGladiaAudio({
    buffer: Buffer.from("fake-audio"),
    fileName: "memo.wav",
    mime: "audio/wav",
    apiKey,
    language: "fr",
    query: { retry_backoff_ms: 1, poll_interval_ms: 1 },
    timeoutMs: 5000,
    fetchFn,
  });

  const [first, second] = await Promise.all([transcribe("job-a"), transcribe("job-b")]);
  assert.equal(first.text, "job-a");
  assert.equal(second.text, "job-b");
  assert.equal(maxInFlight, 1);
});

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
