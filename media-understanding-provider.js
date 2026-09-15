export const DEFAULT_GLADIA_BASE_URL = "https://api.gladia.io";
export const DEFAULT_GLADIA_AUDIO_MODEL = "solaria-1";

export const gladiaMediaUnderstandingProvider = {
  id: "gladia",
  capabilities: ["audio"],
  defaultModels: { audio: DEFAULT_GLADIA_AUDIO_MODEL },
  autoPriority: { audio: 45 },
  transcribeAudio: transcribeGladiaAudio,
};

// Module-level queue shared by every transcription in this process: voice
// notes arriving in a burst run one job at a time instead of racing past the
// Gladia plan concurrency limit (which answers 429).
const jobQueue = { active: 0, waiters: [] };

export async function transcribeGladiaAudio(req) {
  const fetchFn = req.fetchFn ?? fetch;
  const baseUrl = normalizeBaseUrl(req.baseUrl);
  const timeoutMs = normalizeTimeoutMs(req.timeoutMs);
  const deadline = Date.now() + timeoutMs;
  const query = req.query ?? {};
  const transport = {
    fetchFn,
    deadline,
    maxRetries: readNonNegativeNumber(query.max_retries ?? query.maxRetries, 3),
    backoffMs: readPositiveNumber(query.retry_backoff_ms ?? query.retryBackoffMs, 1000),
  };
  const maxConcurrent = readPositiveNumber(query.max_concurrent ?? query.maxConcurrent, 1);

  return withJobSlot(maxConcurrent, async () => {
    const uploaded = await uploadAudio({
      transport,
      baseUrl,
      apiKey: req.apiKey,
      buffer: req.buffer,
      fileName: req.fileName,
      mime: req.mime,
      timeoutMs,
    });
    const job = await createTranscriptionJob({
      transport,
      baseUrl,
      apiKey: req.apiKey,
      audioUrl: uploaded.audio_url,
      language: req.language,
      prompt: req.prompt,
      query,
      timeoutMs,
    });
    const result = await pollTranscriptionJob({
      transport,
      baseUrl,
      apiKey: req.apiKey,
      jobId: job.id,
      query,
      timeoutMs,
      deadline,
    });

    return {
      text: extractTranscript(result),
      model: DEFAULT_GLADIA_AUDIO_MODEL,
    };
  });
}

async function uploadAudio(params) {
  const form = new FormData();
  form.append(
    "audio",
    new Blob([params.buffer], {
      type: params.mime || "application/octet-stream",
    }),
    params.fileName || "audio",
  );

  const response = await fetchWithRetry(params.transport, `${params.baseUrl}/v2/upload`, {
    method: "POST",
    headers: gladiaHeaders(params.apiKey),
    body: form,
    timeoutMs: params.timeoutMs,
  });
  await assertOk(response, "Gladia upload failed");
  const json = await response.json();
  if (!isRecord(json) || typeof json.audio_url !== "string" || !json.audio_url) {
    throw new Error("Gladia upload response missing audio_url");
  }
  return json;
}

async function createTranscriptionJob(params) {
  const body = buildTranscriptionPayload(params);
  const response = await fetchWithRetry(params.transport, `${params.baseUrl}/v2/pre-recorded`, {
    method: "POST",
    headers: {
      ...gladiaHeaders(params.apiKey),
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    timeoutMs: params.timeoutMs,
  });
  await assertOk(response, "Gladia transcription job creation failed");
  const json = await response.json();
  if (!isRecord(json) || typeof json.id !== "string" || !json.id) {
    throw new Error("Gladia transcription job response missing id");
  }
  return json;
}

async function pollTranscriptionJob(params) {
  const pollIntervalMs = readPositiveNumber(params.query?.poll_interval_ms, 3000);
  while (remainingMs(params.deadline) > 0) {
    const response = await fetchWithRetry(
      params.transport,
      `${params.baseUrl}/v2/pre-recorded/${encodeURIComponent(params.jobId)}`,
      {
        method: "GET",
        headers: gladiaHeaders(params.apiKey),
        timeoutMs: Math.min(30000, Math.max(remainingMs(params.deadline), 0)),
      },
    );
    await assertOk(response, "Gladia transcription result fetch failed");
    const json = await response.json();
    if (!isRecord(json)) throw new Error("Gladia transcription result is not an object");

    if (json.status === "done") return json;
    if (json.status === "error") {
      const message = typeof json.error_code === "number"
        ? `Gladia transcription failed with status ${json.error_code}`
        : "Gladia transcription failed";
      throw new Error(message);
    }
    if (json.status !== "queued" && json.status !== "processing") {
      throw new Error(`Unexpected Gladia transcription status: ${String(json.status)}`);
    }
    await sleep(pollIntervalMs);
  }
  throw new Error(`Timed out waiting for Gladia transcription job ${params.jobId}`);
}

// Awaits `fn` while holding one of `limit` process-wide slots. Callers that
// exceed the limit park in FIFO order and re-check their own limit on wake.
async function withJobSlot(limit, fn) {
  while (jobQueue.active >= limit) {
    await new Promise((resolve) => jobQueue.waiters.push(resolve));
  }
  jobQueue.active += 1;
  try {
    return await fn();
  } finally {
    jobQueue.active -= 1;
    jobQueue.waiters.shift()?.();
  }
}

// Retries 429/5xx responses and network-level failures with exponential
// backoff, honoring Retry-After when present, until the shared deadline.
async function fetchWithRetry(transport, url, init) {
  const { fetchFn, deadline, maxRetries, backoffMs } = transport;
  let attempt = 0;
  for (;;) {
    let response;
    try {
      response = await fetchWithTimeout(fetchFn, url, {
        ...init,
        timeoutMs: Math.min(init.timeoutMs, Math.max(remainingMs(deadline), 0)),
      });
    } catch (error) {
      if (attempt >= maxRetries || remainingMs(deadline) <= 0) throw error;
      await sleep(retryDelayMs(null, attempt, backoffMs, deadline));
      attempt += 1;
      continue;
    }
    if (response.ok || !isRetryableStatus(response.status)) return response;
    if (attempt >= maxRetries || remainingMs(deadline) <= 0) return response;
    await sleep(retryDelayMs(response, attempt, backoffMs, deadline));
    attempt += 1;
  }
}

function isRetryableStatus(status) {
  return status === 429 || (status >= 500 && status <= 599);
}

function retryDelayMs(response, attempt, backoffMs, deadline) {
  const exponential = backoffMs * 2 ** attempt;
  const retryAfter = readRetryAfterMs(response);
  const delay = Math.max(retryAfter ?? 0, exponential);
  return Math.max(0, Math.min(delay, remainingMs(deadline)));
}

function readRetryAfterMs(response) {
  const raw = response?.headers?.get?.("retry-after");
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const dateMs = Date.parse(raw);
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - Date.now()) : null;
}

function buildTranscriptionPayload(params) {
  const languages = resolveLanguages(params.language, params.query);
  const query = params.query ?? {};
  const payload = {
    audio_url: params.audioUrl,
    language_config: {
      languages,
      code_switching: readBoolean(query.code_switching ?? query.codeSwitching, false),
    },
  };

  if (params.prompt?.trim()) {
    payload.context_prompt = params.prompt.trim();
  }
  if (readBoolean(query.diarization, false)) {
    payload.diarization = true;
  }
  if (readBoolean(query.sentences, false)) {
    payload.sentences = true;
  }
  if (readBoolean(query.punctuation_enhanced ?? query.punctuationEnhanced, false)) {
    payload.punctuation_enhanced = true;
  }

  return payload;
}

function extractTranscript(result) {
  const transcription = isRecord(result.result) && isRecord(result.result.transcription)
    ? result.result.transcription
    : undefined;
  if (isRecord(transcription) && typeof transcription.full_transcript === "string") {
    return transcription.full_transcript;
  }
  if (isRecord(transcription) && Array.isArray(transcription.utterances)) {
    return transcription.utterances
      .map((utterance) => isRecord(utterance) && typeof utterance.text === "string" ? utterance.text : "")
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function resolveLanguages(language, query) {
  const raw = query?.languages ?? query?.language ?? language;
  if (typeof raw === "string") {
    return raw.split(",").map((value) => value.trim()).filter(Boolean);
  }
  return [];
}

async function fetchWithTimeout(fetchFn, url, init) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), init.timeoutMs);
  try {
    const { timeoutMs: _timeoutMs, ...fetchInit } = init;
    return await fetchFn(url, {
      ...fetchInit,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function assertOk(response, message) {
  if (response.ok) return;
  const text = await safeResponseText(response);
  throw new Error(`${message}: ${response.status}${text ? ` ${text}` : ""}`);
}

async function safeResponseText(response) {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function gladiaHeaders(apiKey) {
  return { "x-gladia-key": apiKey };
}

function normalizeBaseUrl(baseUrl) {
  return (baseUrl?.trim() || DEFAULT_GLADIA_BASE_URL).replace(/\/+$/, "");
}

function normalizeTimeoutMs(timeoutMs) {
  return Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 900000;
}

function readBoolean(value, fallback) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value !== "string") return fallback;
  switch (value.trim().toLowerCase()) {
    case "1":
    case "true":
    case "yes":
    case "on":
      return true;
    case "0":
    case "false":
    case "no":
    case "off":
      return false;
    default:
      return fallback;
  }
}

function readPositiveNumber(value, fallback) {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function readNonNegativeNumber(value, fallback) {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function remainingMs(deadline) {
  return deadline - Date.now();
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
