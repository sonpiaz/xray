# XRay v1.0 launch demo — VHS tape
# Render with: vhs docs/demo.tape  →  produces docs/demo.gif
#
# Why VHS over asciinema: deterministic typing speed + native GIF output,
# no manual playback recording. Charm.sh hosts pre-built binaries:
#   brew install vhs   (or:  go install github.com/charmbracelet/vhs@latest)
#
# Cast variant lives at docs/demo.sh for users who prefer asciinema.
# Plain-text walkthrough lives at docs/DEMO.md for offline / no-tooling viewing.

Output docs/demo.gif

Set FontSize 14
Set Width 1200
Set Height 720
Set Theme "Catppuccin Mocha"
Set Padding 20
Set TypingSpeed 50ms

# Scene 1 — version sanity check (2s)
Type "xray --version"
Sleep 500ms
Enter
Sleep 1s

# Scene 2 — research a hot thread end-to-end (cookie tier, silent)  (~10s)
Type "# 1. Research a thread end-to-end (cookie tier, no login prompt)"
Enter
Type "xray thread https://x.com/karpathy/status/1234567890"
Sleep 500ms
Enter
Sleep 8s

# Scene 3 — add video understanding to the thread (~12s)
Type "# 2. Same thread, now with embedded video transcript + key moments"
Enter
Type "xray thread https://x.com/AnatoliKopadze/status/2056362875195686927 --video"
Sleep 500ms
Enter
Sleep 12s

# Scene 4 — semantic search across cached threads (~4s)
Type "# 3. Semantic search across everything you've ever researched (zero API cost)"
Enter
Type 'xray search "claude code prompts"'
Sleep 500ms
Enter
Sleep 4s

# Scene 5 — profile aggregation from cache  (~4s)
Type "# 4. Topic + stance + expertise profile from the cache"
Enter
Type "xray profile @karpathy"
Sleep 500ms
Enter
Sleep 4s

# Outro
Sleep 1s
