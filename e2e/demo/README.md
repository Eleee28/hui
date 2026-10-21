# Demo videos

`record.ts` records HUI's demo clips and the overview from this checkout:

```sh
node e2e/demo/record.ts                 # every clip, then overview.mp4
node e2e/demo/record.ts kanban bots     # only these clips, and their overview
node e2e/demo/record.ts --out ~/Movies/hui-demo
node e2e/demo/record.ts bots --keep     # keep frames, logs and the demo HUI's folders
node e2e/demo/record.ts --voice mlx-audio/af_heart --music ~/Music/bed.mp3 --accept-vscode-license   # all, narrated
```

Filming a release's video is a procedure of its own:
[hui-release-video](../../.agents/skills/hui-release-video/SKILL.md).

Needs ffmpeg with libx264 and a Chromium-family browser (the same one the agent
browser tool finds). Output goes to `$TMPDIR/hui-demo-videos` unless `--out`
says otherwise: one 3840×2160, 30 fps MP4 per clip (the 1920×1080 stage drawn
at 2×, so text stays sharp) and, when two or more clips were recorded,
`overview.mp4`: the clips crossfaded, for sharing outside GitHub. On GitHub each
feature gets its own player instead. GitHub takes videos up to 100 MB on paid
plans and 10 MB on free ones. Clips open straight
on the app with a chapter tag and a caption per step; there are no title slides.
Videos never go into Git.

- The `workpane` clip opens VS Code through Microsoft's `code serve-web`, which
  HUI runs only after the VS Code Server license was accepted:
  `--accept-vscode-license` accepts it for the demo HUI. Its server download
  (about 220 MB) is kept in `<out>/.cache`.
- The `phone` clip shows HUI at 390×844 in a phone frame, with touch input and
  `pointer: coarse` / `hover: none`, as a phone browser over Tailscale would.
- Demo terminals run a plain zsh with a short prompt, not your own shell setup.

## Narration and music

`--voice <model>/<voice>` narrates each clip through
[VoiceStudio](https://github.com/debpalash/VoiceStudio)'s OpenAI-style
`/v1/audio/speech`, at `VOICESTUDIO_URL` (default `http://127.0.0.1:3900`).
`mlx-audio/af_heart` is Kokoro 82M (Apache-2.0) on Apple Silicon, a warm female
voice; VoiceStudio's default OmniVoice weights are non-commercial. The lines are
each scene's `narration`; `director.say(key)` starts one once the previous line
ends, so the clip waits for the narrator. Lines are synthesized before
recording and cached in `<out>/.voice`. Names read letter by letter are spaced ("H U I", "V S Code"); check new ones by
transcribing the clip.

`--music <file>` lays any audio file under the voice, about 15 LU quieter and
ducked while she speaks; the overview gets one continuous bed. Use a track
whose license allows it in videos (the published videos use Mixkit's
"Atoms in Peace" by Alejandro Magaña, under the Mixkit Stock Music Free
License), and keep it out of Git.

## How it works

- Each clip launches a fresh `e2e/visual-verification.mjs launch --demo`: real
  HUI, Pi Durable and tools, isolated state, the fake GitHub and Datadog CLIs, and
  a scripted model (`provider.ts`) instead of a real one. `seed.ts` creates the
  demo world: small Git repositories under `/tmp/acme-*`, sessions across Kanban
  stages, backlog tasks, GitHub pull requests and Acme's Datadog org.
- The Rich chat clip's Datadog card needs a graph: before recording, its scene
  draws one on the stage (Chrome renders the SVG) and uploads it to the scripted
  model's server, which serves it as the fake pup's snapshot.
- Headless Chrome opens `stage.html` (served by the verification server at
  `/__demo/stage`, so HUI's widgets accept their ancestors) with HUI in an
  iframe, and `record.ts` drives it with real mouse and keyboard input through
  CDP while a synthetic cursor, captions and camera zoom are drawn on the stage.
  Screencast frames are encoded with ffmpeg.
- `scenes.ts` holds the clips. A scene's prompts must match a script's `when`
  in `provider.ts`; scripts run tools for real, so file paths and commands must
  work in the seeded repositories.

## Changing a clip

Edit the scene and its script, then record only that clip. A failed step saves
`<scene>-failed.png` in the output directory; `HUI_DEMO_DEBUG=1` logs each wait
and slow CDP call. Waits synchronize on visible text or elements; `pause` is
pacing for the viewer and `cut` skips a wait the viewer should not sit through.
`node --test e2e/demo/provider.test.ts` checks the scripted model.
