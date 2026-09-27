---
name: write-life-script
description: Transform transcripts, articles, film recaps, public-figure profiles, case files, or rough ideas into complete Chinese second-person “人生副本” narration scripts. Use when the user asks for “给我稿子”, “写人生剧本”, “改编文案”, a film/person/case narration, or needs a voiceover-ready story with an adaptation plan, duration estimate, fact checks, originality checks, and QA files.
---

# Write Life Script

Create a complete Chinese narration package from source material. Preserve the source file, rebuild the story around causality, and deliver a script that can directly enter TTS and storyboard production.

## Required reading

Read [references/workflow.md](references/workflow.md) before drafting. Read [references/output-templates.md](references/output-templates.md) before creating deliverables.

## Workflow

1. Locate and read the entire source. Record its path and SHA256. Never modify it.
2. Classify the source:
   - Fiction or film recap: preserve plot facts; no web research unless the work or version is unclear.
   - Real person, history, finance, technology, sport, law, medicine, or current events: verify material claims with primary or authoritative sources. Browse when facts may have changed or confidence is below 90%.
   - Rough idea: design an original causal story and label invented elements as fiction.
3. Extract the story engine: protagonist, desire, fear, false protective strategy, escalating cost, irreversible choice, revelation, final action, and lasting consequence.
4. Build the causal spine before writing. Merge lines that belong to one scene. Do not create a new scene merely because the source has a new sentence.
5. Draft in second person using the exact opening `今天你要体验的人生副本是：` unless the user explicitly requests another format.
6. Preserve the premise in the hook but do not reveal the complete ending, final culprit, or thematic answer.
7. Write events, choices, consequences, and reversals. Remove account introductions, calls to like or subscribe, comment prompts, repetitive summary, and unsupported moralizing.
8. Use Chinese number expressions suitable for TTS. Keep verified direct quotations only when the wording matters and a source exists; otherwise paraphrase.
9. Create the three required deliverables from the templates:
   - `改编规划.md`
   - `人生副本_<标题>_完整稿.txt`
   - `质量检查.md`
10. Run `scripts/analyze_script.py` against the source and final script. Fix hard failures before delivery.
11. Report the title, estimated duration, and absolute links to all three files and their directory.

## Hard quality gates

- Start with the fixed opening.
- Keep the protagonist perspective consistently in second person.
- Establish conflict in the first paragraph without disclosing the full resolution.
- Make each major section follow `because -> choice -> consequence`, not a list of events.
- Remove marketing phrases and audience engagement prompts.
- Do not invent public quotes, private motives, medical claims, financial results, or current achievements.
- Do not preserve humiliating, discriminatory, body-shaming, or dehumanizing framing merely because it exists in the source.
- After removing punctuation and whitespace, avoid exact source reuse of 8 or more consecutive characters, except unavoidable proper nouns or fixed official titles. Rewrite detected passages.
- Keep the original source unchanged and include source/output SHA256 values in QA.
- Do not pad a short story to hit a duration. Prefer a complete 7-minute story over a repetitive 10-minute script.

## Timing

Use the calibrated MiniMax narration speed of `4.472 spoken characters/second` unless the user provides a newer measured rate.

```text
estimated_seconds = spoken_characters / 4.472
```

Treat the result as an estimate. Add a practical range in QA for emotional pauses and performance variation.

## Validation command

```powershell
python scripts/analyze_script.py `
  --source "<source.txt>" `
  --output "<final-script.txt>" `
  --json "<analysis.json>" `
  --strict
```

If proper nouns cause the only 8-character overlap, record the exception explicitly instead of distorting names.

## Downstream preferences

When the user continues into production, preserve these defaults unless overridden:

- Plan approximate visual count and scene reuse in `改编规划.md`.
- Generate SRT by semantic phrasing, normally no more than 20 Chinese characters per cue.
- Remove sentence-ending punctuation from subtitle text without damaging decimals, times, names, or numeric meaning.
- Deliver narration audio, clean video, and timed subtitles as separate files. Do not burn subtitles into video.
