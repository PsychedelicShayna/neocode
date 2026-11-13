# Dictation cleanup

Checks the shipped cleanup prompt and NeoPi text generation path on synthetic transcripts. No microphone or audio service is used. Run from `evals/` with a configured native inference model:

```sh
node --env-file-if-exists=../.env voice-cleanup/run.ts --model <model> --out runs/voice
node --env-file-if-exists=../.env voice-cleanup/run.ts --model <model> --out runs/voice-new --baseline runs/voice/results.json
```

Use `--case <id> --samples 1` for a smoke run. By default the three cases run three times each (nine short model calls). Read `review.json` against each rubric before opening the answer key. Allow cosmetic punctuation differences; do not accept changed meaning or existing draft text copied into the result. Add cases to `cases.ts` when an actual cleanup failure exposes a missing behavior.

`--binary` selects the native executable (default `npi`); `--profile` selects its `OMP_PROFILE`. Inference uses that profile's credentials and may incur charges. Each run owns an isolated server configuration and attachment store.
