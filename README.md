# OpenClaw Gladia

Gladia batch speech-to-text provider for OpenClaw media understanding.

This plugin registers the `gladia` media-understanding provider for audio
transcription. It uses Gladia v2 pre-recorded transcription:

1. `POST /v2/upload`
2. `POST /v2/pre-recorded`
3. poll `GET /v2/pre-recorded/{id}` until `done`

## Install Locally

```bash
cd openclaw-gladia
openclaw plugins install .
openclaw gateway restart
```

## Configure

Expose the Gladia API key to the Gateway:

```bash
GLADIA_API_KEY=gladia_xxx
```

Then configure audio media understanding in `~/.openclaw/openclaw.json`:

```js
{
  tools: {
    media: {
      audio: {
        enabled: true,
        maxBytes: 20971520,
        models: [
          {
            provider: "gladia",
            model: "solaria-1",
            language: "fr"
          }
        ]
      }
    }
  }
}
```

## Use

```bash
openclaw infer audio transcribe --file ./memo.m4a --model gladia/solaria-1 --json
```

Provider options can be passed through OpenClaw `tools.media.audio` provider
query/options. Supported primitive query fields:

- `languages`: comma-separated language hints, for example `fr,en`
- `code_switching`: boolean
- `diarization`: boolean
- `sentences`: boolean
- `punctuation_enhanced`: boolean
- `poll_interval_ms`: polling interval, default `3000`

## Development

```bash
npm install
npm test
npm run pack:check
```

This package is intentionally small: the runtime entry registers one OpenClaw
media-understanding provider named `gladia`, and the provider implementation
contains the Gladia v2 upload/job/polling flow.

## Publishing Notes

Before publishing:

- confirm the package name and npm ownership;
- add repository metadata to `package.json` once the GitHub URL exists;
- publish to npm;
- register the plugin in the OpenClaw plugin catalog or ClawHub flow with the
  manifest id `gladia`.
