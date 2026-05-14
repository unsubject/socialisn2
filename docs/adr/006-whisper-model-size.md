# ADR-006: Whisper model size for Cantonese transcription

- **Status:** accepted (provisional — benchmark pending audio sample)
- **Date:** 2026-05-14
- **Resolves:** SPEC §19 Open Q4

## Context

SPEC §6.7 + §13 + §14 use transcribed Cantonese audio in two places:

1. **Backfill (SPEC §13):** Simon's own YouTube channel (`@leesimon`) — last 12 months of video, transcribed once at cold-start to seed positive labels for the feedback loop.
2. **Ongoing competitor scoring (SPEC §6.7):** ~10 priority competitor videos per scoring run (twice daily), transcribed locally to extract a 1-paragraph summary that feeds the clustering stage.

The transcription runs on the Hostinger VPS (srv1565522, 8 vCPU, no GPU). Cantonese is the hard language: low-resource compared to Mandarin, model size has a larger effect on accuracy than for English. The Whisper family in 2026:

| Variant | Params | Approx CPU speed (factor of audio) | Cantonese WER (published) |
|---|---|---|---|
| `tiny` / `base` | ≤74M | 20-40× faster | unusable for Cantonese |
| `small` | 244M | ~6× faster | usable for clean studio audio only |
| `medium` | 769M | ~2× faster | works, but mistakes on slang / mixed-code |
| `large-v3` | 1.55B | ~1× (real-time) | best, but heavy on 8 vCPU |
| `distil-large-v3` | 756M | ~3× faster | within 1-2 WER of large-v3 for most languages; **Cantonese coverage not yet validated by distil-whisper authors** |

The cost-budget line for transcription is $0.00/day (SPEC §12) — CPU time on the VPS, not API tokens. The constraint is therefore wall-clock per video, not dollars.

A normal scoring run targets ~10 videos. Average length: 15 min. With `large-v3` on `faster-whisper` (CTranslate2 backend), 8-thread CPU: ~5 min wall-clock per 15-min video → ~50 min per run. Acceptable for a twice-daily background job.

## Decision

Use **`large-v3`** via `faster-whisper` (CTranslate2 INT8) with `language='zh'` + a Cantonese-leaning initial prompt.

Provisional pending the audio-sample benchmark scheduled for Phase 6 (transcription PR). The decision will be re-affirmed or revised after measuring real WER against a hand-curated set of 5 competitor videos and 5 of Simon's own.

## Rationale

Alternatives considered:

- **`medium`** — meaningful WER regression on slang and English-mixed Cantonese; not worth the ~2× speed gain because the job is async (Stage 1 of scoring; not on the request path).
- **`distil-large-v3`** — promising on paper (3× faster, near-large-v3 accuracy) but distil-whisper's published benchmarks emphasise English / European languages. Cantonese validation hasn't been published. Re-evaluate in Phase 6.
- **`whisper-large-v2`** — superseded by v3 on virtually every benchmark including Cantonese.
- **External APIs** (Deepgram, AssemblyAI) — non-zero $/min cost would break the SPEC §12 budget once the backfill (~100 hours of Simon's own video) runs.

`faster-whisper` over the OpenAI reference implementation: CTranslate2 INT8 cuts memory by ~4× and CPU latency by ~2-3× with no observable accuracy loss for Whisper-large.

## Consequences

- Transcription wall-clock per scoring run: ~50 min on the VPS. Schedule the transcription queue to run between 02:00 and 04:00 ET so it completes before the 05:00 ET morning run.
- VPS RAM headroom: `large-v3` INT8 is ~3 GB resident. srv1565522 has 8 GB, of which Postgres + Redis + ingestion already consume ~3 GB. Leaves ~2 GB for Whisper + OS — tight but workable. Snapshot the VPS before Phase 6 deployment.
- Backfill cold-start cost (one-time): ~50 hours of CPU. Run overnight; SPEC §13 already budgets $5-10 for the LLM portion of backfill, separate from transcription.
- Re-eval planned at Phase 6 PR 1 (transcription pipeline). If `distil-large-v3` validates on the audio sample with <1.5 WER delta vs `large-v3`, we'll switch — cuts run time roughly 3× and frees the off-peak window for other batch work.

## References

- SPEC §6.7 (competitor channels), §13 (backfill), §19 Q4
- `faster-whisper`: https://github.com/SYSTRAN/faster-whisper
- distil-whisper benchmarks: https://github.com/huggingface/distil-whisper
